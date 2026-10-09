# W0a UI and Docs Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the fifteen small, decision-free findings of the manual acceptance pass that the roadmap groups as wave W0a (UI polish, one storage-API hardening, the `.env`-loss guard and two README facts) without touching data lifetime, billing arithmetic or containers.

**Architecture:** Ten independent tasks on one branch (`w0a-quick-wins`), executed in order, one fresh implementer per task, one Opus review per task. Most are frontend (React 19, react-router 7, TanStack Query, ECharts, vitest); Tasks 3 and 8 also change the API (FastAPI, pydantic, SQLAlchemy async); Task 9 is shell and PowerShell scripts plus README; Task 10 is README only. Nothing here adds a migration, a dependency or a route.

**Tech Stack:** TypeScript/React in `frontend/` (tests: `npx vitest run`, `npm run typecheck`), Python 3.12 in `backend/` (tests: `uv run pytest`, which starts a TimescaleDB testcontainer, so Docker must be running), bash and PowerShell in `scripts/`.

**Spec:** `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md` (sections 2, 6, 8, 10). Source of every item: `docs/superpowers/plans/2026-10-09-acceptance-findings-roadmap.md` section "W0a" and `docs/superpowers/manual-test-notes.md` (finding ids `S<section>-<n>`, backlog ids `BL:<line>` in `docs/superpowers/backlog.md`). Executors read the finding text in the notes file for the task they own.

**Review status:** this plan has NOT yet been logic-reviewed by Opus (that happens before any implementer starts; the review file is named at the end of this document).

## Global Constraints

Every task's requirements include this section.

- **Nothing Windows-specific** in application code (spec section 2). The `.ps1` scripts are Windows twins of the shell scripts and mirror them line for line; they are parse-checked here and run for real only in wave W2 (S12-14).
- **Roles are enforced by the API** (spec section 8): viewer < operator < admin. A `RequireRole` in the UI is a convenience so a direct visit shows a notice instead of an API error; it never replaces the API check.
- **Site timezone** is the zone of every shown day and time (spec 6 "Time" and 10). The zone must have a whole-hour UTC offset in January and July; the API already refuses others.
- **Storage factory values** are exactly raw retention 30 days, compression after 7 days, 1-minute rollup retention 730 days, disk capacity 100 GB, warning at 80 % (owner decision 2026-10-09). The S9-5 recommendations (365 days / 70 %) are NOT adopted.
- **No new dependency** (npm or uv) and no new database migration in this wave. The `0002` and `0004` migration seeds stay as history.
- **UI style:** the app is plain black on white (`frontend/src/app.css`); errors use `#b00`; muted text uses the existing `.muted` class. Do not introduce a colour, a font or a component library.
- **Safety rules for anything that runs Docker:** never run a compose command that changes anything without `COMPOSE_PROJECT_NAME` (or `-p`) set to a throwaway name starting with `dcdash_e2e`; never touch the volume `dcdash_dbdata`; never remove images by id (this engine uses the containerd store); never `git push --force`. Script tests in this wave use a fake `docker` program and never start a container. Backend tests use testcontainers (their own database).
- **Scope rule:** change only what the task names. A defect you notice elsewhere goes into your report, not into the diff.
- **Commit rule:** one commit per task, `git add` of the named files only (never `git add -A`), then `git push -u origin w0a-quick-wins`. The commit message ends with these two lines, after a blank line:

```
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa
```

- **Test commands:** frontend: `cd frontend && npx vitest run <file>` and `cd frontend && npm run typecheck`; backend: `cd backend && uv run pytest <file> -q`. A task is done only when its own tests, `npm run typecheck` (frontend tasks) and the neighbouring test files named in the task pass.

## Review Focus

The inputs and conditions the findings imply but the roadmap rows do not spell out, most likely to bite first. Each has a test in the task named in brackets.

1. **Two assets with one name** (same parent, or different parents) in every asset list: a person must be able to tell them apart, including two siblings that share both name and path. [Task 2]
2. **A metric sampled slower than the chart's bucket grid** (energy every 60 s on the 1-hour range), **a single point**, and **a real outage** in such a series: the line is drawn, the lone point gets a dot, the outage still breaks the line. [Task 4]
3. **`PUT /api/settings/storage` with `{}`, with one field missing, with one field `null`, and with `Infinity` as the capacity**: 422 every time, and the stored values and the Timescale policies are untouched. [Task 8]
4. **`scripts/setup.sh` with no `.env` while the project's database volume exists**, with Docker unreachable, and with a scratch project name: refuses before writing anything, fails closed, asks Docker about the right project. With `.env` present it must not interfere. [Task 9]
5. **Deleting a widget in the dashboard editor and then Undo, then Add**: the widget returns where it was; adding a widget first retires the Undo offer; deleting the only widget works. [Task 6]

Also pinned in their tasks: an unknown URL for every role and a viewer on `/sources` (Task 1); a site zone that has not loaded yet on the Metrics table (Task 7).

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `frontend/src/App.tsx`, `pages/NotFoundPage.tsx` (new), `components/Layout.tsx`, `app.css` | routes, role guards, not-found page, skip link, current-page style, wide pages | 1 |
| `frontend/src/components/dashboard/AssetPicker.tsx` | the one place that labels assets (`pickerRows`, `assetLabels`, new `assetOptions`) | 2 |
| `frontend/src/components/MappingForm.tsx`, `AssetForm.tsx`, `pages/SourcePointsPage.tsx`, `components/graph/ReviewDialog.tsx` | use those labels | 2 |
| `backend/dcdash/api/tariffs.py`, `frontend/src/api/types.ts`, `pages/TariffsPage.tsx` | `asset_path` on a tariff, rate input step | 3 |
| `frontend/src/components/TrendChart.tsx`, `components/dashboard/widgets/TimeSeriesWidget.tsx` (type widening only), `pages/AssetPage.tsx` | trend chart gap rules, live label | 4 |
| `frontend/src/components/dashboard/widgets/GaugeWidget.tsx` | gauge name below the value | 5 |
| `frontend/src/components/dashboard/DashboardEditor.tsx` | Undo after deleting a widget | 6 |
| `frontend/src/lib/siteTime.ts`, `components/MetricsTable.tsx`, `pages/ScansPage.tsx`, `pages/SourcesPage.tsx`, `pages/SettingsPage.tsx` | times in the site zone, honest timezone hint | 7 |
| `backend/dcdash/core/storage.py`, `backend/dcdash/api/storage.py`, `frontend/src/api/types.ts`, `api/queries.ts`, `pages/StoragePage.tsx` | storage settings contract | 8 |
| `scripts/setup.sh`, `scripts/setup.ps1`, `scripts/backup.sh`, `scripts/backup.ps1`, `backend/tests/test_scripts_setup.py` (new), `README.md` | `.env` loss guard, backup note, recovery steps | 9 |
| `README.md` | dev simulator secret, `collector_networks` after a restore | 10 |

---

### Task 1: Navigation, route guards, not-found page, wide pages (S13-4, S13-5, S13-6, S7-2)

**Files:**
- Modify: `frontend/src/App.tsx`
- Create: `frontend/src/pages/NotFoundPage.tsx`
- Modify: `frontend/src/components/Layout.tsx`
- Modify: `frontend/src/app.css`
- Test: `frontend/src/App.test.tsx`, `frontend/src/components/Layout.test.tsx`, `frontend/src/app.css.test.ts`

**Interfaces:**
- Consumes: `RequireRole({ min, children })` from `auth/RequireAuth.tsx` (renders "Operators only" for `min="operator"` and "Admins only" for `min="admin"`); `useLocation` from react-router.
- Produces: `NotFoundPage()` (no props); a `<main id="main" tabIndex={-1}>` that carries the class `wide` on `/billing` and `/dashboards/<id>`; a skip link `<a class="skip-link" href="#main">Skip to content</a>` as the first element of `Layout`. Later tasks do not depend on these.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/App.test.tsx` add two routes to the `routes()` object (the points page needs the sources list and the points) and the new tests inside `describe("App routes", ...)`:

```tsx
  "GET /api/sources": { body: [] },
  "GET /api/sources/4/points": { body: [] },
