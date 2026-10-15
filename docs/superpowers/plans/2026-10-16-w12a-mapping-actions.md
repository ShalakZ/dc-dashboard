# W12a: mapping actions (unmap, move, Undo, New asset from Discovery) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can take a mapping off an asset, or move it to another asset, from Discovery (point, group and asset nodes, button and right-click menu) and from the asset page, with one honest confirmation and a 10 second Undo; mapping gets an Undo too; a new asset can be made from Discovery with the real asset form (kind, icon); a "+" on an asset node adds a child; a set of points dropped together maps in one review.

**Tier M** (a behaviour change across layers, one additive read route, no migration, no permission). It touches what billing figures are made of, so Task 1 gets a per-task Opus review (brief). ONE Opus plan review, Sonnet implementers (one per task, T2 and T3 in parallel with path-limited commits), targeted tests per task, the full frontend suite + typecheck + build + e2e type check once, the backend files that cover what changed (no `core`, no collector, no migration: no full backend run), ONE isolated Playwright run on a build of the final commit (`dcdash_e2e_w12a_vis`, ports **18216 / 18570**, both checked free with `ss -ltn` at 01:48), ONE whole-wave Opus review in a real browser (1440, 1024), ONE fix wave, a scoped re-review after any logic fix.

**Spec:** the brief `.waves/w12a.md` (owner's words 2026-10-15, rulings A1 to A7). Models: the W7r, W7s and W7p plans (`useTreeMove`'s Undo toast; `ConfirmDeleteDialog`; `RowActions`).

## Global Constraints
- UI rules (RESUME.md): simple, clean, slick; no cream background, no italic accents, no numbered labels, no monospace labels, no pills; new colours/spacing are tokens inside `@layer w6` (all eight looks); icons are inline SVG; widgets untouched; full browser width.
- Every implementer brief carries: "Edit files with the Edit tool or an anchored sed, never with a script that rewrites a whole file; after any scripted edit check the size and `git diff --stat`." New files by Bash heredoc.
- Playwright matches names by case-insensitive substring: every new `aria-label`, heading or `<label>` is audited against every `getByLabel(` / `getByRole(` in `frontend/e2e/*.ts` (A1).
- Escape closes the innermost layer; buttons in forms are `type="button"`; focus always lands on something named; one live region per area; late content gets a reserved slot; z-order tip 1100 > dialog 1000 > toasts 900 > drawer.
- Out of scope: speed work, expand/collapse features, the toolbar, the source card, node icons (w12b, w12c); the widgets; any migration or permission.