```

```tsx
  it("keeps Sources away from a viewer", async () => {
    const calls = visit("viewer", "/sources");
    expect(await screen.findByText("Operators only")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/sources")).toBe(false);
  });

  it("opens Sources for an operator", async () => {
    visit("operator", "/sources");
    expect(await screen.findByRole("heading", { name: "Sources" })).toBeInTheDocument();
  });

  it.each(["viewer", "operator"])("keeps the source points page away from a %s", async (role) => {
    const calls = visit(role, "/sources/4/points");
    expect(await screen.findByText("Admins only")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/sources/4/points")).toBe(false);
  });

  it("opens the source points page for an admin", async () => {
    visit("admin", "/sources/4/points");
    expect(await screen.findByRole("heading", { name: "Points" })).toBeInTheDocument();
  });

  it.each(["viewer", "operator", "admin"])("answers an unknown address with a page, inside the layout, for a %s", async (role) => {
    visit(role, "/nope");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Assets" })).toBeInTheDocument(); // the nav is still there
  });
```

In `frontend/src/components/Layout.test.tsx` (add `import userEvent from "@testing-library/user-event";` at the top) add:

```tsx
describe("Layout skip link and page width", () => {
  it("starts with a skip link that moves focus to the main area", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    const first = (await screen.findAllByRole("link"))[0];
    expect(first).toHaveAccessibleName("Skip to content");
    await userEvent.click(first);
    expect(screen.getByRole("main")).toHaveFocus();
  });

  it.each([
    ["/billing", true],
    ["/dashboards/3", true],
    ["/dashboards", false],
    ["/assets", false],
    ["/sources/4/points", false],
  ])("gives %s the whole window: %s", async (route, wide) => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route, path: "*" });
    const main = await screen.findByRole("main");
    expect(main.classList.contains("wide")).toBe(wide);
  });
});
```

In `frontend/src/app.css.test.ts` append:

```ts
describe("navigation and page width", () => {
  it("styles the current page link (nothing marked it visibly before)", () => {
    expect(css).toMatch(/nav a\[aria-current="page"\]\s*\{[^}]*font-weight:\s*700/);
  });
  it("hides the skip link until it has focus", () => {
    expect(css).toMatch(/\.skip-link\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.skip-link:focus\s*\{/);
  });
  it("lets the wide pages use the whole window", () => {
    expect(css).toMatch(/main\.wide\s*\{[^}]*max-width:\s*none/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/App.test.tsx src/components/Layout.test.tsx src/app.css.test.ts`
Expected: FAIL (no "Operators only" on `/sources`, no "Page not found", no skip link, no `wide` class, CSS patterns missing).

- [ ] **Step 3: Implement**

Create `frontend/src/pages/NotFoundPage.tsx`:

```tsx
import { Link } from "react-router";

/** What an unknown address shows: a page inside the layout, so the nav stays and there is a way back. */
export function NotFoundPage() {
  return (
    <section>
      <h1>Page not found</h1>
      <p className="muted">There is nothing at this address. <Link to="/assets">Back to Assets</Link></p>
    </section>
  );
}
```

In `frontend/src/App.tsx` import it (`import { NotFoundPage } from "./pages/NotFoundPage";`, alphabetical among the page imports), then change the two source routes and add the catch-all as the LAST child of the layout route:

```tsx
        <Route path="/sources" element={<RequireRole min="operator"><SourcesPage /></RequireRole>} />
        <Route path="/sources/:id/points" element={<RequireRole min="admin"><SourcePointsPage /></RequireRole>} />
```

```tsx
        <Route path="/password" element={<PasswordPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
```

In `frontend/src/components/Layout.tsx` use `useLocation`, add the skip link before `<nav>`, and give `main` its id, focusability and the `wide` class:

```tsx
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";

// Billing's day columns and a dashboard on a wall screen use the whole window; every other page keeps the 1200 px column.
const WIDE = /^\/(billing|dashboards\/[^/]+)\/?$/;

export function Layout() {
  const { user, hasRole, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <>
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault(); // a hash in the URL would be one more history entry
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      <nav>
```

(keep the existing `<nav>` children unchanged) and replace the `<main>` element:

```tsx
      <main id="main" tabIndex={-1} className={WIDE.test(pathname) ? "wide" : undefined}>
        <Outlet />
      </main>
```

In `frontend/src/app.css`, directly after the `main { ... }` rule on line 6 add:

```css
main.wide { max-width: none; }
main:focus { outline: none; }
nav a[aria-current="page"] { font-weight: 700; text-decoration: none; border-bottom: 2px solid #000; }
.skip-link { position: absolute; left: -9999px; top: 0; }
.skip-link:focus { left: 8px; top: 8px; z-index: 2000; padding: 4px 8px; background: #fff; border: 1px solid #000; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/App.test.tsx src/components/Layout.test.tsx src/app.css.test.ts src/pages/SourcesPage.test.tsx src/pages/SourcePointsPage.test.tsx && npm run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/pages/NotFoundPage.tsx frontend/src/components/Layout.tsx frontend/src/app.css frontend/src/App.test.tsx frontend/src/components/Layout.test.tsx frontend/src/app.css.test.ts
git commit -m "fix(ui): Sources and the points page are role-guarded, unknown addresses get a page, the nav marks the current page, a skip link, dashboards and Billing use the whole window"
git push -u origin w0a-quick-wins
```
(append the two trailer lines from Global Constraints to the message)

---

### Task 2: Asset labels in every asset list (S4-3 labels, BL:56, BL:86)

**Files:**
- Modify: `frontend/src/components/dashboard/AssetPicker.tsx`
- Modify: `frontend/src/components/MappingForm.tsx`, `frontend/src/components/AssetForm.tsx`
- Modify: `frontend/src/pages/SourcePointsPage.tsx`
- Modify: `frontend/src/components/graph/ReviewDialog.tsx`
- Test: `frontend/src/components/dashboard/AssetPicker.test.tsx`, `frontend/src/pages/SourcePointsPage.test.tsx`, `frontend/src/pages/AssetsPage.test.tsx`, `frontend/src/components/graph/ReviewDialog.test.tsx`

**Interfaces:**
- Consumes: `buildTree`, `Asset` (`{ id, parent_id, name, kind, sort_order }`).
- Produces (all exported from `components/dashboard/AssetPicker.tsx`; Task 3 uses `assetLabels` unchanged):
  - `PickerRow` gains `label: string` (the final, unique label).
  - `pickerRows(assets, tree?) : PickerRow[]` unchanged signature; every row now carries `label`.
  - `pickerLabel(row: PickerRow): string` returns `row.label`.
  - `assetLabels(assets: Asset[]): Map<number, string>` unchanged signature, built from `row.label`.
  - `assetOptions(assets: Asset[], exclude?: ReadonlySet<number>): { id: number; text: string }[]` new: tree order, each text is `"  ".repeat(depth) + label`; paths come from the whole `assets` list even when some ids are excluded.

The finding (S4-3): with two `LV_Panel_01` in two rooms, the mapping dialog and the Assets Parent list showed both as `LV_Panel_01`, so a point could be mapped to the wrong one. The Tariffs and dashboard pickers were fixed earlier; `pickerLabel` still lacks the `#id` that `assetLabels` adds for two siblings with one name (BL:86).

- [ ] **Step 1: Write the failing tests**

In `AssetPicker.test.tsx` add (add `assetOptions` to the file's import from `./AssetPicker`):

```tsx
const asset = (id: number, name: string, parent_id: number | null = null, sort_order = 0) => ({ id, parent_id, name, kind: "x", sort_order });

describe("labels that tell equal names apart", () => {
  const tree = [asset(1, "Room"), asset(2, "Other room"), asset(3, "Meter", 1), asset(4, "Meter", 1), asset(5, "Panel", 1), asset(6, "Panel", 2)];

  it("adds the parent path for a shared name and the id for two siblings that share both", () => {
    const labels = assetLabels(tree);
    expect(labels.get(3)).toBe("Meter (Room) #3");
    expect(labels.get(4)).toBe("Meter (Room) #4");
    expect(labels.get(5)).toBe("Panel (Room)");
    expect(labels.get(6)).toBe("Panel (Other room)");
    expect(labels.get(1)).toBe("Room");
  });

  it("the dashboard picker shows the same labels (BL:86)", () => {
    render(<AssetPicker assets={tree} selected={[]} onChange={() => {}} single={false} max={5} />);
    expect(screen.getByLabelText("Meter (Room) #3")).toBeInTheDocument();
    expect(screen.getByLabelText("Meter (Room) #4")).toBeInTheDocument();
  });

  it("assetOptions lists the tree in order, indented, with those labels, and drops the excluded ids", () => {
    // Roots come in code-point name order ("Other room" before "Room"). With 5 excluded, the remaining "Panel" is no longer a
    // shared name among the offered rows, so it needs no path: the invariant is that no two offered options read alike.
    const options = assetOptions(tree, new Set([5]));
    expect(options.map((o) => o.text.replace(/ /g, "_"))).toEqual([
      "Other room", "__Panel", "Room", "__Meter (Room) #3", "__Meter (Room) #4",
    ]);
    expect(options.some((o) => o.id === 5)).toBe(false);
  });
});
```

In `SourcePointsPage.test.tsx` add a test that opens the Map form with two assets both named `LV Panel` under different rooms (mock `GET /api/assets`), and asserts the Asset `<select>`'s option texts (NBSP removed, trimmed) include `LV Panel (Room 1)` and `LV Panel (Room 2)`; and that a mapped row's "Mapped to" cell shows the same label. In `AssetsPage.test.tsx` add the equivalent for the Add asset form's Parent select. In `ReviewDialog.test.tsx` copy the nearest test that opens the dialog onto an existing asset, give the graph model two assets with one name under different parents, and assert both options carry the path in their text.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/dashboard/AssetPicker.test.tsx src/pages/SourcePointsPage.test.tsx src/pages/AssetsPage.test.tsx src/components/graph/ReviewDialog.test.tsx`
Expected: FAIL (`assetOptions` is not exported; the dialogs show bare names).

- [ ] **Step 3: Implement**

In `AssetPicker.tsx` replace `PickerRow`, `pickerRows`, `pickerLabel` and `assetLabels` (lines 5 to 43) with:

```tsx
export interface PickerRow { id: number; name: string; depth: number; parentPath: string; duplicate: boolean; label: string }

/**
 * Tree order (parents first) with each asset's depth and its parent's path; `duplicate` flags names used by more than one
 * asset and `label` is what to show: the name, plus the parent path when the name is shared, plus `#id` when two siblings
 * share both. When `assets` is only part of the tree (the ones that have a metric), pass the whole tree as `tree`: the parent
 * path then names the real ancestors even if they are not offered, and the indent counts only the ancestors that are.
 */
export function pickerRows(assets: Asset[], tree: Asset[] = assets): PickerRow[] {
  const offered = new Set(assets.map((a) => a.id));
  const rows: PickerRow[] = [];
  const walk = (nodes: TreeNode[], depth: number, parentPath: string) => {
    for (const node of nodes) {
      const shown = offered.has(node.id);
      if (shown) rows.push({ id: node.id, name: node.name, depth, parentPath, duplicate: false, label: node.name });
      walk(node.children, shown ? depth + 1 : depth, parentPath === "" ? node.name : `${parentPath} / ${node.name}`);
    }
  };
  walk(buildTree(tree), 0, "");
  const count = new Map<string, number>();
  for (const row of rows) count.set(row.name, (count.get(row.name) ?? 0) + 1);
  const named = rows.map((row) => ({ ...row, duplicate: (count.get(row.name) ?? 0) > 1 }));
  const base = named.map((row) => (row.duplicate ? `${row.name} (${row.parentPath || "top level"})` : row.name));
  const uses = new Map<string, number>();
  for (const label of base) uses.set(label, (uses.get(label) ?? 0) + 1);
  return named.map((row, i) => ({ ...row, label: (uses.get(base[i]) ?? 0) > 1 ? `${base[i]} #${row.id}` : base[i] }));
}

/** What names a row: its name, plus its parent path when more than one asset has that name, plus `#id` when that is still not enough. */
export function pickerLabel(row: PickerRow): string {
  return row.label;
}

/** One label per asset id, in tree order, that tells assets apart wherever a bare name would not. */
export function assetLabels(assets: Asset[]): Map<number, string> {
  return new Map(pickerRows(assets).map((row) => [row.id, row.label]));
}

/**
 * The options of a `<select>` of assets: tree order, indented by depth (non-breaking spaces, because a browser strips
 * ordinary leading spaces from an option), each labelled by `assetLabels`' rules. `exclude` leaves ids out (a form that
 * must not offer an asset's own descendants as its parent) while the paths still come from the whole list.
 */
export function assetOptions(assets: Asset[], exclude: ReadonlySet<number> = new Set()): { id: number; text: string }[] {
  const offered = assets.filter((a) => !exclude.has(a.id));
  return pickerRows(offered, assets).map((row) => ({ id: row.id, text: `${"  ".repeat(row.depth)}${row.label}` }));
}
```

In `MappingForm.tsx` import `assetOptions` (from `./dashboard/AssetPicker`) and replace the asset `<option>` line (line 36) with:

```tsx
          {assetOptions(assets).map((o) => <option key={o.id} value={o.id}>{o.text}</option>)}
```

In `AssetForm.tsx` import it and replace line 30 with:

```tsx
          {assetOptions(assets, excludeIds).map((o) => <option key={o.id} value={o.id}>{o.text}</option>)}
```

In `SourcePointsPage.tsx` add `useMemo` to the react import, import `assetLabels` from `../components/dashboard/AssetPicker`, and replace line 19 with:

```tsx
  const labels = useMemo(() => assetLabels(assets), [assets]);
  const assetName = (id: number) => labels.get(id) ?? `#${id}`;
```

In `ReviewDialog.tsx` the graph model's assets lack `sort_order`, which `assetLabels` needs only for ordering (labels do not depend on it). Import `assetLabels`, add next to `choices` (line 70):

```tsx
  const labels = useMemo(() => assetLabels(model.assets.map((a) => ({ ...a, sort_order: 0 }))), [model.assets]);
```

and in both `choices.map` option lines (existing asset select at line 169, parent select at line 181) show `indent(a.depth) + (labels.get(a.id) ?? a.name)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components src/pages/SourcePointsPage.test.tsx src/pages/AssetsPage.test.tsx src/pages/TariffsPage.test.tsx src/pages/DiscoveryPage.test.tsx && npm run typecheck`
Expected: all PASS (the Tariffs and Discovery pages use these helpers, so they are in the run).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/dashboard/AssetPicker.tsx frontend/src/components/dashboard/AssetPicker.test.tsx frontend/src/components/MappingForm.tsx frontend/src/components/AssetForm.tsx frontend/src/pages/SourcePointsPage.tsx frontend/src/pages/SourcePointsPage.test.tsx frontend/src/pages/AssetsPage.test.tsx frontend/src/components/graph/ReviewDialog.tsx frontend/src/components/graph/ReviewDialog.test.tsx
git commit -m "fix(ui): every asset list labels equal names by their parent path (and id), so a point cannot be mapped to the wrong panel"
git push
```
(append the trailers)

---

### Task 3: Tariff `asset_path` and the rate input step (BL:120, S5-1)

**Files:**
- Modify: `backend/dcdash/api/tariffs.py`
- Modify: `frontend/src/api/types.ts` (the `Tariff` interface, line 139)
- Modify: `frontend/src/pages/TariffsPage.tsx` (lines 101, 152, 205)
- Test: `backend/tests/test_api_tariffs.py`, `frontend/src/pages/TariffsPage.test.tsx` (and any frontend test file that builds a `Tariff` literal: the compiler lists them)

**Interfaces:**
- Consumes: `AssetTree.load(db)`, `AssetTree.nodes`, `AssetTree.path(id)` from `dcdash.core.tree`; `assetLabels` from Task 2.
- Produces: `TariffOut.asset_path: str | None` (path from the root, e.g. `"MV2 / Room 1 / Panel"`, `None` for the site default); frontend `Tariff.asset_path: string | null`.

- [ ] **Step 1: Write the failing tests**

Backend, in `test_api_tariffs.py` (uses `create`, `login_as`, `make_asset` already imported there):

```python
async def test_a_tariff_names_its_asset_by_path(client, db):
    await login_as(client, db)
    room = await make_asset(db, "Room 1")
    panel = await make_asset(db, "Panel", parent_id=room)
    created = await create(client, asset_id=panel, effective_from="2026-10-02")
    assert created["asset_name"] == "Panel" and created["asset_path"] == "Room 1 / Panel"
    site = await create(client, effective_from="2026-10-03")
    assert site["asset_path"] is None and site["asset_name"] is None
    listed = {t["id"]: t for t in (await client.get("/api/tariffs")).json()}
    assert listed[created["id"]]["asset_path"] == "Room 1 / Panel"
    assert listed[site["id"]]["asset_path"] is None
    patched = (await client.patch(f"/api/tariffs/{created['id']}", json={"rate_per_kwh": 0.2})).json()
    assert patched["asset_path"] == "Room 1 / Panel"
```

Frontend, in `TariffsPage.test.tsx`: one test that both rate inputs (the add form's and an edit row's `Rate per kWh`) have `step="0.01"`; one test that typing `0.123456` into the add form still submits `0.123456` (the form is `noValidate`; six decimals stay valid); and one test that a tariff whose asset is not in the asset list falls back to `asset_path` (render a tariff with `asset_id: 99`, `asset_name: "Panel"`, `asset_path: "Room 1 / Panel"` and no matching asset; expect the text `Room 1 / Panel`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_tariffs.py -q -k path` and `cd frontend && npx vitest run src/pages/TariffsPage.test.tsx`
Expected: FAIL (`KeyError: 'asset_path'`; `step` is `any`).

- [ ] **Step 3: Implement**

In `tariffs.py` import `AssetTree` (`from dcdash.core.tree import AssetTree`), add the field and thread it through:

```python
class TariffOut(BaseModel):
    id: int
    asset_id: int | None
    asset_name: str | None
    asset_path: str | None
    rate_per_kwh: float
    effective_from: date
    created_by: int | None
    created_at: datetime


def _out(tariff: Tariff, asset_name: str | None, asset_path: str | None) -> TariffOut:
    return TariffOut(
        id=tariff.id,
        asset_id=tariff.asset_id,
        asset_name=asset_name,
        asset_path=asset_path,
        rate_per_kwh=float(tariff.rate_per_kwh),
        effective_from=tariff.effective_from,
        created_by=tariff.created_by,
        created_at=tariff.created_at,
    )
```

Replace `_asset_name` (lines 122-123) by a helper that returns both, and update its callers:

```python
async def _asset_name_and_path(db: AsyncSession, asset_id: int | None) -> tuple[str | None, str | None]:
    """The asset's name and its path from the root, both None for the site default (or an asset that is gone)."""
    if asset_id is None:
        return None, None
    tree = await AssetTree.load(db)
    if asset_id not in tree.nodes:
        return None, None
    return tree.nodes[asset_id].name, tree.path(asset_id)
```

- `list_tariffs`: load the tree once (`tree = await AssetTree.load(db)`) and build each row with `_out(tariff, name, tree.path(tariff.asset_id) if tariff.asset_id in tree.nodes else None)`.
- `create_tariff`: keep the `db.get(Asset, ...)` existence check for the 404, then `asset_name, asset_path = await _asset_name_and_path(db, body.asset_id)` after the flush, and return `_out(tariff, asset_name, asset_path)`.
- `update_tariff`: `return _out(tariff, *await _asset_name_and_path(db, tariff.asset_id))`.

Run `grep -rn "_asset_name\b" backend` first: if another module imports `_asset_name`, keep a thin `_asset_name` wrapper instead of deleting it.

In `types.ts` add `asset_path: string | null;` to `Tariff` next to `asset_name`. In `TariffsPage.tsx` change both rate inputs to `step="0.01"` (lines 101 and 152; the line-152 input has `aria-label="Rate per kWh"`), and line 205 to `where={(t.asset_id !== null ? labels.get(t.asset_id) : undefined) ?? t.asset_path ?? t.asset_name}`. Do NOT change `step` on any other input (Mapping scale, disk capacity and gauge bounds stay `any`: those forms are not `noValidate`, so `0.001` must stay valid).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_api_tariffs.py -q` and `cd frontend && npx vitest run src/pages/TariffsPage.test.tsx && npm run typecheck`
Expected: all PASS. Fix every `Tariff` literal the compiler flags by adding `asset_path`.

- [ ] **Step 5: Commit**

```bash
git add backend/dcdash/api/tariffs.py backend/tests/test_api_tariffs.py frontend/src/api/types.ts frontend/src/pages/TariffsPage.tsx frontend/src/pages/TariffsPage.test.tsx
git commit -m "feat(api): a tariff carries its asset's path; fix(ui): the rate inputs step by cents"
git push
```
(add any other frontend test file you had to touch to `git add`; append the trailers)

---

### Task 4: Asset page: the Trend chart draws sparse series, no permanent "reconnecting…" (S4-6, BL:83, S4-8)

**Files:**
- Modify: `frontend/src/components/TrendChart.tsx`
- Modify: `frontend/src/components/dashboard/widgets/TimeSeriesWidget.tsx` (one type, see Step 3)
- Modify: `frontend/src/pages/AssetPage.tsx`
- Test: `frontend/src/components/TrendChart.test.tsx`, `frontend/src/pages/AssetPage.test.tsx`

**Interfaces:**
- Consumes: from `TimeSeriesWidget.tsx`: `bucketMs(bucket, points)` (median positive step between points, null when fewer than two) and `markIsolated(rows)` (a lone non-null row between nulls or at an end becomes `{ value: row, symbol: "circle", symbolSize: 6 }`).
- Produces: `withGaps(points, query, pick)` in `TrendChart.tsx` keeps its signature `(SeriesPoint[], Query, (p) => number) => [string, number | null][]`; only its gap width changes.

The finding (S4-6): on the 1-hour range the query has 12 s buckets, energy arrives every 60 s, so every point was "more than 1.5 buckets" from its neighbour, a gap row was inserted between all of them, every point stood alone, and a lone point is drawn as nothing (`symbol: "none"`): the chart was empty. The dashboard widgets fixed this with the median step and isolated-point dots; the older asset chart never got it.

- [ ] **Step 1: Write the failing tests**

In `TrendChart.test.tsx`, next to `describe("seriesToOption gaps")`:

```tsx
describe("seriesToOption on a grid finer than the data", () => {
  type Row = [string, number | null] | { value: [string, number | null]; symbol: string; symbolSize: number };
  const T0 = Date.parse("2026-10-07T10:00:00Z");
  // 1 hour in 300 buckets = a 12 s grid, as the 1h range asks for
  const query = { start: new Date(T0).toISOString(), end: new Date(T0 + 3_600_000).toISOString(), buckets: 300 };
  const at = (seconds: number) => ({ ts: new Date(T0 + seconds * 1000).toISOString(), avg: 5, min: 4, max: 6 });
  const avgOf = (points: ReturnType<typeof at>[]) => {
    const option = seriesToOption({ metric: "energy_kwh", unit: "kWh", points } as never, "1h", query) as unknown as { series: { name: string; data: Row[] }[] };
    return option.series.find((s) => s.name === "avg")!.data;
  };

  it("draws a series sampled every 60 s as one line, with no gap rows between its points", () => {
    const data = avgOf([0, 60, 120, 180, 240, 300].map(at));
    expect(data).toHaveLength(6);
    expect(data.every((row) => Array.isArray(row) && row[1] === 5)).toBe(true);
  });

  it("still breaks the line at a real outage in such a series", () => {
    const data = avgOf([0, 60, 120, 180, 240, 840, 900].map(at)); // ten minutes missing
    expect(data.map((row) => (Array.isArray(row) ? row[1] : row.value[1]))).toEqual([5, 5, 5, 5, 5, null, 5, 5]);
  });

  it("gives a lone point a dot, so a one-point range is not an empty chart", () => {
    const data = avgOf([at(0)]);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ symbol: "circle", symbolSize: 6 });
  });

  it("an axis label for a value that is not a finite number is empty, not a thrown RangeError", () => {
    const option = seriesToOption({ metric: "energy_kwh", unit: "kWh", points: [at(0), at(60)] } as never, "1h", query) as unknown as { xAxis: { axisLabel: { formatter: (v: number) => string } } };
    expect(option.xAxis.axisLabel.formatter(Number.NaN)).toBe("");
    expect(option.xAxis.axisLabel.formatter(T0)).not.toBe("");
  });
});
```

The existing test `inserts a null point when consecutive buckets are more than one width apart` uses only three points at offsets 0, 1 and 4 widths; with the median rule two steps tie and the upper median swallows the gap. Replace its points by `[point(0, width), point(1, width), point(2, width), point(3, width), point(6, width)]` and its expectations by `[1, 1, 1, 1, null, 1]` with the null row at `T0 + 4 * width`; keep the min and max assertions (the null is at index 4 of both). Say in your report that you changed this test and why: a gap is judged against the series' normal step, which needs more than one step to know.

In `AssetPage.test.tsx` add two tests using the file's existing mocks: an asset whose summary has no metrics shows neither "live" nor "reconnecting…" (`queryByText` both absent); an asset with a metric shows "reconnecting…" until the fake event source opens (follow the file's existing stream test for the helper).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/TrendChart.test.tsx src/pages/AssetPage.test.tsx`
Expected: FAIL (gap rows between 60 s points, no dot, thrown RangeError, "reconnecting…" always present).

- [ ] **Step 3: Implement**

In `TimeSeriesWidget.tsx` widen only the type of `bucketMs`'s second parameter so the trend chart's points fit (it reads nothing but `ts`): `points: readonly { ts: string }[]`. No behaviour change; its existing tests must still pass.

In `TrendChart.tsx` import `bucketMs` and `markIsolated` from `./dashboard/widgets/TimeSeriesWidget` and replace `withGaps`:

```tsx
/**
 * Build chart rows, inserting a `[ts, null]` row wherever two consecutive points are more than 1.5 steps apart.
 * time_bucket omits empty buckets, so without this the line would bridge outages. The step is the query's bucket
 * width, or the series' own median step when that is larger (a metric sampled every 60 s on a 12 s grid has steps of 60 s;
 * judged against 12 s every point would sit alone, which is how the 1h energy chart drew nothing), the way the dashboard
 * widgets read it.
 */
export function withGaps(points: SeriesPoint[], query: Query, pick: (p: SeriesPoint) => number): [string, number | null][] {
  const grid = (Date.parse(query.end) - Date.parse(query.start)) / query.buckets;
  const width = Math.max(Number.isFinite(grid) ? grid : 0, bucketMs(null, points) ?? 0);
  const rows: [string, number | null][] = [];
  let previous: number | null = null;
  for (const p of points) {
    const t = Date.parse(p.ts);
    if (previous !== null && width > 0 && t - previous > width * 1.5) rows.push([new Date(previous + width).toISOString(), null]);
    rows.push([p.ts, pick(p)]);
    previous = t;
  }
  return rows;
}
```

In `seriesToOption` wrap only the average line's data: `data: markIsolated(withGaps(series.points, query, (p) => p.avg))` (the min and max helper series stay as they are; if the compiler objects to the mixed row type, cast the returned option the way `TimeSeriesWidget.timeSeriesOption` does with `as EChartsOption`). Guard the axis label formatter: `formatter: (value: number) => (Number.isFinite(value) ? formatSiteTick(new Date(value).toISOString(), timezone, bucket) : "")`.

In `AssetPage.tsx` replace the live label (line 25) with:

```tsx
      <div className="row"><h1>{data.asset.name}</h1>{wanted.size > 0 && <span className="muted">{connected ? "live" : "reconnecting…"}</span>}</div>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components src/pages/AssetPage.test.tsx && npm run typecheck`
Expected: all PASS, including the widget tests (`widgets.test.tsx`, `timeSeries.ssr.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/TrendChart.tsx frontend/src/components/TrendChart.test.tsx frontend/src/components/dashboard/widgets/TimeSeriesWidget.tsx frontend/src/pages/AssetPage.tsx frontend/src/pages/AssetPage.test.tsx
git commit -m "fix(ui): the asset Trend chart draws a sparsely sampled metric (1h energy was empty), and an asset without points no longer says reconnecting"
git push
```
(append the trailers)

---

### Task 5: Gauge: the name sits below the value (S7-1)

**Files:**
- Modify: `frontend/src/components/dashboard/widgets/GaugeWidget.tsx`
- Create: `frontend/src/components/dashboard/widgets/gauge.ssr.test.ts`
- Test: `frontend/src/components/dashboard/widgets/widgets.test.tsx` (existing gauge tests must keep passing)

**Interfaces:**
- Consumes: `gaugeOption(args)` (exported, pure).
- Produces: the same `gaugeOption` signature; its gauge series gets a `title` block.

The finding (S7-1): the series `data` carries `name` (the asset name) but only the value `detail` is positioned (`offsetCenter [0, "70%"]`); the title keeps ECharts' default (centre, 20 %), so the name is drawn over the needle's pivot and the scale numbers, also when the widget is enlarged. This pattern exists: `timeSeries.ssr.test.ts` renders an option with the real ECharts to an SVG string without a DOM and looks at what was drawn. Do the same here.

- [ ] **Step 1: Write the failing test**

Create `gauge.ssr.test.ts`. First print one rendered SVG (`console.log(svg)` while writing the test, remove it before committing) to learn how this ECharts version writes `<text>` elements, then adapt the parser if its attributes differ from the sketch:

```ts
// @vitest-environment node
// Real ECharts, no DOM: the gauge is rendered to an SVG string and the positions of its texts are compared. The other
// gauge tests only see the option, which is how a name drawn over the needle went unnoticed.
import * as echarts from "echarts";
import { gaugeOption } from "./GaugeWidget";

vi.mock("echarts-for-react", () => ({ default: () => null }));

interface Label { text: string; x: number; y: number }

function labels(width: number, height: number, name: string): Label[] {
  const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width, height });
  chart.setOption(gaugeOption({ value: 12.5, min: 0, max: 100, unit: "kW", name }));
  const svg = chart.renderToSVGString();
  chart.dispose();
  return [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map((m) => ({
    text: m[2],
    x: Number(/\sx="([^"]*)"/.exec(m[1])?.[1]),
    y: Number(/\sy="([^"]*)"/.exec(m[1])?.[1]),
  }));
}

describe.each([[300, 220], [600, 440], [200, 140]])("a %i x %i gauge", (width, height) => {
  const name = "LV Panel 1";
  it("draws the asset name below the value and below every scale number, inside the widget", () => {
    const all = labels(width, height, name);
    const title = all.find((l) => l.text === name);
    const value = all.find((l) => /12\.5/.test(l.text));
    const scale = all.filter((l) => /^\d+$/.test(l.text));
    expect(title, "the name is drawn").toBeDefined();
    expect(value, "the value is drawn").toBeDefined();
    expect(scale.length).toBeGreaterThan(0);
    expect(title!.y).toBeGreaterThan(value!.y);
    expect(title!.y).toBeGreaterThan(Math.max(...scale.map((l) => l.y)));
    expect(title!.y).toBeLessThan(height - 4);
    expect(Math.abs(title!.x - width / 2)).toBeLessThan(width * 0.1); // centred
  });
});
```

Also add to `widgets.test.tsx`'s gauge block one assertion on the option itself: the series has a `title` whose `offsetCenter` is an array with a larger y percentage than `detail.offsetCenter`'s `"70%"`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/dashboard/widgets/gauge.ssr.test.ts`
Expected: FAIL on `title.y` not greater than the value's (the name is at the default centre position). If it fails because no `<text>` was found, fix the parser first and re-run until the failure is the positional one.

- [ ] **Step 3: Implement**

In `gaugeOption`, add a `title` block to the series next to `detail` (starting values; tune `offsetCenter` within the three sizes of the test until all pass, and report the final numbers):

```tsx
      title: { show: true, offsetCenter: [0, "98%"], fontSize: 13, color: muted ? MUTED_FIGURE : "#000" },
```

Do not change the `detail` block, the data or the size handling. Do not try to shorten long names (S7-3 owns that).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/dashboard src/pages/DashboardPage.test.tsx && npm run typecheck`
Expected: all PASS. `DashboardPage.test.tsx` counts `setOption` calls on the gauge: the option must still be built only from the memo's primitive inputs.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/dashboard/widgets/GaugeWidget.tsx frontend/src/components/dashboard/widgets/gauge.ssr.test.ts frontend/src/components/dashboard/widgets/widgets.test.tsx
git commit -m "fix(ui): the gauge draws the asset name below its value instead of over the needle"
git push
```
(append the trailers)

---

### Task 6: Undo after deleting a widget (S7-5)

**Files:**
- Modify: `frontend/src/components/dashboard/DashboardEditor.tsx`
- Test: `frontend/src/pages/DashboardPage.edit.test.tsx`

**Interfaces:**
- Consumes: `DraftWidget` (has `key` and `title`), the editor's `drafts` state and `renderWidget`.
- Produces: nothing other tasks use. Behaviour: deleting a widget still removes it at once (nothing is saved until Save, Cancel discards everything) and now shows an always-mounted status line with an Undo button that puts the widget back at its old position in the list; only the last deletion can be undone; adding a widget retires the offer.

Owner wording (roadmap S7-5): "confirm or Undo". This plan picks Undo: it needs no extra click for the usual case and nothing is lost either way.

- [ ] **Step 1: Write the failing tests**

In `DashboardPage.edit.test.tsx`, reuse the helpers of the nearest existing test that deletes a widget (find it with `grep -n "Delete " src/pages/DashboardPage.edit.test.tsx`) and add, with a dashboard of three widgets titled `A`, `B`, `C`:

```tsx
  it("offers Undo after a delete and puts the widget back where it was", async () => {
    // open the editor on a dashboard with widgets A, B, C (as the neighbouring tests do)
    await user.click(screen.getByRole("button", { name: "Delete B" }));
    expect(screen.queryByRole("button", { name: "Edit B" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Removed “B”");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Edit B" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    // the editor is clean again: Save is disabled because nothing differs from what was loaded
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("only the last delete can be undone", async () => {
    await user.click(screen.getByRole("button", { name: "Delete A" }));
    await user.click(screen.getByRole("button", { name: "Delete B" }));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Edit B" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit A" })).not.toBeInTheDocument();
  });

  it("deleting the only widget works and can be undone", async () => {
    // open the editor on a dashboard with a single widget A
    await user.click(screen.getByRole("button", { name: "Delete A" }));
    expect(screen.getByText("No widgets yet. Use Add widget.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Edit A" })).toBeInTheDocument();
  });

  it("adding a widget retires the Undo offer", async () => {
    await user.click(screen.getByRole("button", { name: "Delete C" }));
    // add a widget through the dialog exactly as the existing "Add widget" test does
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });
```

(`user` is the file's `userEvent.setup()` instance; adapt the opening steps to the file's own helpers. The single-widget case can reuse a dashboard fixture with one widget from `test/dashboardFixtures.ts`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/pages/DashboardPage.edit.test.tsx -t Undo`
Expected: FAIL (no status line, no Undo button).

- [ ] **Step 3: Implement**

In `DashboardEditor.tsx`, next to the other `useState` calls add:

```tsx
  /** The widget removed last in this session and where it sat, so Undo can put it back. */
  const [removed, setRemoved] = useState<{ draft: DraftWidget; index: number } | null>(null);
```

Add the handlers after `accept`:

```tsx
  const removeWidget = (d: DraftWidget) => {
    const index = drafts.findIndex((x) => x.key === d.key);
    if (index < 0) return;
    setRemoved({ draft: d, index });
    setDrafts((current) => current.filter((x) => x.key !== d.key));
  };
  const undoRemove = () => {
    if (!removed) return;
    const { draft, index } = removed;
    setDrafts((current) => (current.some((x) => x.key === draft.key) ? current : [...current.slice(0, index), draft, ...current.slice(index)]));
    setRemoved(null);
  };
```

In `accept`, add `if (!target) setRemoved(null);` directly after the `const key = newKey();` line (a NEW widget may take the freed space, and an Undo into an occupied place would overlap; editing an existing widget changes no position and keeps the offer). Change the Delete button's handler to `onClick={() => removeWidget(d)}`. Render, directly above the `<p className="muted">Drag a widget ...` line, an always-mounted live region so the announcement is read:

```tsx
      <div role="status" aria-live="polite">
        {removed && (
          <p className="muted">
            Removed “{removed.draft.title || "widget"}”. <button type="button" onClick={undoRemove}>Undo</button>
          </p>
        )}
      </div>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/pages src/components/dashboard src/lib/dashboardEdit.test.ts && npm run typecheck`
Expected: all PASS. Existing editor tests that look for `role="status"` elsewhere may need `within(...)`; fix those tests, not the markup.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/dashboard/DashboardEditor.tsx frontend/src/pages/DashboardPage.edit.test.tsx
git commit -m "feat(ui): deleting a widget in the editor can be undone"
git push
```
(append the trailers)

---

### Task 7: Times in the site zone, and an honest timezone hint (S2-1, BL:94)

**Files:**
- Modify: `frontend/src/lib/siteTime.ts`
- Modify: `frontend/src/components/MetricsTable.tsx`, `frontend/src/pages/ScansPage.tsx`, `frontend/src/pages/SourcesPage.tsx`, `frontend/src/pages/SettingsPage.tsx`
- Test: `frontend/src/lib/siteTime.test.ts`, `frontend/src/pages/AssetPage.test.tsx`, `frontend/src/pages/ScansPage.test.tsx`, `frontend/src/pages/SourcesPage.test.tsx`, `frontend/src/pages/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: `useSite()` (`data?.timezone`), `formatSiteDateTime(iso, tz)` (`2026-10-07 13:00:00`, returns `iso` when it cannot format).
- Produces: `formatSiteClock(iso: string, timezone: string): string` in `lib/siteTime.ts` (`13:00:05`, `iso` unchanged when it cannot be formatted); `when(ts, timezone)` in `MetricsTable.tsx` now takes the zone as its second argument.

Decision (roadmap offered "follow the zone, or word the hint narrowly"): the three screens follow the site zone, because the Audit page, the charts and the dashboards already do and a mixed display is worse than either.

- [ ] **Step 1: Write the failing tests**

`siteTime.test.ts`:

```ts
describe("formatSiteClock", () => {
  it("prints the wall clock of the site zone", () => {
    expect(formatSiteClock("2026-10-07T10:00:05Z", "Asia/Qatar")).toBe("13:00:05");
    expect(formatSiteClock("2026-10-07T23:30:00Z", "Asia/Qatar")).toBe("02:30:00"); // the next day over there
  });
  it("returns the input when it cannot be formatted", () => {
    expect(formatSiteClock("not a date", "Asia/Qatar")).toBe("not a date");
    expect(formatSiteClock("2026-10-07T10:00:05Z", "Not/AZone")).toBe("2026-10-07T10:00:05Z");
  });
});
```

`AssetPage.test.tsx`: a metric with `ts: "2026-10-07T10:00:05+00:00"` and the site route returning `Asia/Qatar` shows `13:00:05` in the Updated column; and with the site route failing (status 500) the cell shows `—`, not a browser-zone time. `SourcesPage.test.tsx`: a source with `last_seen: "2026-10-09T11:05:00Z"` shows `2026-10-09 14:05:00`. `ScansPage.test.tsx`: a scan with `created_at: "2026-10-09T11:05:00Z"` shows `2026-10-09 14:05:00`. `SettingsPage.test.tsx`: the hint mentions both where a day and a month start and the times shown (assert the text contains `day`, `month` and `times`), and no longer says only "energy totals".

Add `"GET /api/site": { body: { timezone: "Asia/Qatar", currency: "QAR" } }` to the mocks of every existing test in those files that renders the table (an unmocked route answers 500 in `mockFetch`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/siteTime.test.ts src/pages/AssetPage.test.tsx src/pages/SourcesPage.test.tsx src/pages/ScansPage.test.tsx src/pages/SettingsPage.test.tsx`
Expected: FAIL (`formatSiteClock` missing; the pages print browser-zone strings).

- [ ] **Step 3: Implement**

`siteTime.ts`, after `formatSiteDateTime`:

```ts
/** `13:05:00` in the site zone. Returns `iso` unchanged when it cannot be formatted. */
export function formatSiteClock(iso: string, timezone: string): string {
  const f = fields(new Date(iso), timezone);
  return f ? `${f.hour}:${f.minute}:${f.second}` : iso;
}
```

`MetricsTable.tsx`: import `useSite` and `formatSiteClock`, replace `when` by

```tsx
export const when = (ts: string | null | undefined, timezone: string | undefined) =>
  ts && timezone ? formatSiteClock(ts, timezone) : "—";
```

call `const site = useSite();` as the first line of `MetricsTable` (before the early return for an empty list, so hooks run unconditionally) and render `when(current ? current.ts : m.ts, site.data?.timezone)`. Until the zone has loaded (or if it failed) the cell shows `—`.

`SourcesPage.tsx` line 76 and `ScansPage.tsx` line 123: call `useSite()` in the component, and render `site.data ? formatSiteDateTime(iso, site.data.timezone) : "—"` (Sources keeps its existing `s.last_seen ? ... : "—"` shape).

`SettingsPage.tsx` line 36, replace the hint with:

```tsx
        <p className="muted">
          The site's time zone. It decides where a day and a month start (today, yesterday, this month and last month in
          energy totals, Billing and dashboard ranges) and the times shown in the app. Readings are stored in UTC.
        </p>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run && npm run typecheck`
Expected: the whole frontend suite PASSES (this task changes a component that several pages mount).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/siteTime.ts frontend/src/lib/siteTime.test.ts frontend/src/components/MetricsTable.tsx frontend/src/pages/ScansPage.tsx frontend/src/pages/SourcesPage.tsx frontend/src/pages/SettingsPage.tsx frontend/src/pages/AssetPage.test.tsx frontend/src/pages/ScansPage.test.tsx frontend/src/pages/SourcesPage.test.tsx frontend/src/pages/SettingsPage.test.tsx
git commit -m "fix(ui): the Metrics table, Scans and Sources show times in the site zone, and the timezone hint says what the zone decides"
git push
```
(append the trailers)

---

### Task 8: Storage settings contract (S13-12)

**Files:**
- Modify: `backend/dcdash/core/storage.py`, `backend/dcdash/api/storage.py`
- Modify: `frontend/src/api/types.ts`, `frontend/src/api/queries.ts`, `frontend/src/pages/StoragePage.tsx`
- Test: `backend/tests/test_storage_settings.py`, `backend/tests/test_api_storage.py`, `frontend/src/pages/StoragePage.test.tsx`

**Interfaces:**
- Consumes: `get_setting`, `set_setting`, `STORAGE_KEY`, `apply_policies`.
- Produces (wave W1b builds the Set/Reset buttons on these):
  - `StorageSettings` in `core/storage.py`: the five fields, ALL REQUIRED (no defaults), same ranges and the same `_ordered` validator as today, `disk_capacity_gb` additionally `allow_inf_nan=False`.
  - `FACTORY_STORAGE_SETTINGS: StorageSettings` = raw 30, compress 7, rollup 730, capacity 100, warn 80: the one place the factory values live.
  - `StorageSettingsOut(StorageSettings)` with `factory: StorageSettings`, the response of `GET /api/settings/storage` only. `PUT /api/settings/storage` still returns exactly the five saved values (`StorageSettings`), as today (the existing test `test_put_updates_policies` compares the whole body).
  - Frontend `StorageSettingsOut = StorageSettings & { factory: StorageSettings }`; `useStorageSettings` returns it; the page keeps no copy of the numbers.

Design note for the reviewer: the roadmap says "a separate input model with every field required". Nothing else builds a partial `StorageSettings` once the loader merges explicitly, so the one model with required fields IS the input model; a second class would only duplicate the validator. The infinity guard is one keyword beyond the roadmap row: `Infinity` passes `gt=0` today and would make `/api/storage` raise `OverflowError` for good.

- [ ] **Step 1: Write the failing tests**

Backend, `test_api_storage.py` (it already imports `login_as`; add `import pytest` if absent; the policy query is the one in `test_put_updates_policies`):

```python
FULL = {"raw_retention_days": 45, "compress_after_days": 10, "rollup_1m_retention_days": 800,
        "disk_capacity_gb": 250, "warn_threshold_pct": 85}


async def retention_days(db) -> str:
    return await db.fetchval(
        "SELECT config->>'drop_after' FROM timescaledb_information.jobs "
        "WHERE proc_name = 'policy_retention' AND hypertable_name = 'readings'"
    )


@pytest.mark.parametrize("missing", list(FULL))
async def test_put_refuses_a_body_with_a_field_missing(client, db, missing):
    await login_as(client, db)
    assert (await client.put("/api/settings/storage", json=FULL)).status_code == 200
    body = {k: v for k, v in FULL.items() if k != missing}
    assert (await client.put("/api/settings/storage", json=body)).status_code == 422
    assert (await client.get("/api/settings/storage")).json()["raw_retention_days"] == 45  # not reset to 30
    assert await retention_days(db) == "45 days"


async def test_put_refuses_an_empty_body_and_changes_nothing(client, db):
    await login_as(client, db)
    await client.put("/api/settings/storage", json=FULL)
    assert (await client.put("/api/settings/storage", json={})).status_code == 422
    assert (await client.get("/api/settings/storage")).json()["warn_threshold_pct"] == 85
    assert await retention_days(db) == "45 days"


@pytest.mark.parametrize("field", list(FULL))
async def test_put_refuses_null(client, db, field):
    await login_as(client, db)
    assert (await client.put("/api/settings/storage", json={**FULL, field: None})).status_code == 422


@pytest.mark.parametrize("raw", ["Infinity", "-Infinity", "NaN"])
async def test_put_refuses_a_non_finite_capacity(client, db, raw):
    await login_as(client, db)
    body = ('{"raw_retention_days": 45, "compress_after_days": 10, "rollup_1m_retention_days": 800, '
            '"disk_capacity_gb": %s, "warn_threshold_pct": 85}' % raw)
    r = await client.put("/api/settings/storage", content=body, headers={"content-type": "application/json"})
    assert r.status_code == 422
    assert (await client.get("/api/storage")).status_code == 200  # the page that would have broken still answers


async def test_get_exposes_the_factory_values_next_to_the_stored_ones(client, db):
    await login_as(client, db)
    await client.put("/api/settings/storage", json=FULL)
    body = (await client.get("/api/settings/storage")).json()
    assert body["raw_retention_days"] == 45
    assert body["factory"] == {"raw_retention_days": 30, "compress_after_days": 7, "rollup_1m_retention_days": 730,
                               "disk_capacity_gb": 100, "warn_threshold_pct": 80}
    assert "factory" not in (await client.put("/api/settings/storage", json=FULL)).json()


async def test_a_stored_row_that_lacks_a_field_is_read_with_the_factory_value(client, db):
    await login_as(client, db)
    # the test database starts with an empty settings table, so the row is written, not updated
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('storage', "
        "'{\"raw_retention_days\": 30, \"compress_after_days\": 7, \"rollup_1m_retention_days\": 730}'::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
    )
    body = (await client.get("/api/settings/storage")).json()
    assert body["warn_threshold_pct"] == 80 and body["disk_capacity_gb"] == 100
```

In `test_storage_settings.py` the existing direct constructions such as `StorageSettings(raw_retention_days=10, compress_after_days=10)` now fail for the missing fields: rewrite them through a small helper in that file, `def settings(**overrides): return StorageSettings(**{**FACTORY_STORAGE_SETTINGS.model_dump(), **overrides})`; the assertions stay. Add one test that `FACTORY_STORAGE_SETTINGS.model_dump()` equals the five numbers above.

Frontend, `StoragePage.test.tsx`: the mocked `GET /api/settings/storage` body gets a `factory` object; add a test that Save sends exactly the five fields and no `factory` key (inspect the recorded PUT body).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_storage.py tests/test_storage_settings.py -q`
Expected: FAIL (an empty `PUT` answers 200 and resets; no `factory`; `Infinity` accepted).

- [ ] **Step 3: Implement**

`core/storage.py`: replace the class header and fields (keep the validator body and `REFRESH_WINDOW_DAYS`):

```python
class StorageSettings(BaseModel):
    """The five storage settings. Every field is required: a request that leaves one out is refused, because filling the
    gap with a default would silently reset retention. The factory values are FACTORY_STORAGE_SETTINGS below."""

    raw_retention_days: int = Field(le=3650)
    compress_after_days: int = Field(ge=1, le=365)
    rollup_1m_retention_days: int = Field(ge=30, le=36500)
    disk_capacity_gb: float = Field(gt=0, allow_inf_nan=False)
    warn_threshold_pct: int = Field(ge=50, le=99)

    @model_validator(mode="after")
    def _ordered(self) -> StorageSettings:
        ...  # unchanged


# The one place the factory values live (the migrations 0002 and 0004 seed the same numbers as history). GET exposes them.
FACTORY_STORAGE_SETTINGS = StorageSettings(
    raw_retention_days=30, compress_after_days=7, rollup_1m_retention_days=730, disk_capacity_gb=100, warn_threshold_pct=80
)


class StorageSettingsOut(StorageSettings):
    """What GET answers: the stored values plus the factory values a reset can fall back on."""

    factory: StorageSettings
```

Change the loader so a stored row that lacks a key is read with the factory value for it (the same behaviour as before, now explicit):

```python
async def load_storage_settings(db: AsyncSession) -> StorageSettings:
    factory = FACTORY_STORAGE_SETTINGS.model_dump()
    return StorageSettings.model_validate({**factory, **await get_setting(db, STORAGE_KEY, factory)})
```

`api/storage.py`: import `FACTORY_STORAGE_SETTINGS` and `StorageSettingsOut`; the GET becomes

```python
@router.get("/settings/storage", response_model=StorageSettingsOut)
async def get_storage_settings(db: AsyncSession = Depends(get_db)) -> StorageSettingsOut:
    stored = await load_storage_settings(db)
    return StorageSettingsOut(**stored.model_dump(), factory=FACTORY_STORAGE_SETTINGS)
```

The PUT keeps `body: StorageSettings` and `response_model=StorageSettings`. Run `grep -rn "StorageSettings()" backend` to be sure no other caller relies on the removed defaults (the housekeeping and the stats path load through `load_storage_settings`).

Frontend: `types.ts` add `export type StorageSettingsOut = StorageSettings & { factory: StorageSettings };`; `queries.ts` `useStorageSettings` fetches `api.get<StorageSettingsOut>(...)`; in `StoragePage.tsx` initialise the form from the five fields only:

```tsx
    if (settings.data && !form) {
      const { factory: _factory, ...values } = settings.data;
      setForm(values);
    }
```

(if the linter objects to the unused name, pick the five keys from `FIELDS` instead). Leave `step="any"` on the page's inputs as it is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_api_storage.py tests/test_storage_settings.py tests/test_schema_tiers.py tests/test_housekeeping.py -q` and `cd frontend && npx vitest run src/pages/StoragePage.test.tsx && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/dcdash/core/storage.py backend/dcdash/api/storage.py backend/tests/test_api_storage.py backend/tests/test_storage_settings.py frontend/src/api/types.ts frontend/src/api/queries.ts frontend/src/pages/StoragePage.tsx frontend/src/pages/StoragePage.test.tsx
git commit -m "fix(api): PUT /api/settings/storage needs every field (an empty body no longer resets retention), a non-finite capacity is refused, and GET exposes the factory values"
git push
```
(append the trailers)

---

### Task 9: `.env` loss guard, backup note, recovery steps (S12-4 scripts and README)

**Files:**
- Modify: `scripts/setup.sh`, `scripts/setup.ps1`, `scripts/backup.sh`, `scripts/backup.ps1`
- Create: `backend/tests/test_scripts_setup.py`
- Modify: `README.md` (section "Backup and restore", and the sentence in "Run it" that says "Keep `.env`")

**Interfaces:**
- Consumes: the Compose project name as `docker compose config --no-interpolate` prints it (`name: dcdash`, or the value of `COMPOSE_PROJECT_NAME`); Docker labels `com.docker.compose.project` and `com.docker.compose.volume=dbdata` on the database volume.
- Produces: `scripts/setup.sh` exits 1 (and creates nothing) when `.env` is missing and the project's `dbdata` volume exists, or when Docker cannot answer. Exit 0 paths are unchanged.

The finding (S12-4b, verified in section 12): a lost `.env` plus `scripts/setup.sh` writes new random values and says "Created .env" like a first run; the existing volume still has the old password, the api crash-loops, and someone who "fixes" it with `down -v` loses the database.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_scripts_setup.py` (no Docker needed: a fake `docker` program records its calls, as `test_scripts_e2e.py` does; the script is COPIED into a temp directory so the real `.env` of the repository is never looked at or written):

```python
"""scripts/setup.sh must not write a new .env over an existing database volume.

A fake `docker` answers `compose config` and `volume ls` and logs every call; no container is touched and the real .env
of the repository is never read, because the script runs from a copy in a temporary directory.
"""
import os
import shutil
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "setup.sh"

FAKE_DOCKER = r"""#!/usr/bin/env bash
echo "docker $*" >> "$CALLS_LOG"
if [ -n "$FAKE_DOCKER_DOWN" ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi
case "$*" in
  "compose config --no-interpolate") printf 'name: %s\nservices: {}\n' "$FAKE_PROJECT" ;;
  "volume ls"*) if [ -n "$FAKE_VOLUME" ]; then echo "${FAKE_PROJECT}_dbdata"; fi ;;
esac
exit 0
"""


def run_setup(tmp_path: Path, *, env_file: str | None = None, volume: bool = False, docker_down: bool = False,
              project: str = "dcdash", args: tuple[str, ...] = ()):
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, root / "scripts" / "setup.sh")
    if env_file is not None:
        (root / ".env").write_text(env_file)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls.log"
    log.touch()
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER)
    docker.chmod(0o755)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("COMPOSE_", "DCDASH_"))}
    env.update(PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}", CALLS_LOG=str(log), FAKE_PROJECT=project,
               FAKE_VOLUME="1" if volume else "", FAKE_DOCKER_DOWN="1" if docker_down else "")
    result = subprocess.run(["bash", str(root / "scripts" / "setup.sh"), *args], capture_output=True, text=True,
                            env=env, timeout=60, cwd=tmp_path)
    return result, root, log.read_text().splitlines()


def started(calls: list[str]) -> bool:
    return any(" up " in c for c in calls)


def test_no_env_and_no_volume_is_a_first_run(tmp_path):
    result, root, calls = run_setup(tmp_path)
    assert result.returncode == 0, result.stderr
    env = (root / ".env").read_text()
    assert "DCDASH_DB_PASSWORD=" in env and "DCDASH_SECRET_KEY=" in env and "DCDASH_TIMEZONE=UTC" in env
    assert "docker compose up -d --build" in calls


def test_no_env_but_the_database_volume_exists_refuses_before_writing_anything(tmp_path):
    result, root, calls = run_setup(tmp_path, volume=True)
    assert result.returncode == 1
    assert not (root / ".env").exists()
    assert not started(calls)
    assert ".env" in result.stderr and "dcdash" in result.stderr and "volume" in result.stderr


def test_the_volume_is_looked_up_under_the_name_compose_reports(tmp_path):
    result, _, calls = run_setup(tmp_path, volume=True, project="dcdash_e2e_x")
    assert result.returncode == 1
    lookups = [c for c in calls if c.startswith("docker volume ls")]
    assert any("label=com.docker.compose.project=dcdash_e2e_x" in c for c in lookups)
    assert any("label=com.docker.compose.volume=dbdata" in c for c in lookups)


def test_an_existing_env_is_left_alone_even_with_a_volume(tmp_path):
    result, root, calls = run_setup(tmp_path, env_file="DCDASH_DB_PASSWORD=keep\n", volume=True)
    assert result.returncode == 0, result.stderr
    assert (root / ".env").read_text() == "DCDASH_DB_PASSWORD=keep\n"
    assert started(calls)


def test_when_docker_cannot_answer_nothing_is_written(tmp_path):
    result, root, calls = run_setup(tmp_path, docker_down=True)
    assert result.returncode == 1
    assert not (root / ".env").exists()
    assert not started(calls)
    assert "docker" in result.stderr.lower()


def test_extra_arguments_still_reach_compose(tmp_path):
    result, _, calls = run_setup(tmp_path, args=("--profile", "dev"))
    assert result.returncode == 0, result.stderr
    assert "docker compose --profile dev up -d --build" in calls
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_scripts_setup.py -q`
Expected: FAIL on the two refusal tests and the fail-closed test (today the script writes `.env` and starts).

- [ ] **Step 3: Implement**

First check the premise, read-only and harmless: `docker compose config --no-interpolate | head -3` in the repo root must print `name: dcdash` as its first line; if this Compose version prints the name differently, adapt the `sed` pattern and the fake in the test, and say so in your report.

`scripts/setup.sh`:

```bash
#!/usr/bin/env bash
# Generates .env on first run, then starts the stack. Extra arguments go to
# docker compose, e.g. scripts/setup.sh --profile dev
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  # No .env but the database volume already exists: the volume was created with the password of the .env that is gone, so a
  # new random password would never open it (the api would crash-loop) and the new key could not decrypt the stored source
  # secrets. Stop before anything is written. Fail closed: when Docker cannot answer, the check cannot be made.
  config="$(docker compose config --no-interpolate)" || { echo "cannot read the Compose configuration (is Docker running?); .env was not created" >&2; exit 1; }
  project="$(printf '%s\n' "$config" | sed -n 's/^name: *//p' | head -n 1)"
  [ -n "$project" ] || { echo "cannot tell the Compose project name; .env was not created" >&2; exit 1; }
  volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.volume=dbdata)" || { echo "cannot list Docker volumes (is Docker running?); .env was not created" >&2; exit 1; }
  if [ -n "$volumes" ]; then
    echo "refusing to create .env: the database volume of Compose project '$project' already exists, and it belongs to the .env that is missing." >&2
    echo "Put the original .env back (keep a copy with every backup), then run this script again." >&2
    echo "Only if the data is not needed, remove the volume yourself and on purpose: docker volume rm $(printf '%s' "$volumes" | head -n 1)" >&2
    exit 1
  fi
  db_password=$(openssl rand -hex 24)
  secret_key=$(openssl rand -base64 32 | tr '+/' '-_')
  printf 'DCDASH_DB_PASSWORD=%s\nDCDASH_SECRET_KEY=%s\nDCDASH_TIMEZONE=UTC\n' \
    "$db_password" "$secret_key" > .env
  echo "Created .env"
fi
docker compose "$@" up -d --build
```

`scripts/setup.ps1`: the same check inside `if (-not (Test-Path .env)) { ... }`, before the key generation. Do NOT redirect native stderr (`2>$null` turns stderr output into a terminating error under `$ErrorActionPreference = "Stop"` in Windows PowerShell 5.1); `--no-interpolate` is what keeps `compose config` quiet:

```powershell
    # No .env but the database volume exists: it belongs to the .env that is gone (see scripts/setup.sh). Fail closed.
    $config = docker compose config --no-interpolate
    if ($LASTEXITCODE -ne 0) { throw "Cannot read the Compose configuration (is Docker running?). .env was not created." }
    $nameLine = $config | Select-String -Pattern '^name:\s*(\S+)' | Select-Object -First 1
    if (-not $nameLine) { throw "Cannot tell the Compose project name. .env was not created." }
    $project = $nameLine.Matches[0].Groups[1].Value
    $volumes = docker volume ls -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.volume=dbdata"
    if ($LASTEXITCODE -ne 0) { throw "Cannot list Docker volumes (is Docker running?). .env was not created." }
    if ($volumes) {
        throw "Refusing to create .env: the database volume of Compose project '$project' already exists, and it belongs to the .env that is missing. Put the original .env back (keep a copy with every backup), then run this script again. Only if the data is not needed, remove the volume yourself and on purpose: docker volume rm $($volumes | Select-Object -First 1)"
    }
```

Parse-check it without running it, from WSL: `powershell.exe -NoProfile -Command "\$e=\$null; [void][System.Management.Automation.Language.Parser]::ParseFile('$(wslpath -w scripts/setup.ps1)',[ref]\$null,[ref]\$e); \$e.Count"` must print `0` (do the same for `backup.ps1`). Say in your report that the PowerShell twins were parse-checked and not run.

`scripts/backup.sh`, after the existing final `echo`, add:

```bash
echo "note: .env is NOT in this dump. It holds DCDASH_SECRET_KEY, the key that encrypts the stored source secrets: keep a copy of .env with the dump, or the secrets cannot be decrypted after a restore." >&2
```

and the same as a `Write-Host` line at the end of `scripts/backup.ps1`. Check `scripts/backup_smoke.sh` and the README do not parse backup.sh's output (`grep -n "wrote" scripts/*`): the note goes to stderr so stdout is unchanged either way.

`README.md`: in "Backup and restore" add this subsection after the paragraph about `pg_dump` warnings, and change the "Keep `.env`" sentence in "Run it" to end with "Keep a copy of `.env` with every backup (see "What the backup does not contain")."

```markdown
### What the backup does not contain

The dump is the database only. `.env` is not in it, and `.env` holds `DCDASH_SECRET_KEY`, the key that encrypts the
passwords and keys stored for your sources. Keep a copy of `.env` with every backup, off the machine.

- **Restoring on a new machine:** put that `.env` in place, run `scripts/setup.sh`, then `scripts/restore.sh <dump>`.
- **`.env` lost, dump kept:** the data restores, but every source with a stored secret shows `offline`
  ("stored secret cannot be decrypted") until its secret is typed in again (Discovery, the source's Details).
- **`.env` lost, database volume still there:** `scripts/setup.sh` refuses to create a new `.env`, because a new password
  cannot open the old volume. Put the original `.env` back. Do not "fix" it with `docker compose down -v`: that deletes the database.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_scripts_setup.py tests/test_scripts_e2e.py -q` and `bash -n scripts/setup.sh && bash -n scripts/backup.sh`
Expected: all PASS, no syntax error.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup.sh scripts/setup.ps1 scripts/backup.sh scripts/backup.ps1 backend/tests/test_scripts_setup.py README.md
git commit -m "fix(scripts): setup refuses to write a new .env over an existing database volume, backup says .env is not in the dump, README gets the recovery steps"
git push
```
(append the trailers)

---

### Task 10: README facts (S3-3, S12-13)

**Files:**
- Modify: `README.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Make the two edits**

In "Run it", after the `scripts/setup.sh --profile dev` code block (the "To include the SCADA simulator" part), add:

```markdown
The simulator's three protocols are added as sources in the app like any other. Its HTTP source needs the Secret
`sim-key` (the simulator's API key, `SIM_API_KEY` in `compose.yaml`); without it the test says `auth_failed:
credentials rejected`. The OPC UA simulator takes the user `sim` with any password, and Modbus needs none.
```

In "Backup and restore", after the "What the backup does not contain" subsection from Task 9, add:

```markdown
After a restore the collector rewrites the stored scan network (`collector_networks`) with the networks of the machine
it now runs on, so the range pre-filled in a new scan follows the machine, not the restored data. Check it before the first scan.
```

- [ ] **Step 2: Check the facts against the code**

Run: `grep -n "SIM_API_KEY" compose.yaml` (must show `sim-key`) and `grep -rn "collector_networks" backend/dcdash/collector/networks.py backend/dcdash/collector/main.py | head -5` (the collector must be the writer). If either differs from the sentence, fix the sentence, not the code.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README tells the dev HTTP source needs the secret sim-key, and that a restore leaves the scan network to the collector"
git push
```
(append the trailers)

---

## Wave close (the orchestrator, not an implementer)

Run after Task 10, in this order, and record the evidence in the progress ledger:

- [ ] `cd frontend && npm test && npm run typecheck && npm run build` (the full suite and the production build).
- [ ] `cd backend && uv run pytest -q` (the full backend suite, in the background: it takes minutes).
- [ ] The isolated end-to-end run: `docker compose --profile dev stop` (stopping is allowed), `scripts/e2e.sh` (it works in the throwaway project `dcdash_e2e` with its own volume), `docker volume ls` must still list `dcdash_dbdata`, then `docker compose --profile dev start`.
- [ ] A whole-wave Opus review of `git diff main...w0a-quick-wins` (brief in a file, verified with `tail`, short dispatch prompt), a fix wave if it finds anything, a scoped re-review of the fixes.
- [ ] Merge `--no-ff` into `main`, push `main`, update the roadmap's W0a status line and the project memory.
- [ ] Rebuild the dev stack from the merged tree after `scripts/backup.sh` (standing permission), then say honestly in the report what was NOT seen in a real browser (nav styling, skip link, wide dashboards, the gauge beyond the SVG geometry test): the owner's next look covers it.

## Out of scope (so a reviewer does not ask for it)

- `bool` accepted where a number is expected on `PUT /api/settings/storage` (`true` reads as 1): pydantic's lax mode; the ranges already refuse the ones that matter. Not changed.
- The `ReviewDialog` indentation uses ordinary spaces (a browser strips them from an option); only the new `assetOptions` uses non-breaking spaces. Not changed.
- Auditing storage and timezone changes (W1a/W1b), the Set/Reset buttons (W1b), Sources Edit and list sorting (W3a), long names in widgets (S7-3), phone layout (parked).

## Review log

Opus logic review of this plan: pending. Review file: `.superpowers/sdd/2026-10-09-w0a-quick-wins/planreview-A.md` (git-ignored workspace; findings are folded into this document and listed here once done).