## Facts checked in the code (the brief is not law)
- `backend/dcdash/api/mappings.py`: `POST` (409 clash), `PATCH` (`MappingPatch.asset_id` moves a mapping; 409 clash), `DELETE` (204, audits `mapping.deleted` with only `mapping_id, point_id, asset_id, metric`), all `assets.edit`. **There is no read of one mapping**, and a deleted mapping's `scale`, `interval_seconds`, `custom_unit` are in no payload the Discovery page or the asset page holds: the graph route's `point_json` has `mapping_id, asset_id, mapped_metric` and `suggestion` (the scan's guess, not the stored values); `SummaryMetric` has `mapping_id, point_id, metric, unit`. Only the Points page's `PointRow.mapping` has all values. So an exact Undo of an unmap needs one new read.
- `POST /api/discovery/accept` (`discovery.accept`) answers `{asset_id, mapping_ids}` (ids in the order of `points`); `NewAsset` has `name, parent_id` only (no kind or icon). `POST /api/assets` (`assets.edit`) takes `AssetIn {name, parent_id, kind, sort_order, icon}` and audits `asset.created`.
- Permission needs (`roleEditor.ts`): `assets.edit` needs `assets.view`; `discovery.accept` needs `discovery.view`. A custom role can hold `discovery.accept` without `assets.edit`.
- Billing (`docs/dashboards-and-billing.md` 78, 175): an open month is recalculated on every request from today's tree, mappings and rates; a closed month keeps frozen figures (W11).
- `GraphModel.assets` is `Pick<Asset,"id"|"parent_id"|"name"|"kind">`; `AssetForm` needs full `Asset[]`, the kinds registry, `canRegister` (`assets.kinds`); `AssetsPage.create` does `POST`, `toast.success("Asset created")`, then registers the kind when `registerKind && canRegister` (else invalidates) (`AssetsPage.tsx` 109-126; `AssetsPage.test.tsx` pins the toast five times).
- `ToastOptions.action {label, onAction, title}`, `durationMs`, `signal` exist (`Toasts.tsx`); a toast with an action never collapses. `useConfirm()` gives `ask({title, message, confirmLabel, tone})`; `ConfirmDeleteDialog` takes `children` (a choice), `confirmDisabled`, `notice`, `tone`.
- The kinds registry (`AssetKind {id, name, icon, asset_count, starter}`) has no "container" flag. Its `icon` ids do: the Structure group (`site, building, hall, room, row`; rack is also Structure but is where meters belong, so it is not a container here).
- xyflow 12.12: a `Handle` starts a connection whenever `isConnectableStart` (default true), `nodesConnectable={false}` only hides the connection line (`renderConnection` needs `nodesConnectable`). `onConnectEnd(event, connectionState)` fires on release.
- `useCanvasMenu` closes the menu whenever `model` changes; `GraphContextMenu` is the right-click menu; `nodeActions()` in `DiscoveryPage.tsx` builds a node's items from its `data` callbacks (a role sees exactly the actions it has buttons for).

## Decisions (the owner may overrule any; each is also a `Ruling:` in the ledger)
1. **One new route, argued:** `GET /api/mappings/{mapping_id}` -> `MappingOut`, `assets.edit` (the same gate as every action that uses it). Alternatives rejected: enriching the graph route AND the asset summary (two payloads, still stale by the time of the click), or making DELETE answer 200 with a body (changes a 204 contract). `DELETE`'s audit detail also gains `scale, interval_seconds, custom_unit` (additive keys), so the audit row alone can restore a mapping when the toast is gone. No `core` file changes, so no full backend run.
2. **Module** `lib/mappingActions.ts` (pure helpers + request runners, no React) and `hooks/useMappingActions.tsx` (confirmation, Move dialog, toasts, Undo, invalidation). Surfaces: Discovery, the asset page, the Points page. Runners work one request at a time, read the mapping first (`GET`), stop at the first failure, and return what went, what failed (with a full-sentence reason) and how many were not tried. A 404 on the read or the delete is "already gone": counted, not a failure.
3. **Undo = 10 s toast.** Undo of an unmap re-creates each removed mapping with `POST /api/mappings` and the values read before the delete (same point, asset, metric, scale, interval, custom unit; the id is new, and the text does not promise otherwise). Undo of a move patches `asset_id` back. Undo of a mapping made in Discovery (`accept` or the bulk create) deletes the mapping ids the response returned. A 409 on any undo step says so plainly and stops; what was put back is reported. Offered only to a person holding `assets.edit`; otherwise the toast has no Undo (`discovery.accept` alone). An unmapped or moved batch that FAILED part-way still offers Undo for the part that went.
4. **New assets stay.** Undo of a mapping to an asset made in the same step never deletes the asset (it may have gained children or tariffs; deleting is a separate, guarded act). The toast says so: `Room 1 stays; delete it from Assets Tree if you do not need it.` Undo also leaves `source.enabled` as `accept` set it (harmless: the collector polls it); noted in the backlog.
5. **Confirmation words** (one place, `unmapText`/`moveText`, pinned by a test): `Billing for months that are still open is recalculated without these points; closed months keep their billed figures.` for unmap; `... recalculated with these points under <Asset>; closed months keep ...` for move. Titles name the point (or the group) and the asset.
6. **Where:** Discovery mapped POINT and mapped GROUP nodes get one small `Mapping actions for <name>` menu button (on the title row, `nodrag`, no height change) with the same items as the right-click menu: `Unmap…`, `Move to another asset…` (group: `Unmap this group…`, `Move this group's mappings…`); ASSET nodes get right-click items `Unmap everything from <source>…` (one per source with mappings on it, at most 5) and `New sub-asset…`. The asset page: each metric row gets a `RowActions` menu (`Actions for <metric>`): `Unmap…`, `Move to another asset…`; no "Unmap all from <source>" there (the summary carries no source name; Discovery's asset node does it). The Points page's Unmap goes through the module (a confirmation and an Undo now; its old "no confirmation" was a choice made before Undo existed). Gate: `assets.edit` only (not `discovery.accept`).
7. **Move dialog** = `ConfirmDeleteDialog` (`tone="primary"`, `confirmLabel="Move"`) with an asset select (`assetChoices`, indented) as `children`. Discovery pre-checks conflicts from the graph (`takenMetrics` of the target, minus the moved set, and two moved mappings with the same non-custom metric) and keeps Move off with the dialog's own sentence; the asset page has no list of the target's metrics, so its single-row move relies on the server's 409 (one PATCH, nothing changes) and says `<Asset> already has <metric>.`
8. **A4 container note** (`isContainerKind(kind, kinds)`): the asset's kind is a container when the icon of its kind in the registry (else the keyword guess `kindIconId(kind)`, the same rule that draws the node) is one of `site, building, hall, room, row`. Inline note in a reserved two-line slot (no layout shift), never blocking: `Room 1 is a room; meters usually belong to a Panel or Rack. Map here anyway?` (Move dialog: `Move here anyway?`).
9. **A5 two steps, not one request:** `New asset…` opens `Modal` > `AssetForm` (the real component), saved with `POST /api/assets` (so the icon chosen is the icon saved and the kind registration of `AssetsPage` is kept: it moves into a shared hook `useCreateAsset` that `AssetsPage.create` also calls, with the same toast text and order). For a group or an unmapped point the Review opens next on that asset (once the refetched graph lists it). Cost of the half-done state: if the review is cancelled, the empty asset stays (the dialog says so before saving: `Next you choose the points to map. Cancel keeps the new asset.`). Needs `assets.edit` (+ `assets.view`, implied); a role with `discovery.accept` only keeps today's Review "New asset" radio (name and parent), which stays in the dialog for them. For a role with `assets.edit`, a group's `New asset…` button and menu item open the form first. The pane menu item `New asset…` (no continuation, parent none), the asset menu item `New sub-asset…` and the "+" create only.
10. **A6 "+"**: an asset node gets a source `Handle` styled as a small `+` on its right edge (the children stand to the right). Click or Enter/Space opens `New sub-asset` (parent = that asset); dragging from it and releasing on empty canvas (`onConnectEnd`, target inside `.react-flow__pane`, nothing valid) does the same. It is visible on hover, on keyboard focus and on a selected node (touch has no hover), it has an accessible name (`Add a sub-asset under <name>`), is `nodrag`, and every other handle gets `isConnectableStart={false}` so nothing else starts a line; `isValidConnection` is `() => false` so no edge can ever be made. Needs `assets.edit`. The sibling "+" below a node is **not** offered (the pane menu and the asset menu cover it; a second control on a 80 px node costs more than it gives). If the drag cannot be made reliable in a real browser, the click, keyboard and menu paths still ship and the drag is parked with a Ruling.
11. **A7 multi-drop:** `dropPayloadForNodes(model, ids)`: every dragged node must be an unmapped point node of ONE source; then one Review for all (a mix of sources, clusters or mapped points keeps today's behaviour: one dragged node maps, a refusal otherwise says why in a toast). The dialog already refuses metric conflicts.
12. **Permissions in the UI:** `canEditAssets = can("assets.edit")` gates unmap, move, Undo, New asset, "+"; `canAccept` gates Map. The mapped toast gets Undo only with `canEditAssets`.

## Existing tests that will change (LESSONS A1; implementers grep again for their own task)
- `src/pages/DiscoveryPage.test.tsx`: menu lists at 1901-1934 and 2007 (`["Collapse","Map…","New asset…"]`, `["Map…"]`, the source and canvas menus), the cluster `New asset` tests at 437-438, 513-528, 565, 703-739 (a role with `assets.edit` now opens the form, not the Review's radio), the drop tests (`dragged.length <= 1`), the toast calls of the review commit.
- `src/components/graph/nodes.test.tsx` (253: the cluster's `New asset from LVP01 kW…`; button counts per node), `ReviewDialog.test.tsx` (the commit now toasts; the container note slot), `BulkCreateDialog.test.tsx` (toast with Undo).
- `src/pages/SourcePointsPage.test.tsx` 54, 257, 427-441 (title says "needs no confirmation"), 538-548: Unmap now asks and offers Undo.
- `src/pages/AssetPage.test.tsx` and `e2e/w3c.spec.ts`, `e2e/w7c.spec.ts`, `e2e/w3a.spec.ts`, `e2e/discovery.spec.ts` (134, 145: `New asset name`, `New asset from ${name}…`), `e2e/w7r.spec.ts` (980), `e2e/w7u.spec.ts` (671-790: the menu items per node type, `newAsset: /^New asset/`): rows/columns of the metrics table, the new menu items, the form first.
- `src/pages/AssetsPage.test.tsx` (5 pins of `Asset created`): the shared `useCreateAsset` must keep them green unchanged.
- Backend: `tests/auth_expectations.py` (a new `GET /api/mappings/{mapping_id}` row), `tests/test_route_gates.py` (the coverage gate), `tests/test_api_mappings.py`.
- The docs-reading tests (`tests/test_readme_ops.py`, `test_docs_links.py`, `test_field_debugging_doc.py`) run right after the docs edit.

## File map
- Backend: `api/mappings.py` (GET, audit detail), `tests/test_api_mappings.py`, `tests/auth_expectations.py`.
- Create: `lib/mappingActions.ts` + `.test.ts`; `hooks/useMappingActions.tsx` + `.test.tsx`; `components/MoveMappingsDialog.tsx` + `.test.tsx`; `hooks/useCreateAsset.ts` + `.test.tsx`; `components/graph/NewAssetDialog.tsx` + `.test.tsx`; `e2e/w12a.spec.ts`; `.waves/w12a/` scripts (not committed).
- Modify: `components/MetricsTable.tsx`, `pages/AssetPage.tsx`, `pages/SourcePointsPage.tsx`, `pages/AssetsPage.tsx` (T4: calls `useCreateAsset`), `components/graph/nodes.tsx`, `ReviewDialog.tsx`, `BulkCreateDialog.tsx`, `lib/graph.ts` (node data types), `lib/drop.ts` (`dropPayloadForNodes`), `pages/DiscoveryPage.tsx`, `styles/*` (one new graph stylesheet block, tokens only in `@layer w6`), `e2e/playwright.config.ts` (the `w12a` project), docs (`screens.md`, `sources-and-discovery.md`, `assets-and-kinds.md`, `roles-and-permissions.md` if it lists page behaviours), `CHANGELOG.md`, `docs/superpowers/backlog.md`, the roadmap row, the plan's log.

## Tasks (one commit each, `git add` named files only)

### Task 0: the read route (backend)
**Files:** `backend/dcdash/api/mappings.py`, `backend/tests/test_api_mappings.py`, `backend/tests/auth_expectations.py`.
**Produces:** `GET /api/mappings/{mapping_id}` -> `MappingOut` (404 `mapping not found`; `assets.edit`); `mapping.deleted` audit detail gains `scale, interval_seconds, custom_unit`.
- [ ] Failing tests: GET returns the stored values (custom unit, scale 0.001, interval 1); 404; an operator and a viewer get 403; the delete audit row carries the three values; the route is in `ROUTE_PERMISSIONS` (`_all("assets.edit", ...)`).
- [ ] Implement (reuse `get_mapping`); run `uv run pytest tests/test_api_mappings.py tests/test_route_gates.py tests/test_permissions.py tests/test_permissions_parity.py tests/test_audit*.py -q`.
- [ ] Commit `feat(w12a): GET /api/mappings/{id}, and the values in the delete audit row`.

### Task 1: the shared mapping module (per-task Opus review)
**Files:** create `lib/mappingActions.ts`, `lib/mappingActions.test.ts`, `hooks/useMappingActions.tsx`, `hooks/useMappingActions.test.tsx`, `components/MoveMappingsDialog.tsx`, `components/MoveMappingsDialog.test.tsx`; modify `api/types.ts` only if a type is needed.
**Produces (exact names later tasks use):**
```ts
// lib/mappingActions.ts
export interface MappingRef { id: number; name: string }            // name: what a sentence calls it (a point name, or a metric)
export interface Failure { name: string; reason: string }           // reason is a full sentence ending in a full stop
export interface UnmapResult { removed: Mapping[]; gone: number; failed: Failure | null; notTried: number }
export interface MoveResult { moved: { id: number; name: string; from: number }[]; gone: number; failed: Failure | null; notTried: number }
export interface PutBackResult { done: number; failed: Failure | null; notTried: number }
export function unmapMappings(refs: readonly MappingRef[]): Promise<UnmapResult>          // GET, then DELETE, one at a time
export function restoreMappings(removed: readonly Mapping[], nameOf: (m: Mapping) => string): Promise<PutBackResult>  // POST the read values
export function moveMappings(refs: readonly MappingRef[], toAssetId: number): Promise<MoveResult>   // GET, then PATCH asset_id
export function moveBack(moved: MoveResult["moved"]): Promise<PutBackResult>
export function deleteMappings(ids: readonly number[]): Promise<PutBackResult>            // undo of a mapping made by accept
export function moveConflicts(rows: readonly { id: number; name: string; metric: Metric }[], taken: ReadonlySet<Metric>): string[]  // names that would clash
export function isContainerKind(kind: string, kinds: readonly { name: string; icon: string }[] | undefined): boolean
export function containerNote(asset: { name: string; kind: string }, kinds, verb: "Map" | "Move"): string | null
export const UNDO_MS = 10_000;
// hooks/useMappingActions.tsx
export function useMappingActions(opts: { assets: readonly Pick<Asset,"id"|"parent_id"|"name"|"kind">[]; kinds?: readonly AssetKind[]; takenFor?: (assetId: number) => ReadonlySet<Metric> }): {
  canEdit: boolean;                                                         // can("assets.edit")
  unmap(refs: readonly MappingRef[], from: { asset: string; what?: string }): void;   // opens the confirmation
  move(refs: readonly (MappingRef & { metric: Metric; assetId: number })[], from: { what?: string }): void;  // opens the Move dialog
  mapped(info: { count: number; assetName: string; mappingIds: readonly number[]; newAsset?: boolean }): void;  // the "Mapped N points to X" toast, Undo only with canEdit
  dialogs: ReactNode; busy: boolean;
};
```
- [ ] Pure helpers first (TDD): runner tests with a stubbed `api`: unmap 3, the second `DELETE` 500 -> `removed` has 1, `failed` names the second, `notTried` 1; a 404 on the read counts as `gone`; **restore of a mapping with `custom` metric, unit `MW`, scale 0.001, interval 1 posts exactly those values**; restore stops at a 409 and reports what was put back; move 409 changes nothing for that row; `moveBack` patches to `from`; `moveConflicts` (taken metric, two moved with the same metric, custom never conflicts); `isContainerKind` (registry icon `room` for a kind named "Data hall"; unregistered "Room 4" by the keyword guess; "Panel", "Rack" false); the confirmation sentence mentions open and closed months.
- [ ] Hook + dialog: confirmation through `useConfirm`; success toast `Unmapped 3 points from Room 1.` with `Undo` (10 s, `signal` not needed); partial failure -> error toast with the Undo for the part that went; Undo result toasts (`Put back 3 mappings.` / the 409 sentence); invalidation `keys.graph, keys.sources, keys.assets, keys.fleet, keys.auditAll, keys.billing, keys.widgetData` in a `finally` (success or failure); an in-flight ref (a second action while one runs does nothing); the Undo closure uses no component state (it must work after the page is left); `canEdit` false -> `mapped()` toasts without an action.
- [ ] `MoveMappingsDialog`: select of assets (indented, current asset excluded when all rows share it), conflict sentence (Move off), container note slot (`min-height: 2lh`), the billing sentence, focus on Cancel then the select, Escape closes, errors in the dialog's own line.
- [ ] `npx vitest run src/lib/mappingActions.test.ts src/hooks/useMappingActions.test.tsx src/components/MoveMappingsDialog.test.tsx` and `npm run typecheck`; commit `feat(w12a): the shared mapping actions: unmap, move, Undo`.
- [ ] Opus per-task review of T0 + T1 (data-changing code; prompt in `.waves/w12a/`), fold in Critical/Important before T2 and T3 start.

### Task 2: the asset page and the Points page
**Files:** `components/MetricsTable.tsx`, `pages/AssetPage.tsx`, `pages/SourcePointsPage.tsx`, their tests (`AssetPage.test.tsx`, `SourcePointsPage.test.tsx`), `styles/pages-assets.css` only if a width is needed.
**Consumes:** `useMappingActions`. 
- [ ] `MetricsTable` gets an `actions?: { onUnmap(m), onMove(m) }` prop (absent = read-only, today's markup, so `AssetsSummary` and tests that mount it alone are unchanged); a last column with a `RowActions` (`Actions for <metric>`); the empty header cell is `class="row-actions"` like the other tables. `AssetPage` passes it when `canEdit` and wires `unmap([{id: mapping_id, name: metric}], { asset: data.asset.name })` and `move` with `useAssets()` data as `assets` and `useAssetKinds` as `kinds`. After a change the summary refetches (`keys.assets` prefix covers it).
- [ ] `SourcePointsPage.unmap` uses the module with the row's own `mapping` (no read needed there is fine; the module reads anyway); update the tests that pinned "no confirmation".
- [ ] Tests: the menu exists only with `assets.edit`; Unmap asks, deletes, shows the toast with Undo; Move lists assets; a viewer sees no `Actions for` buttons on the metric rows.
- [ ] `npx vitest run src/pages/AssetPage.test.tsx src/pages/SourcePointsPage.test.tsx src/components/MetricsTable*`; commit.

### Task 3: Discovery, unmap and move, and the Undo after mapping (A2, A3, A4)
**Files:** `components/graph/nodes.tsx`, `lib/graph.ts` (types: `onUnmap`, `onMove` on point/cluster data; `mapped?: {sourceId; sourceName; count}[]` and `onUnmapSource` on asset data), `pages/DiscoveryPage.tsx`, `components/graph/ReviewDialog.tsx`, `components/graph/BulkCreateDialog.tsx`, a small graph CSS block, tests of each.
**Consumes:** `useMappingActions`.
- [ ] Nodes: `Mapping actions for <name>` button (a `RowActions` menu) on mapped point and mapped group nodes, only when the data carries the callbacks; `nodeActions()` adds the same items to the right-click menu and to the asset node (`Unmap everything from <source>…`); `nodeData()` gives the callbacks only with `canEditAssets`.
- [ ] Refs for a group: every point of the cluster with `mapping_id !== null` (`name` = point name); a point: itself; an asset node and a source: the points of that source with `asset_id === assetId`. Move rows carry `metric` and `assetId` from the graph.
- [ ] `ReviewDialog.commit` and `BulkCreateDialog`: after success call `mapped({count, assetName, mappingIds, newAsset})` from `AcceptResult.mapping_ids` (the bulk create collects the ids of every group; a partial bulk failure still toasts what was made, with its Undo); the dialog's A4 note (`containerNote(..., "Map")`, reserved slot) under the asset select in "existing" mode, from `useAssetKinds(can("assets.view"))`.
- [ ] Tests: menu lists per node type for a role with `assets.edit` and without; an accept-only role gets the toast with no Undo; mapped point Unmap -> confirmation text -> `DELETE` -> toast with Undo -> Undo `POST`s the read values.
- [ ] Update every test the A1 list names for DiscoveryPage and nodes; commit.

### Task 4: New asset from Discovery with the real form (A5)
**Files:** create `hooks/useCreateAsset.ts` (+ test), `components/graph/NewAssetDialog.tsx` (+ test); modify `pages/AssetsPage.tsx` (calls the hook; unchanged behaviour), `pages/DiscoveryPage.tsx`, `components/graph/nodes.tsx`, tests.
**Produces:** `useCreateAsset(): (body: AssetIn, registerKind: boolean) => Promise<Asset>` (POST, `toast.success("Asset created")`, then registers the kind when `registerKind && can("assets.kinds")`, else invalidates `keys.assets, keys.fleet`; the Discovery page also invalidates `keys.graph`).
- [ ] Failing tests: the POST body carries the `icon` the picker chose and the typed kind; a new kind is registered for `assets.kinds` and only noted for others; `AssetsPage.test.tsx` stays green with no edit.
- [ ] `NewAssetDialog` hosts `AssetForm` (title `New asset`, `initial={{ name, parent_id }}`, the note about cancelling); opened from: the pane menu (`New asset…`), an asset node (`New sub-asset…`), a group (name = label), an unmapped point (name = point name; menu only, no node button, as today). After a group or point: wait for the refetched graph to list the new asset, then open the Review on it (`{kind: "existing", assetId}`). Items are `aria-disabled` until the full asset list and the registry are loaded. A role without `assets.edit` is unchanged (Review's radio).
- [ ] Commit.

### Task 5: the "+" and the multi-point drop (A6, A7)
**Files:** `components/graph/nodes.tsx`, `pages/DiscoveryPage.tsx`, `lib/drop.ts` (+ test), a CSS block, tests.
- [ ] `dropPayloadForNodes(model, ids)` + tests (several points of one source -> one payload; two sources, a mapped point, a cluster in the set -> null); `onNodeDragStop` uses it when more than one node is dragged; the nodes are put back as for a single drop.
- [ ] The "+" handle on asset nodes as in Decision 10, `onConnectEnd` handler, the keyboard (Enter/Space on the focused "+"), the menu key reaches `New sub-asset…` through the existing menu; `isConnectableStart={false}` on every other handle; no change to the path highlight, drop-to-map or Alt-drag (their tests stay green).
- [ ] Check in a real browser at 1440 and 1024 with a `playwright-core` node script against the scratch stack: hover shows it, the drag opens the dialog with the parent set, a plain node drag still moves the node. Commit.

### Task 6: the end-to-end spec
**Files:** `frontend/e2e/w12a.spec.ts`, `frontend/e2e/playwright.config.ts` (project `w12a`).
- [ ] Own project (the run lists `w12a`). Cases: map a whole group to a Room by mistake (Review, container note visible), see `Mapped 6 points to Room 1. Undo`, move the group's mappings to the Panel from Discovery, unmap one metric from the asset page, Undo restores (values equal: read through the API), a viewer sees no action, the "+" creates a child with the real form and the icon chosen shows on the node, at 1440 and 1024; one role with `discovery.accept` but not `assets.edit` maps and gets a toast without Undo.
- [ ] e2e type check clean; commit.

### Task 7: docs and close-out
**Files:** `docs/screens.md`, `docs/sources-and-discovery.md`, `docs/assets-and-kinds.md`, `docs/roles-and-permissions.md` (if it lists page behaviours), `CHANGELOG.md`, `docs/superpowers/backlog.md` (next free section), the roadmap row, this plan's log.
- [ ] Docs, then the doc-reading backend tests (`tests/test_readme_ops.py tests/test_docs_links.py tests/test_field_debugging_doc.py`); then the gates and the merge order of RESUME.md (the controller does these, not an implementer).

## Review Focus (the plan review adds to it; each line has its test above)
1. No path leaves a mapping half-moved, and Undo re-creates exactly what was removed (scale, interval, custom unit; T1 tests).
2. Both permissions: `discovery.accept` alone maps and gets no Undo; `assets.edit` is needed for unmap, move, Undo, New asset, "+"; each route answers 403 on its own (T0, T3, e2e).
3. The confirmation never lies about billing (T1 sentence test).
4. `AssetForm` is reused and the icon chosen is the icon saved; the kind registration is kept (T4).
5. Keyboard and screen reader: menu key, focus order and return, one live region (the toast), a named "+", Escape closes the innermost layer (T1 to T5).
6. Late content moves nothing: the container note has a reserved slot; the node menu button adds no height; node layout constants still hold (T3).

## Execution log
(filled in by the controller)
