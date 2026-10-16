import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { rowAction } from "./shell";

// W12a (mapping actions: Undo right after mapping, unmap and move from Discovery and from the asset page, New asset from Discovery with the real form, the "+" on an asset
// node, several points dropped at once). Admin `admin` / `correct-horse`, the account the earlier projects use. It is the LAST project of the chain (it follows w11) and it
// works on mappings, assets and roles only.
//
// The data. The stack is shared and the earlier projects have mapped, scanned and removed things, so the spec READS what is left and does not assume more: it takes a
// group (a cluster of one source) in which no point is mapped, has at least three points and gives each point a different, non-custom metric, from an ENABLED source first
// (mapping to a disabled source would switch it on: accept does that, and an Undo leaves it). If no source offers one, beforeAll brings the Modbus simulator back the way
// w7t does (a scope on `simulator`, ports 9000 and 5020, one scan) and afterAll removes the source it brought back and the scope. It makes its own assets, a Room
// `W12a Room` and a Panel `W12a Panel`, both at the top of the Discovery column (sort order -100) so that neither lies under the minimap, and removes everything whose
// name starts with `W12a ` (and the accounts and roles `w12a-`) again, before it starts and when it ends. afterAll also compares every mapping of the chosen source (asset,
// metric, scale, interval, custom unit) with what beforeAll read: a case that left one behind fails the run there.
//
// The cases (1 to 3 depend on each other and run in order; the rest stand alone and set up and take down their own mappings through the API):
//   1  a group mapped to a Room by mistake, through its Map... button: the Review says `... is a room; meters usually belong to a Panel or Rack. Map here anyway?`, Create
//      mappings stays on, the toast reads `Mapped N points to W12a Room.` and has Undo. At 1440 x 900 and at 1024 x 640 (Cancel and Create mappings reachable, nothing over them).
//   2  Undo right after mapping takes the mappings off again (the API says so) and the Room stays.
//   3  Mapping actions for <group> -> Move this group's mappings... -> the Panel: every mapping is on the Panel, the toast has Undo, Undo puts them back on the Room.
//   4  the asset page: Actions for <metric> -> Unmap... asks (open months recalculated, closed months keep their figures), the row goes, the toast has Undo, Undo brings the row
//      back with the SAME scale, interval, custom unit, metric, point and asset (read through GET /api/mappings/{id} before and after; the id is new).
//   5  a read-only account sees none of it: no Mapping actions for, no Actions for <metric>, no +, no New asset... in the canvas menu, and the API refuses it.
//   6  discovery.accept without assets.edit maps through the Review and the toast has NO Undo; its New asset... on a group is still the Review's own choice.
//   7  the + on an asset node: New asset opens with the parent set, the kind and the icon picked are what the API holds and what the Assets Tree row shows; the drag from the +
//      to an empty spot opens the same form; the canvas menu's New asset... has no parent. At 1440 x 900 and 1024 x 640.
//   8  the keyboard: Tab from an asset node to the +, Enter opens the form, Escape closes it and the + has the focus again; Shift+F10 on a mapped group lists the mapping items
//      and Escape gives the focus back to the group.
//   9  two unmapped points of one source dropped on the Room together: ONE Review lists both, and creating maps both.
//   10 the Points page (not in the brief's list; the third place that unmaps): Unmap... on a row asks, the row says unmapped and has the focus, Undo maps it again with its values.
//   11 Ctrl+Z (the whole-wave review): an unmap made from a Discovery node is taken back by Control+Z alone (the focus on the node, then on the canvas), with the same scale,
//      interval and unit, the toast gone; inside a text field (the Find box) it is the field's own; a second press does nothing.
//   12 New asset... on a group (admin): the real form, and the Review that follows says `<name> was created. Cancel keeps it without any mappings.`
// Cases 2, 3, 4 and 10 also check that the focus is on something named after the toast's Undo (its button leaves with the toast), case 3 that the group's menu opens beside its
// button and closes on a second press, and case 7 that a line from the + let go on a node opens nothing, and Escape mid-drag takes the line away.
//
// Locators. Playwright matches a name by case-insensitive SUBSTRING: every lookup below is `exact: true` (or an anchored expression) where a second name could contain it
// (`Mapping actions for LVP02` is also the start of `Mapping actions for LVP02_kW`, `Map` starts `Mapping`, `Unmapped 6 points.` contains `mapped 6 points`). The Review is
// `Review mappings`, the form `New asset`, the confirmation of an unmap `Unmap "<name>" from <asset>?` (`Unmap the group "<key>" from <asset>?` for a group), the Move dialog
// `Move the group "<key>" to another asset` (`... "<key>" of "<source>" ...` when another source has a group of that name: see `groupWhat`).

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse" };

const ROOM = "W12a Room";
const PANEL = "W12a Panel";
const CHILD = "W12a Child";
const MADE = "W12a Made"; // the asset the group's New asset... makes (case 12); its own prefix, so that case 7's count of CHILD assets never sees it
const ODD_UNIT = "W12aU";

interface Account { username: string; password: string; role: string }
const READER_ROLE = "w12a-reader-role"; // discovery.view + assets.view
const READER: Account = { username: "w12a-reader", password: "w12a-reader-pass", role: READER_ROLE };
const ACCEPT_ROLE = "w12a-accept-role"; // discovery.view + discovery.accept + assets.view, and no assets.edit
const ACCEPTOR: Account = { username: "w12a-accept", password: "w12a-accept-pass", role: ACCEPT_ROLE };

interface Size { width: number; height: number }
const SIZES: Size[] = [{ width: 1440, height: 900 }, { width: 1024, height: 640 }];
const tag = (size: Size) => `${size.width} x ${size.height}`;

interface XY { x: number; y: number }
interface ApiSuggestion { metric: string; scale: number; interval_seconds: number; custom_unit: string | null }
interface ApiGraphPoint { id: number; name: string; mapping_id: number | null; asset_id: number | null; suggestion: ApiSuggestion }
interface ApiCluster { key: string; points: ApiGraphPoint[] }
interface ApiGraphSource { id: number; name: string; origin: "manual" | "discovered"; enabled: boolean; clusters: ApiCluster[] }
interface ApiGraph { sources: ApiGraphSource[]; assets: { id: number }[]; unidentified: unknown[] }
interface ApiAsset { id: number; parent_id: number | null; name: string; kind: string; icon?: string | null }
interface ApiKind { id: number; name: string }
interface ApiMapping { id: number; point_id: number; asset_id: number; metric: string; scale: number; interval_seconds: number; custom_unit: string | null }
interface ApiPointRow { id: number; mapping: Omit<ApiMapping, "point_id"> | null }
interface ApiSummary { metrics: { mapping_id: number; point_id: number; metric: string; unit: string }[] }
interface ApiScope { id: number; name: string }
interface ApiUser { id: number; username: string }
interface ApiRole { id: number; name: string; builtin: boolean }

/** The group the cases map: one cluster of one source, nothing mapped, each point with a metric of its own. */
interface TargetPoint { id: number; name: string; metric: string; scale: number; interval: number }
interface Target { sourceId: number; sourceName: string; key: string; points: TargetPoint[] }
/** Every point of a source with the stored values of its mapping (the id left out: an Undo makes a new one). */
type SourceMappings = { point: number; mapping: { asset_id: number; metric: string; scale: number; interval_seconds: number; custom_unit: string | null } | null }[];

let target: Target;
let room: ApiAsset;
let panel: ApiAsset;
let before: SourceMappings = [];
let brought: { scopeId: number; sourceIds: number[] } | null = null;

// ---------------------------------------------------------------------------------------------------------------------------------
// Requests

async function signInAs(page: Page, who: { username: string; password: string }): Promise<void> {
  const login = await page.request.post("/api/login", { data: { username: who.username, password: who.password } });
  expect(login.ok(), `signing in as ${who.username}: ${login.status()} ${await login.text()}`).toBe(true);
}

/** Runs `use` with the request context of a fresh browser context in which `who` is signed in. */
async function as<T>(browser: Browser, who: { username: string; password: string }, use: (request: APIRequestContext) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    const login = await context.request.post("/api/login", { data: { username: who.username, password: who.password } });
    expect(login.ok(), `${who.username} signs in: ${login.status()} ${await login.text()}`).toBe(true);
    return await use(context.request);
  } finally {
    await context.close();
  }
}
const asAdmin = <T>(browser: Browser, use: (request: APIRequestContext) => Promise<T>) => as(browser, ADMIN, use);

/** A page of its own in which `who` is signed in, closed again afterwards (the admin's page stays signed in as the admin). */
async function withUser(browser: Browser, who: Account, use: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 } });
  try {
    const login = await context.request.post("/api/login", { data: { username: who.username, password: who.password } });
    expect(login.ok(), `${who.username} signs in: ${login.status()} ${await login.text()}`).toBe(true);
    await use(await context.newPage());
  } finally {
    await context.close();
  }
}

async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}
const graphOf = (request: APIRequestContext) => json<ApiGraph>(request, "/api/discovery/graph");
const assetsOf = (request: APIRequestContext) => json<ApiAsset[]>(request, "/api/assets");

/** The group to map: from an enabled source first, no point mapped, three to twelve points, a different non-custom metric for each. */
function pickTarget(graph: ApiGraph): Target | null {
  const sources = [...graph.sources].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  for (const source of sources) {
    for (const cluster of source.clusters) {
      const metrics = cluster.points.map((p) => p.suggestion.metric);
      const fits = cluster.points.length >= 3 && cluster.points.length <= 12
        && cluster.points.every((p) => p.mapping_id === null && p.asset_id === null)
        && new Set(metrics).size === metrics.length && !metrics.includes("custom");
      if (fits) {
        return {
          sourceId: source.id, sourceName: source.name, key: cluster.key,
          points: cluster.points.map((p) => ({ id: p.id, name: p.name, metric: p.suggestion.metric, scale: p.suggestion.scale, interval: p.suggestion.interval_seconds })),
        };
      }
    }
  }
  return null;
}

async function makeAsset(request: APIRequestContext, name: string, kind: string): Promise<ApiAsset> {
  const made = await request.post("/api/assets", { data: { name, parent_id: null, kind, sort_order: -100 } });
  expect(made.status(), `creating the asset ${name}: ${await made.text()}`).toBe(201);
  return (await made.json()) as ApiAsset;
}
async function deleteAsset(request: APIRequestContext, id: number): Promise<void> {
  const gone = await request.delete(`/api/assets/${id}?confirm=true`);
  expect([200, 204, 404], `deleting the asset ${id}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
}

/** Maps one point to an asset through the route the page uses for an edit, with the point's own suggestion unless `over` says otherwise. */
async function mapOne(request: APIRequestContext, point: TargetPoint, assetId: number, over: Record<string, unknown> = {}): Promise<ApiMapping> {
  const made = await request.post("/api/mappings", {
    data: { point_id: point.id, asset_id: assetId, metric: point.metric, scale: point.scale, interval_seconds: point.interval, custom_unit: null, ...over },
  });
  expect(made.status(), `mapping ${point.name}: ${await made.text()}`).toBe(201);
  return (await made.json()) as ApiMapping;
}

/** The target group's points as the graph holds them now. */
async function targetPoints(request: APIRequestContext): Promise<ApiGraphPoint[]> {
  const source = (await graphOf(request)).sources.find((s) => s.id === target.sourceId);
  const cluster = source?.clusters.find((c) => c.key === target.key);
  expect(cluster, `the group ${target.key} of ${target.sourceName} is still in the graph`).toBeDefined();
  return cluster!.points;
}
/** Polls until every point of the target group is mapped to `assetId` (null: none is mapped at all). */
async function expectTargetOn(request: APIRequestContext, assetId: number | null, message: string): Promise<void> {
  await expect
    .poll(async () => (await targetPoints(request)).map((p) => [p.asset_id, p.mapping_id !== null]), { message })
    .toEqual(target.points.map(() => [assetId, assetId !== null]));
}
/** Takes every mapping of the target group off again (the cases that map leave the group as they found it, whatever happened). */
async function unmapTarget(request: APIRequestContext): Promise<void> {
  for (const p of await targetPoints(request)) {
    if (p.mapping_id === null) continue;
    const gone = await request.delete(`/api/mappings/${p.mapping_id}`);
    expect([204, 404], `unmapping ${p.name}: ${gone.status()}`).toContain(gone.status());
  }
}

/**
 * What a confirmation calls the target group: `the group "LVP01"`, and `the group "LVP01" of "sim"` when another source of the graph has a group of that name (the seed
 * has one LVP01 for each source), so that the words say which one is meant. The rule of `lib/mappedRefs.ts` `mappingsWhat`.
 */
async function groupWhat(request: APIRequestContext): Promise<string> {
  const shared = (await graphOf(request)).sources.some((s) => s.id !== target.sourceId && s.clusters.some((c) => c.key === target.key));
  return `the group "${target.key}"${shared ? ` of "${target.sourceName}"` : ""}`;
}

/** The stored values of a mapping that an Undo must bring back (the id left out: it is a new one). */
const valuesOf = (m: ApiMapping) => ({ point_id: m.point_id, asset_id: m.asset_id, metric: m.metric, scale: m.scale, interval_seconds: m.interval_seconds, custom_unit: m.custom_unit });
/** Polls until the target group's mappings are exactly `stored` (read through GET /api/mappings/{id}: the scale, interval and custom unit are not in the graph). */
async function expectTargetHolds(request: APIRequestContext, stored: ReturnType<typeof valuesOf>[], message: string): Promise<void> {
  const byPoint = (a: { point_id: number }, b: { point_id: number }) => a.point_id - b.point_id;
  await expect
    .poll(async () => {
      const mapped = (await targetPoints(request)).filter((p) => p.mapping_id !== null);
      const read = await Promise.all(mapped.map((p) => json<ApiMapping>(request, `/api/mappings/${p.mapping_id}`)));
      return read.map(valuesOf).sort(byPoint);
    }, { message })
    .toEqual([...stored].sort(byPoint));
}

async function sourceMappings(request: APIRequestContext, sourceId: number): Promise<SourceMappings> {
  const rows = await json<ApiPointRow[]>(request, `/api/sources/${sourceId}/points`);
  return rows
    .map((r) => ({
      point: r.id,
      mapping: r.mapping === null ? null : { asset_id: r.mapping.asset_id, metric: r.mapping.metric, scale: r.mapping.scale, interval_seconds: r.mapping.interval_seconds, custom_unit: r.mapping.custom_unit },
    }))
    .sort((a, b) => a.point - b.point);
}

/** Accounts first, then the roles they held, then the assets (newest first, so a child goes before its parent): everything this spec makes. */
async function removeLeftovers(request: APIRequestContext, failures: string[]): Promise<void> {
  const attempt = async (what: string, step: () => Promise<void>) => {
    try {
      await step();
    } catch (e) {
      failures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await attempt("the accounts", async () => {
    for (const user of (await json<ApiUser[]>(request, "/api/users")).filter((u) => u.username.startsWith("w12a-"))) {
      const gone = await request.delete(`/api/users/${user.id}`);
      expect([204, 404], `deleting ${user.username}: ${gone.status()}`).toContain(gone.status());
    }
  });
  await attempt("the roles", async () => {
    for (const role of (await json<ApiRole[]>(request, "/api/roles")).filter((r) => !r.builtin && r.name.startsWith("w12a-"))) {
      const gone = await request.delete(`/api/roles/${role.id}`);
      expect([204, 404], `deleting the role ${role.name}: ${gone.status()}`).toContain(gone.status());
    }
  });
  await attempt("the assets", async () => {
    for (const asset of (await assetsOf(request)).filter((a) => a.name.startsWith("W12a ")).sort((a, b) => b.id - a.id)) await deleteAsset(request, asset.id);
  });
}

/** Previews the scope and starts a scan with the host count and the digest the preview gave (what the page does), then waits until it has ended `done`. */
async function runScan(request: APIRequestContext, scopeId: number): Promise<void> {
  const preview = await json<{ hosts: number; digest: string }>(request, `/api/scopes/${scopeId}/preview`);
  const started = await request.post(`/api/scopes/${scopeId}/scan`, { data: { confirm_host_count: preview.hosts, digest: preview.digest } });
  expect(started.status(), `starting the scan: ${await started.text()}`).toBe(202);
  const scanId = ((await started.json()) as { scan_id: number }).scan_id;
  let last: { status: string; error: string | null } | undefined;
  await expect
    .poll(async () => {
      last = await json<{ status: string; error: string | null }>(request, `/api/scans/${scanId}`);
      return last.status === "done" || last.status === "failed";
    }, { timeout: 150_000, intervals: [500, 1000, 2000], message: `scan #${scanId} never ended` })
    .toBe(true);
  expect(last!.status, `scan #${scanId} ended ${last!.status}: ${last!.error}`).toBe("done");
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  await asAdmin(browser, async (request) => {
    const failures: string[] = [];
    await removeLeftovers(request, failures); // an earlier run that stopped half way
    expect(failures, "clearing the leftovers of an earlier run").toEqual([]);

    let graph = await graphOf(request);
    let picked = pickTarget(graph);
    if (picked === null) {
      // Every group is mapped or mixed: bring the Modbus simulator back (ten groups of six, nothing mapped) as w7t does, and take it away again in afterAll.
      const known = new Set(graph.sources.map((s) => s.id));
      const made = await request.post("/api/scopes", { data: { name: `W12a ${Date.now().toString(36)} sim`, targets: ["simulator"], ports: [9000, 5020] } });
      expect(made.status(), `creating the scope: ${await made.text()}`).toBe(201);
      const scope = (await made.json()) as ApiScope;
      brought = { scopeId: scope.id, sourceIds: [] };
      await runScan(request, scope.id);
      graph = await graphOf(request);
      brought.sourceIds = graph.sources.filter((s) => !known.has(s.id)).map((s) => s.id);
      picked = pickTarget(graph);
    }
    expect(picked, "a group with at least three points, none mapped and a different metric for each, in some source of the stack").not.toBeNull();
    target = picked!;
    before = await sourceMappings(request, target.sourceId);

    room = await makeAsset(request, ROOM, "Room");
    panel = await makeAsset(request, PANEL, "Panel");
    for (const [role, permissions, who] of [
      [READER_ROLE, ["discovery.view", "assets.view"], READER],
      [ACCEPT_ROLE, ["discovery.view", "discovery.accept", "assets.view"], ACCEPTOR],
    ] as const) {
      const madeRole = await request.post("/api/roles", { data: { name: role, description: "made by w12a.spec.ts", permissions } });
      expect(madeRole.status(), `creating the role ${role}: ${await madeRole.text()}`).toBe(201);
      const madeUser = await request.post("/api/users", { data: { username: who.username, password: who.password, role: who.role } });
      expect(madeUser.status(), `creating the account ${who.username}: ${await madeUser.text()}`).toBe(201);
    }
  });
});

test.afterAll(async ({ browser }) => {
  const failures: string[] = [];
  await asAdmin(browser, async (request) => {
    const attempt = async (what: string, step: () => Promise<void>) => {
      try {
        await step();
      } catch (e) {
        failures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    if (target) await attempt("the target group", () => unmapTarget(request));
    await removeLeftovers(request, failures);
    if (target) {
      await attempt("the mappings of the source", async () => {
        expect(await sourceMappings(request, target.sourceId), `every mapping of ${target.sourceName} is what it was before the spec`).toEqual(before);
      });
    }
    if (brought) {
      const { scopeId, sourceIds } = brought;
      await attempt("the source the scan brought back", async () => {
        if (sourceIds.length === 0) return;
        const removed = await request.post("/api/discovery/sources/remove", { data: { source_ids: sourceIds } });
        expect(removed.ok(), `removing the sources ${sourceIds.join(", ")}: ${removed.status()} ${await removed.text()}`).toBe(true);
      });
      await attempt("the scope", async () => {
        const gone = await request.delete(`/api/scopes/${scopeId}`);
        expect([204, 404], `deleting the scope: ${gone.status()}`).toContain(gone.status());
      });
    }
  });
  expect(failures, "the clean-up left something behind").toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The browser

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const toast = (page: Page, text: string) => page.locator(".toast-stack .toast").filter({ hasText: text });
const undoOf = (raised: Locator) => raised.getByRole("button", { name: "Undo", exact: true });
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const srcNode = (page: Page) => node(page, `src:${target.sourceId}`);
const clusterNode = (page: Page) => node(page, `cluster:${target.sourceId}:${target.key}`);
const pointNode = (page: Page, point: TargetPoint) => node(page, `point:${point.id}`);
const assetNode = (page: Page, asset: ApiAsset) => node(page, `asset:${asset.id}`);
const titleOf = (nodeEl: Locator) => nodeEl.locator(".node-title");
const addButton = (asset: Locator) => asset.getByRole("button", { name: `Add a sub-asset under ${ROOM}`, exact: true });
/** The + hides by opacity alone (so it stays focusable and in the accessibility tree), which Playwright counts as visible: what is drawn is the computed opacity. */
const plusOpacity = (plus: Locator) => plus.evaluate((el) => getComputedStyle(el).opacity);
const menuEl = (page: Page) => page.locator('.graph-menu[role="menu"]');
const reviewDialog = (page: Page) => page.getByRole("dialog", { name: "Review mappings", exact: true });
const formDialog = (page: Page) => page.getByRole("dialog", { name: "New asset", exact: true });
const canvasGroup = (page: Page) => page.getByRole("group", { name: "Discovery graph", exact: true });

const mappedText = (count: number, asset: string) => `Mapped ${count} point${count === 1 ? "" : "s"} to ${asset}.`;
const NOTE = `${ROOM} is a room; meters usually belong to a Panel or Rack. Map here anyway?`;

const centreOf = (box: { x: number; y: number; width: number; height: number }): XY => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
async function boxOf(locator: Locator, what: string) {
  const box = await locator.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  return box!;
}
/** The distance between the nearest edges of two boxes (0 when they touch or overlap). */
function gapBetween(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
  const dx = Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width));
  const dy = Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height));
  return Math.hypot(dx, dy);
}
const frames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** Resolves once `locator` has stopped moving: React Flow animates the viewport, and boxes taken mid-animation are stale. */
async function stopped(locator: Locator): Promise<void> {
  let previous = "";
  await expect.poll(async () => {
    const now = JSON.stringify(await locator.boundingBox());
    const same = now !== "null" && now === previous;
    previous = now;
    return same;
  }, { intervals: [150], message: "never stopped moving" }).toBe(true);
}
/** The "fit view" control; the nodes are small, so re-fit whenever the layout changed. */
async function fitView(page: Page, anchor: Locator): Promise<void> {
  await page.getByRole("button", { name: "fit view" }).click();
  await stopped(anchor);
}
/** Re-fit when `locator` is not fully inside the canvas (a node that is off-screen cannot be clicked or dragged). */
async function ensureOnCanvas(page: Page, locator: Locator): Promise<void> {
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  const box = await locator.boundingBox();
  const inside = box !== null && box.x >= pane.x && box.y >= pane.y && box.x + box.width <= pane.x + pane.width && box.y + box.height <= pane.y + pane.height;
  if (!inside) await fitView(page, locator);
}

/**
 * Opens Discovery and fits the view. The graph is as tall as the stack's assets (64 px each; the fit will not zoom out past 0.5), so the window is made tall enough first
 * (the page is exactly one window tall, so the canvas follows; the width stays what the case set) with room for one source's groups. A dialog case then measures at the
 * real size with `expectReachable`.
 */
async function openDiscovery(page: Page): Promise<void> {
  const graph = await graphOf(page.request);
  const rows = Math.max(graph.assets.length * 64, graph.sources.length * 176 + graph.unidentified.length * 64 + 1400);
  const need = Math.ceil(rows * 0.5 * 1.3 + 350);
  const view = page.viewportSize()!;
  if (need > view.height) await page.setViewportSize({ width: view.width, height: Math.min(need, 12_000) });
  await page.goto("/discovery");
  await expect(heading1(page, "Discovery")).toBeVisible();
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
  await stopped(page.locator(".react-flow__node").first());
  await fitView(page, page.locator(".react-flow__node").first());
}
/** Opens the target's source so that its groups are drawn, then fits the view (the new nodes may lie outside it). */
async function expandSource(page: Page): Promise<void> {
  await ensureOnCanvas(page, srcNode(page));
  await srcNode(page).getByRole("button", { name: `Expand ${target.sourceName}`, exact: true }).click();
  await expect(clusterNode(page)).toBeVisible();
  await stopped(srcNode(page)); // a source's own + pans the camera for 300 ms; let it finish, or it could start after the fit below and win
  await fitView(page, srcNode(page));
}
/** Opens the target group so that its points are drawn, then fits the view. */
async function expandGroup(page: Page): Promise<void> {
  await ensureOnCanvas(page, clusterNode(page));
  await clusterNode(page).getByRole("button", { name: `Expand ${target.key}`, exact: true }).click();
  await expect(pointNode(page, target.points[0])).toBeVisible();
  await fitView(page, srcNode(page));
}
async function openOnGroup(page: Page): Promise<void> {
  await openDiscovery(page);
  await expandSource(page);
}

/** The d3-drag path: real intermediate moves (locator.dragTo is not enough). */
async function dragPath(page: Page, from: XY, to: XY): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 6, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 25 });
  await page.mouse.up();
}
/** Drags the middle of `handle` onto the middle of `onto`. */
async function dragOnto(page: Page, handle: Locator, onto: Locator): Promise<void> {
  await stopped(handle);
  await stopped(onto);
  await dragPath(page, centreOf(await boxOf(handle, "the drag handle")), centreOf(await boxOf(onto, "the drop target")));
}
/** A spot on the empty canvas: the pane itself is the element under the point, and also under the four points 16 px around it. */
async function emptySpot(page: Page): Promise<XY> {
  const spot = await page.evaluate(() => {
    const pane = document.querySelector(".react-flow__pane");
    if (!pane) return null;
    const r = pane.getBoundingClientRect();
    const isPane = (x: number, y: number) => document.elementFromPoint(x, y)?.classList.contains("react-flow__pane") ?? false;
    const clear = (x: number, y: number) => [[0, 0], [16, 0], [-16, 0], [0, 16], [0, -16]].every(([dx, dy]) => isPane(x + dx, y + dy));
    for (let y = r.bottom - 60; y > r.top + 60; y -= 24) {
      for (let x = r.left + 120; x < r.right - 120; x += 24) if (clear(x, y)) return { x, y };
    }
    return null;
  });
  if (!spot) throw new Error("the canvas has no empty spot to point at");
  return spot;
}

/**
 * The window at `size` with a dialog open: each control can be scrolled into the window (a dialog taller than the window scrolls inside itself) and nothing covers it
 * once it is there (the element at its centre is the control). The window goes back to what it was afterwards.
 */
async function expectReachable(page: Page, size: Size, controls: [string, Locator][]): Promise<void> {
  const was = page.viewportSize()!;
  await page.setViewportSize(size);
  try {
    await frames(page);
    for (const [what, control] of controls) {
      await control.scrollIntoViewIfNeeded();
      const box = await boxOf(control, what);
      expect(box.x, `${what}: left edge in the window at ${tag(size)}`).toBeGreaterThanOrEqual(0);
      expect(box.y, `${what}: top edge in the window at ${tag(size)}`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${what}: right edge in the window at ${tag(size)}`).toBeLessThanOrEqual(size.width);
      expect(box.y + box.height, `${what}: bottom edge in the window at ${tag(size)}`).toBeLessThanOrEqual(size.height);
      const covered = await control.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !(top && (top === el || el.contains(top)));
      });
      expect(covered, `${what} is not covered by anything at ${tag(size)}`).toBe(false);
    }
  } finally {
    await page.setViewportSize(was);
    await frames(page);
  }
}

/** The group's Map... button, then the Review with the Room chosen in it. */
async function reviewForRoom(page: Page): Promise<Locator> {
  const cluster = clusterNode(page);
  await ensureOnCanvas(page, cluster);
  await cluster.getByRole("button", { name: `Map ${target.key} to asset…`, exact: true }).click();
  const review = reviewDialog(page);
  await expect(review).toBeVisible();
  await expect(review.getByRole("checkbox"), "one row for each point of the group").toHaveCount(target.points.length);
  await review.getByLabel("Asset", { exact: true }).selectOption(String(room.id));
  return review;
}
/** Maps the whole group to the Room through the Review; returns the toast it raises. */
async function mapGroupToRoom(page: Page): Promise<Locator> {
  const review = await reviewForRoom(page);
  await review.getByRole("button", { name: "Create mappings", exact: true }).click();
  await expect(review).toBeHidden();
  const raised = toast(page, mappedText(target.points.length, ROOM));
  await expect(raised).toBeVisible();
  return raised;
}

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W12a: mapping from Discovery, and taking it back", () => {
  test.describe.configure({ mode: "serial" }); // 2 and 3 map a group again the way 1 did; a failure in 1 says more than three failures

  for (const size of SIZES) {
    test(`1 a group mapped to a Room by mistake: the note shows, nothing blocks, the toast says what was done and offers Undo (${tag(size)})`, async ({ page }) => {
      test.setTimeout(240_000);
      test.info().annotations.push({ type: "group", description: `${target.key} of ${target.sourceName} (${target.points.length} points)` }); // which group was mapped
      await page.setViewportSize(size);
      await signInAs(page, ADMIN);
      try {
        await openOnGroup(page);
        const review = await reviewForRoom(page);

        await test.step("the Room is a place, so the Review says so and still lets the mappings be made", async () => {
          await expect(review.getByText(NOTE, { exact: true })).toBeVisible();
          for (const box of await review.getByRole("checkbox").all()) await expect(box).toBeChecked();
          await expect(review.getByRole("button", { name: "Create mappings", exact: true })).toBeEnabled();
        });
        await test.step(`Cancel and Create mappings can be reached and nothing is over them at ${tag(size)}`, async () => {
          await expectReachable(page, size, [
            ["Cancel", review.getByRole("button", { name: "Cancel", exact: true })],
            ["Create mappings", review.getByRole("button", { name: "Create mappings", exact: true })],
          ]);
        });
        await test.step("Create mappings: the toast has the count, the Room and an Undo, and the API holds every mapping on the Room", async () => {
          await review.getByRole("button", { name: "Create mappings", exact: true }).click();
          await expect(review).toBeHidden();
          const raised = toast(page, mappedText(target.points.length, ROOM));
          await expect(raised).toBeVisible();
          await expect(undoOf(raised)).toBeVisible();
          await expectTargetOn(page.request, room.id, "every point of the group is mapped to the Room");
        });
      } finally {
        await unmapTarget(page.request);
      }
    });
  }

  test("2 Undo right after mapping takes the mappings off again, and the Room stays", async ({ page }) => {
    test.setTimeout(240_000);
    await signInAs(page, ADMIN);
    try {
      await openOnGroup(page);
      const raised = await mapGroupToRoom(page);
      await expectTargetOn(page.request, room.id, "mapped to the Room");
      await undoOf(raised).click();
      const undone = toast(page, `Unmapped ${target.points.length} points.`);
      await expect(undone).toBeVisible();
      await expect(undone, "the asset existed before, so nothing is said about it staying").not.toContainText("stays");
      await expectTargetOn(page.request, null, "Undo took every mapping off");
      expect((await assetsOf(page.request)).some((a) => a.id === room.id), "the Room is still there").toBe(true);
      // The Undo's button left with its toast: the focus must be on something named (the graph), not on the page body.
      await expect(canvasGroup(page), "after the Undo the focus is on the Discovery graph").toBeFocused();
    } finally {
      await unmapTarget(page.request);
    }
  });

  test("3 the group's mappings move to the Panel from the group's own menu, and Undo puts them back on the Room", async ({ page }) => {
    test.setTimeout(240_000);
    await signInAs(page, ADMIN);
    try {
      await openOnGroup(page);
      await mapGroupToRoom(page);
      await expectTargetOn(page.request, room.id, "mapped to the Room");

      const cluster = clusterNode(page);
      await test.step("Mapping actions for <group> opens the group's menu beside its button with the mapping items; a second press on the button closes it", async () => {
        const button = cluster.getByRole("button", { name: `Mapping actions for ${target.key}`, exact: true });
        const menu = menuEl(page);
        await button.click();
        await expect(menu).toBeVisible();
        // Next to the button the mouse is on, not on the far side of the node (the node is wider than that).
        const gap = gapBetween(await boxOf(button, "the node's menu button"), await boxOf(menu, "the menu"));
        expect(gap, "the menu opens within 120 px of the button that opened it").toBeLessThanOrEqual(120);
        await expect(menu.getByRole("menuitem", { name: "Unmap this group…", exact: true })).toHaveCount(1);

        await button.click();
        await expect(menu, "a second press on the button closes the menu and does not open it again").toBeHidden();
        await button.click();
        await expect(menu, "and a third press opens it once more").toBeVisible();
        await menu.getByRole("menuitem", { name: "Move this group's mappings…", exact: true }).click();
      });

      // A group label that more than one source has names its source: `Move the group "LVP01" of "sim" to another asset`.
      const move = page.getByRole("dialog", { name: `Move ${await groupWhat(page.request)} to another asset`, exact: true });
      await test.step("the Move dialog: the billing sentence, no move to where they are, the Panel is a choice and no note comes with it", async () => {
        await expect(move).toBeVisible();
        await expect(move).toContainText("Billing for months that are still open is recalculated with them under the asset you choose; closed months keep their billed figures.");
        const choice = move.getByLabel("Move to", { exact: true });
        await expect(choice.locator("option", { hasText: ROOM }), "the Room is where they are: not offered").toHaveCount(0);
        await expect(choice.locator("option", { hasText: PANEL })).toHaveCount(1);
        await choice.selectOption(String(panel.id));
        await expect(move.locator(".mapmove-slot"), "a Panel is where meters belong: no note").toHaveText("");
        await move.getByRole("button", { name: "Move", exact: true }).click();
        await expect(move).toBeHidden();
      });

      const moved = toast(page, `Moved ${target.points.length} points to ${PANEL}.`);
      await test.step("every mapping is on the Panel, the toast has Undo and the focus is on the group", async () => {
        await expect(moved).toBeVisible();
        await expectTargetOn(page.request, panel.id, "every mapping moved to the Panel");
        await expect(cluster, "the focus goes to the node the action was about").toBeFocused();
      });
      await test.step("Undo puts them back on the Room", async () => {
        await undoOf(moved).click();
        await expect(toast(page, `Put back ${target.points.length} mappings.`)).toBeVisible();
        await expectTargetOn(page.request, room.id, "every mapping is on the Room again");
        await expect(cluster, "the Undo's button left with its toast: the focus is back on the group, not on the body").toBeFocused();
      });
    } finally {
      await unmapTarget(page.request);
    }
  });
});

test("4 one metric unmapped from the asset page: it asks, the row goes, Undo brings back the same mapping", async ({ page }) => {
  test.setTimeout(240_000);
  await signInAs(page, ADMIN);
  const request = page.request;
  const [odd, plain] = target.points;
  const oddLabel = `Actions for custom (${ODD_UNIT})`;
  const plainLabel = `Actions for ${plain.metric}`;
  try {
    // A mapping with every value off its default, so that an Undo which posted the defaults instead would be caught.
    const oddMade = await mapOne(request, odd, panel.id, { metric: "custom", custom_unit: ODD_UNIT, scale: 0.001, interval_seconds: 7 });
    await mapOne(request, plain, panel.id);
    const stored = await json<ApiMapping>(request, `/api/mappings/${oddMade.id}`);
    expect(stored, "the values the mapping was made with").toMatchObject({ metric: "custom", scale: 0.001, interval_seconds: 7, custom_unit: ODD_UNIT });

    await page.goto(`/assets/${panel.id}`);
    await expect(heading1(page, PANEL)).toBeVisible();
    await expect(page.locator(".metrics-table tbody tr")).toHaveCount(2);
    const trigger = page.getByRole("button", { name: oddLabel, exact: true });

    await test.step("the row's menu has Unmap... and Move to another asset...", async () => {
      await trigger.click();
      const menu = page.getByRole("menu", { name: oddLabel, exact: true });
      await expect(menu.getByRole("menuitem")).toHaveText(["Unmap…", "Move to another asset…"]);
      await menu.getByRole("menuitem", { name: "Unmap…", exact: true }).click();
    });
    await test.step("the confirmation says what happens to billing: open months are recalculated, closed months keep their figures", async () => {
      const ask = page.getByRole("dialog", { name: `Unmap "custom (${ODD_UNIT})" from ${PANEL}?`, exact: true });
      await expect(ask).toBeVisible();
      await expect(ask).toContainText("Billing for months that are still open is recalculated without it; closed months keep their billed figures.");
      await expect(ask).toContainText("Charts and dashboards show the asset without this point.");
      await ask.getByRole("button", { name: "Unmap", exact: true }).click();
      await expect(ask).toBeHidden();
    });

    const unmapped = toast(page, `Unmapped 1 point from ${PANEL}.`);
    await test.step("the row is gone, the mapping too, and the focus is on the row that is left", async () => {
      await expect(unmapped).toBeVisible();
      await expect(trigger, "the row is gone").toHaveCount(0);
      expect((await request.get(`/api/mappings/${oddMade.id}`)).status(), "the mapping is gone").toBe(404);
      await expect(page.getByRole("button", { name: plainLabel, exact: true }), "the focus lands on a row of the table").toBeFocused();
    });
    await test.step("the Trend chart follows: it shows the metric that is left and the server is not asked for the one that went (no 'no such metric' line)", async () => {
      const metricPicker = page.getByRole("region", { name: "Trend", exact: true }).getByRole("combobox", { name: "Metric", exact: true });
      await expect(metricPicker, "the Trend's Metric is the one metric left").toHaveValue(plain.metric);
      await expect(page.getByText("this asset has no such metric"), "no error about the unmapped metric").toHaveCount(0);
    });
    await test.step("Undo brings the row back, and the mapping holds the same values (a new id)", async () => {
      await undoOf(unmapped).click();
      await expect(toast(page, "Put back 1 mapping.")).toBeVisible();
      await expect(trigger, "the row is back").toBeVisible();
      // The Undo's button left with its toast: the focus is on a row's menu button (the restored row's place) or the Metrics heading, never the body.
      await expect(page.locator(".metrics-table .row-menu-btn:focus, #metrics-heading:focus"), "the focus is on the table or its heading after the Undo").toHaveCount(1);
      const back =(await json<ApiSummary>(request, `/api/assets/${panel.id}/summary`)).metrics.find((m) => m.metric === "custom");
      expect(back, "the custom row is in the summary again").toBeDefined();
      const after = await json<ApiMapping>(request, `/api/mappings/${back!.mapping_id}`);
      expect(after.id, "the mapping is a new one").not.toBe(stored.id);
      const values = (m: ApiMapping) => ({ point_id: m.point_id, asset_id: m.asset_id, metric: m.metric, scale: m.scale, interval_seconds: m.interval_seconds, custom_unit: m.custom_unit });
      expect(values(after), "scale, interval, custom unit, metric, point and asset are what they were").toEqual(values(stored));
    });
  } finally {
    await unmapTarget(request);
  }
});

test("5 a read-only account sees no mapping action: no menu button on a node or a row, no +, no New asset... in the canvas menu, and the API says 403", async ({ browser, page }) => {
  test.setTimeout(240_000);
  await signInAs(page, ADMIN);
  const request = page.request;
  const [a, b] = target.points;
  try {
    const made = [await mapOne(request, a, panel.id), await mapOne(request, b, panel.id)];
    await withUser(browser, READER, async (reader) => {
      await test.step("Discovery: something is mapped and there is an asset to add under, and none of the actions is there", async () => {
        await openOnGroup(reader);
        await expect(clusterNode(reader), "a group with something mapped").toContainText("2 mapped");
        await expect(assetNode(reader, panel), "an asset (an editor gets a + on it)").toBeVisible();
        await expect(reader.getByRole("button", { name: /^Mapping actions for / })).toHaveCount(0);
        await expect(reader.getByRole("button", { name: /^Add a sub-asset under / })).toHaveCount(0);
      });
      await test.step("the canvas menu has the canvas actions and no New asset...; the group's menu has no Unmap and no Move", async () => {
        const at = await emptySpot(reader);
        await reader.mouse.click(at.x, at.y, { button: "right" });
        const menu = menuEl(reader);
        await expect(menu).toBeVisible();
        // W12b: a prefix, not the exact name (an item that cannot run carries its reason as a second line of its name), and "Expand selection" does not start with it.
        await expect(menu.getByRole("menuitem", { name: /^Expand all/ })).toHaveCount(1);
        await expect(menu.getByRole("menuitem", { name: /^New asset/ })).toHaveCount(0);
        await reader.keyboard.press("Escape");
        await expect(menu).toBeHidden();

        await clusterNode(reader).focus();
        await reader.keyboard.press("Shift+F10");
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("menuitem").first()).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: /^(Unmap|Move)/ })).toHaveCount(0);
        await expect(menu.getByRole("menuitem", { name: /^New asset/ })).toHaveCount(0);
        await reader.keyboard.press("Escape");
        await expect(menu).toBeHidden();
      });
      await test.step("the asset page lists the metrics and no row has a menu", async () => {
        await reader.goto(`/assets/${panel.id}`);
        await expect(heading1(reader, PANEL)).toBeVisible();
        await expect(reader.locator(".metrics-table tbody tr")).toHaveCount(2);
        await expect(reader.locator(".metrics-table").getByRole("button"), "no Actions for <metric>").toHaveCount(0);
        await expect(reader.locator(".metrics-table thead th"), "the four columns of a reader").toHaveCount(4);
      });
      await test.step("the API refuses what the page does not offer", async () => {
        expect((await reader.request.get(`/api/mappings/${made[0].id}`)).status(), "reading a mapping").toBe(403);
        expect((await reader.request.delete(`/api/mappings/${made[0].id}`)).status(), "deleting one").toBe(403);
        expect((await reader.request.patch(`/api/mappings/${made[0].id}`, { data: { asset_id: room.id } })).status(), "moving one").toBe(403);
      });
    });
    expect((await request.get(`/api/mappings/${made[0].id}`)).status(), "the mapping is untouched").toBe(200);
  } finally {
    await unmapTarget(request);
  }
});

test("6 discovery.accept without assets.edit maps through the Review and gets a toast with no Undo; its New asset... is the Review's own choice, not the form", async ({ browser, page }) => {
  test.setTimeout(240_000);
  await signInAs(page, ADMIN);
  try {
    await withUser(browser, ACCEPTOR, async (acceptor) => {
      await openOnGroup(acceptor);
      const cluster = clusterNode(acceptor);
      await ensureOnCanvas(acceptor, cluster);

      await test.step("New asset... on the group opens the Review with its New asset choice, not the asset form", async () => {
        await cluster.getByRole("button", { name: `New asset from ${target.key}…`, exact: true }).click();
        const review = reviewDialog(acceptor);
        await expect(review).toBeVisible();
        await expect(review.getByLabel("New asset name")).toHaveValue(target.key);
        await expect(formDialog(acceptor)).toHaveCount(0);
        await review.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(review).toBeHidden();
      });
      await test.step("Map... to the Room: the toast says what was done and has no Undo", async () => {
        await cluster.getByRole("button", { name: `Map ${target.key} to asset…`, exact: true }).click();
        const review = reviewDialog(acceptor);
        await expect(review).toBeVisible();
        await review.getByLabel("Asset", { exact: true }).selectOption(String(room.id));
        await review.getByRole("button", { name: "Create mappings", exact: true }).click();
        await expect(review).toBeHidden();
        const raised = toast(acceptor, mappedText(target.points.length, ROOM));
        await expect(raised).toBeVisible();
        await expect(undoOf(raised), "no Undo: it needs assets.edit").toHaveCount(0);
        await expect(acceptor.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
      });
      await test.step("and no unmap or move of its own either", async () => {
        await expect(cluster).toContainText(`${target.points.length} mapped`);
        await expect(acceptor.getByRole("button", { name: /^Mapping actions for / })).toHaveCount(0);
      });
    });
    await expectTargetOn(page.request, room.id, "the accepting account mapped the group");
  } finally {
    await unmapTarget(page.request);
  }
});

for (const size of SIZES) {
  test(`7 the + on an asset node makes a child with the real form: parent set, kind and icon saved; the drag from the + opens the same form (${tag(size)})`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize(size);
    await signInAs(page, ADMIN);
    const request = page.request;
    const name = `${CHILD} ${size.width}`;
    const kinds = await json<ApiKind[]>(request, "/api/asset-kinds");
    const kindName = kinds.find((k) => k.name.toLowerCase() === "rack")?.name ?? kinds[0]?.name ?? null; // null: an empty registry, the form starts on generic
    let childId: number | null = null;
    try {
      await openDiscovery(page);
      const asset = assetNode(page, room);
      await ensureOnCanvas(page, asset);
      const away = await emptySpot(page);
      await page.mouse.move(away.x, away.y);
      const plus = addButton(asset);
      await expect.poll(() => plusOpacity(plus), { message: "the + is not drawn until the node is hovered" }).toBe("0");
      await asset.hover();
      await expect.poll(() => plusOpacity(plus), { message: "the + shows when the node is hovered" }).toBe("1");
      await plus.click();

      const form = formDialog(page);
      const save = form.getByRole("button", { name: "Save", exact: true });
      const cancel = form.getByRole("button", { name: "Cancel", exact: true });
      const field = form.getByRole("group", { name: "Icon", exact: true });
      const grid = field.getByRole("radiogroup", { name: "Icon choices", exact: true });
      let serverHtml = "";
      await test.step("the real form opens with the Room as the parent; a name, a kind and an icon are chosen", async () => {
        await expect(form).toBeVisible();
        await expect(form.getByLabel(/^Parent/), "the asset the + belongs to is the parent").toHaveValue(String(room.id));
        await form.getByLabel("Name", { exact: true }).fill(name);
        if (kindName !== null) await form.getByLabel(/^Kind/).selectOption({ label: kindName });
        await field.getByRole("button", { name: "Change icon", exact: true }).click();
        const cell = grid.getByTitle("Server", { exact: true });
        await cell.click();
        await expect(grid.getByRole("radio", { name: "Server", exact: true })).toBeChecked();
        serverHtml = await cell.locator("svg").innerHTML();
      });
      await test.step(`Cancel and Save can be reached and nothing is over them at ${tag(size)}`, async () => {
        await expectReachable(page, size, [["Cancel", cancel], ["Save", save]]);
      });
      await test.step("Save makes the asset (the toast is the Assets page's) and the dialog goes", async () => {
        await save.click();
        await expect(form).toBeHidden();
        await expect(toast(page, "Asset created")).toBeVisible();
      });
      await test.step("the API holds the child under the Room with the kind and the icon that were picked", async () => {
        const child = (await assetsOf(request)).find((a) => a.name === name);
        expect(child, `the asset ${name} was created`).toBeDefined();
        childId = child!.id;
        expect(child!.parent_id).toBe(room.id);
        expect(child!.icon, "the icon id the picker chose").toBe("server");
        expect(child!.kind.toLowerCase()).toBe((kindName ?? "generic").toLowerCase());
      });

      await test.step("the drag from the + to an empty spot opens the same form, with the same parent", async () => {
        await ensureOnCanvas(page, asset);
        await asset.hover();
        await expect.poll(() => plusOpacity(plus), { message: "the + shows when the node is hovered" }).toBe("1");
        const from = centreOf(await boxOf(plus, "the +"));
        await dragPath(page, from, await emptySpot(page));
        await expect(form).toBeVisible();
        await expect(form.getByLabel(/^Parent/)).toHaveValue(String(room.id));
        await cancel.click();
        await expect(form).toBeHidden();
        expect((await assetsOf(request)).filter((a) => a.name.startsWith(CHILD)), "cancelling made nothing").toHaveLength(1);
      });
      await test.step("a line from the + let go on another asset or back on its own node opens nothing and makes no edge", async () => {
        const edges = page.locator(".react-flow__edge");
        // The library draws every node INSIDE the canvas pane, so a release on a node is not a release on the empty canvas.
        for (const [what, onto] of [["another asset", assetNode(page, panel)], ["its own node", asset]] as const) {
          await ensureOnCanvas(page, asset);
          await ensureOnCanvas(page, assetNode(page, panel));
          await asset.hover();
          await expect.poll(() => plusOpacity(plus), { message: "the + shows when the node is hovered" }).toBe("1");
          await stopped(onto);
          const count = await edges.count();
          await dragPath(page, centreOf(await boxOf(plus, "the +")), centreOf(await boxOf(onto, what)));
          await frames(page);
          await page.waitForTimeout(500); // a dialog would open after the paint that follows the release
          await expect(page.getByRole("dialog"), `a line let go on ${what} opens no dialog`).toHaveCount(0);
          expect(await edges.count(), `a line let go on ${what} makes no edge`).toBe(count);
          await expect(page.locator(".gconnect"), "and the line is gone").toHaveCount(0);
        }
      });
      await test.step("the canvas menu's New asset... opens the form with no parent", async () => {
        const at = await emptySpot(page);
        await page.mouse.click(at.x, at.y, { button: "right" });
        await menuEl(page).getByRole("menuitem", { name: "New asset…", exact: true }).click();
        await expect(form).toBeVisible();
        await expect(form.getByLabel(/^Parent/)).toHaveValue("");
        await cancel.click();
        await expect(form).toBeHidden();
      });

      await test.step("the Assets Tree row and the page header draw the icon that was picked", async () => {
        await page.goto(`/assets/${childId}`);
        await expect(heading1(page, name)).toBeVisible();
        const row = page.getByRole("region", { name: "Asset tree" }).locator(".node").filter({ has: page.getByRole("link", { name, exact: true }) });
        await expect.poll(() => row.locator(".node-icon svg").innerHTML(), { message: "the tree row" }).toBe(serverHtml);
        await expect.poll(() => page.locator(".page-head .page-tile svg").innerHTML(), { message: "the header tile" }).toBe(serverHtml);
      });
    } finally {
      for (const a of (await assetsOf(request)).filter((x) => x.name.startsWith(CHILD))) await deleteAsset(request, a.id);
    }
  });
}

test("8 the keyboard: Tab from an asset node to the +, Enter opens the form, Escape gives the + the focus back; Shift+F10 on a mapped group lists the mapping items", async ({ page }) => {
  test.setTimeout(240_000);
  await signInAs(page, ADMIN);
  const request = page.request;
  try {
    await mapOne(request, target.points[0], panel.id);
    await mapOne(request, target.points[1], panel.id);
    await openOnGroup(page);

    await test.step("Tab from the Room node reaches the +, Enter opens New asset under the Room, Escape closes it and the + has the focus again", async () => {
      const asset = assetNode(page, room);
      await ensureOnCanvas(page, asset);
      await asset.focus();
      await page.keyboard.press("Tab");
      const plus = addButton(asset);
      await expect(plus, "the next stop after the node is the +").toBeFocused();
      await expect.poll(() => plusOpacity(plus), { message: "the + is drawn while it holds the focus" }).toBe("1");
      await page.keyboard.press("Enter");
      const form = formDialog(page);
      await expect(form).toBeVisible();
      await expect(form.getByLabel(/^Parent/)).toHaveValue(String(room.id));
      await page.keyboard.press("Escape");
      await expect(form).toBeHidden();
      await expect(plus, "the focus is back where the form was asked for").toBeFocused();
      await expect.poll(() => plusOpacity(plus), { message: "and the + is drawn again, with the focus ring on it" }).toBe("1");
      expect((await assetsOf(request)).filter((a) => a.name.startsWith(CHILD)), "Escape made nothing").toHaveLength(0);
    });
    await test.step("Shift+F10 on the group: the menu lists the mapping items, Escape returns the focus to the group", async () => {
      const cluster = clusterNode(page);
      await ensureOnCanvas(page, cluster);
      await cluster.focus();
      await page.keyboard.press("Shift+F10");
      const menu = menuEl(page);
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Unmap this group…", exact: true })).toHaveCount(1);
      await expect(menu.getByRole("menuitem", { name: "Move this group's mappings…", exact: true })).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(cluster).toBeFocused();
    });
  } finally {
    await unmapTarget(request);
  }
});

test("9 two unmapped points of one source picked together and dropped on the Room give ONE Review that lists both, and creating maps both", async ({ page }) => {
  test.setTimeout(240_000);
  await signInAs(page, ADMIN);
  const request = page.request;
  const [one, two] = target.points;
  try {
    await openOnGroup(page);
    await expandGroup(page);

    await titleOf(pointNode(page, one)).click();
    await titleOf(pointNode(page, two)).click({ modifiers: ["ControlOrMeta"] });
    await expect(page.locator(".react-flow__node.selected"), "both points are picked").toHaveCount(2);

    await ensureOnCanvas(page, assetNode(page, room));
    await dragOnto(page, titleOf(pointNode(page, one)), assetNode(page, room));
    const review = reviewDialog(page);
    await expect(review, "one Review, not two").toBeVisible();
    await expect(review).toContainText(`2 unmapped points from ${target.sourceName}`);
    await expect(review.getByRole("checkbox")).toHaveCount(2);
    await expect(review.getByRole("checkbox", { name: `Map ${one.name}`, exact: true })).toBeChecked();
    await expect(review.getByRole("checkbox", { name: `Map ${two.name}`, exact: true })).toBeChecked();
    await expect(review.getByLabel("Asset", { exact: true }), "the Room it was dropped on is chosen").toHaveValue(String(room.id));

    await review.getByRole("button", { name: "Create mappings", exact: true }).click();
    await expect(review).toBeHidden();
    await expect(toast(page, mappedText(2, ROOM))).toBeVisible();
    await expect
      .poll(async () => (await targetPoints(request)).filter((p) => p.asset_id === room.id).map((p) => p.id).sort((x, y) => x - y), { message: "exactly the two points are on the Room" })
      .toEqual([one.id, two.id].sort((x, y) => x - y));
  } finally {
    await unmapTarget(request);
  }
});

test("10 the Points page: Unmap… on a row asks, the row says unmapped and holds the focus, Undo maps it again with its values", async ({ page }) => {
  test.setTimeout(180_000);
  await signInAs(page, ADMIN);
  const request = page.request;
  const point = target.points[0];
  try {
    const made = await mapOne(request, point, panel.id, { scale: 0.5, interval_seconds: 9 });
    await page.goto(`/sources/${target.sourceId}/points`);
    await expect(page.getByRole("heading", { name: "Points", exact: true })).toBeVisible();
    const row = page.locator(`tr[data-point="${point.id}"]`);
    await expect(row, "the row says where the point is mapped").toContainText(PANEL);
    await expect(row).toContainText("every 9s");

    await (await rowAction(page, row, "Unmap…")).click();
    const ask = page.getByRole("dialog", { name: `Unmap "${point.name}" from ${PANEL}?`, exact: true });
    await expect(ask).toBeVisible();
    await expect(ask).toContainText("closed months keep their billed figures");
    await ask.getByRole("button", { name: "Unmap", exact: true }).click();

    const unmapped = toast(page, `Unmapped 1 point from ${PANEL}.`);
    await expect(unmapped).toBeVisible();
    await expect(row.locator(".st-off"), "the row says unmapped").toHaveText("unmapped");
    expect((await request.get(`/api/mappings/${made.id}`)).status(), "the mapping is gone").toBe(404);
    await expect(row.getByRole("button", { name: `Actions for ${point.name}`, exact: true }), "the focus is back on the row's menu").toBeFocused();

    await undoOf(unmapped).click();
    await expect(toast(page, "Put back 1 mapping.")).toBeVisible();
    await expect(row).toContainText(PANEL);
    await expect(row.getByRole("button", { name: `Actions for ${point.name}`, exact: true }), "the Undo's button left with its toast: the focus is back on the row's menu, not on the body").toBeFocused();
    const back = (await sourceMappings(request, target.sourceId)).find((p) => p.point === point.id);
    expect(back?.mapping, "the point is mapped again with the values it had").toEqual({ asset_id: panel.id, metric: point.metric, scale: 0.5, interval_seconds: 9, custom_unit: null });
  } finally {
    await unmapTarget(request);
  }
});

test("11 Ctrl+Z takes an unmap made from a Discovery node back with the keyboard alone, with the same values; not inside a text field; a second press does nothing", async ({ page }) => {
  test.setTimeout(240_000);
  await signInAs(page, ADMIN);
  const request = page.request;
  const [odd, plain] = target.points;
  // What the browser (not this spec's own requests) writes to the mappings: a press that starts nothing leaves this empty.
  const writes: string[] = [];
  page.on("request", (r) => { if (r.method() !== "GET" && r.url().includes("/api/mappings")) writes.push(`${r.method()} ${r.url()}`); });
  const count = 2;
  try {
    // Values off their defaults, so that an Undo which posted the defaults instead would be caught.
    const oddMade = await mapOne(request, odd, panel.id, { metric: "custom", custom_unit: ODD_UNIT, scale: 0.001, interval_seconds: 7 });
    const plainMade = await mapOne(request, plain, panel.id, { scale: 0.5, interval_seconds: 9 });
    const stored = [valuesOf(await json<ApiMapping>(request, `/api/mappings/${oddMade.id}`)), valuesOf(await json<ApiMapping>(request, `/api/mappings/${plainMade.id}`))];
    const what = await groupWhat(request);

    await openOnGroup(page);
    const cluster = clusterNode(page);
    const unmapGroup = async (): Promise<Locator> => {
      await ensureOnCanvas(page, cluster);
      await cluster.getByRole("button", { name: `Mapping actions for ${target.key}`, exact: true }).click();
      await menuEl(page).getByRole("menuitem", { name: "Unmap this group…", exact: true }).click();
      const ask = page.getByRole("dialog", { name: `Unmap ${what} from ${PANEL}?`, exact: true });
      await expect(ask, "the confirmation names the group (and its source when the name is not unique)").toBeVisible();
      await ask.getByRole("button", { name: "Unmap", exact: true }).click();
      await expect(ask).toBeHidden();
      const raised = toast(page, `Unmapped ${count} points from ${PANEL}.`);
      await expect(raised).toBeVisible();
      await expect(undoOf(raised)).toBeVisible();
      await expectTargetOn(request, null, "both mappings are gone");
      return raised;
    };

    const raised = await unmapGroup();
    await expect(cluster, "the focus is on the group the action was about").toBeFocused();

    await test.step("Ctrl+Z inside a text field is the field's own: in the Find box the mapping stays unmapped and the toast stays", async () => {
      await page.keyboard.press("Control+k");
      const find = page.getByRole("combobox", { name: "Search the graph", exact: true });
      await expect(find).toBeFocused();
      await find.fill(target.key);
      writes.length = 0;
      await page.keyboard.press("Control+z");
      await page.waitForTimeout(600);
      expect(writes, "nothing was written to the mappings").toEqual([]);
      await expect(raised, "the Undo toast is still there").toBeVisible();
      await expectTargetOn(request, null, "still unmapped");
      await page.keyboard.press("Escape");
      await expect(find).toBeHidden();
      await expect(cluster, "Escape gives the focus back to the group").toBeFocused();
    });

    await test.step("Ctrl+Z with the focus on the group: the mappings are back with the same scale, interval and unit, the toast has gone, a second press does nothing", async () => {
      await page.keyboard.press("Control+z");
      await expect(raised, "the shortcut takes the Undo toast away").toBeHidden();
      await expect(toast(page, `Put back ${count} mappings.`).last(), "the earlier toast of the same words may still be on screen").toBeVisible();
      await expect(page.getByRole("button", { name: "Undo", exact: true }), "no Undo button is left on screen").toHaveCount(0);
      await expectTargetHolds(request, stored, "scale, interval, custom unit, metric, point and asset are what they were");
      await expect(cluster, "the focus is on the group again").toBeFocused();

      const ids = (await targetPoints(request)).map((p) => p.mapping_id);
      writes.length = 0;
      await page.keyboard.press("Control+z");
      await page.waitForTimeout(600);
      expect(writes, "a second Ctrl+Z starts nothing").toEqual([]);
      await expect(toast(page, "Unmapped"), "and raises no toast").toHaveCount(0);
      expect((await targetPoints(request)).map((p) => p.mapping_id), "the mappings are the ones the first press made").toEqual(ids);
    });

    await test.step("Ctrl+Z with the focus on the canvas itself does the same", async () => {
      const again = await unmapGroup();
      await canvasGroup(page).focus();
      await expect(canvasGroup(page)).toBeFocused();
      await page.keyboard.press("Control+z");
      await expect(again).toBeHidden();
      await expect(toast(page, `Put back ${count} mappings.`).last(), "the earlier toast of the same words may still be on screen").toBeVisible();
      await expectTargetHolds(request, stored, "the mappings are back with their values");
    });
  } finally {
    await unmapTarget(request);
  }
});

test("12 New asset… on a group (admin) makes the asset with the real form, and the Review that follows says it was created and that Cancel keeps it", async ({ page }) => {
  test.setTimeout(240_000);
  await signInAs(page, ADMIN);
  const request = page.request;
  const name = `${MADE} ${target.key}`;
  try {
    await openOnGroup(page);
    const cluster = clusterNode(page);
    await ensureOnCanvas(page, cluster);
    await cluster.getByRole("button", { name: `New asset from ${target.key}…`, exact: true }).click();

    const form = formDialog(page);
    await expect(form, "an editor gets the real form, not the Review's own choice").toBeVisible();
    await expect(form).toContainText("Cancel keeps the new asset.");
    await form.getByLabel("Name", { exact: true }).fill(name);
    await form.getByRole("button", { name: "Save", exact: true }).click();

    const review = reviewDialog(page);
    await expect(review, "Save goes on to the Review on the new asset").toBeVisible();
    const made = (await assetsOf(request)).find((a) => a.name === name);
    expect(made, `the asset ${name} was created`).toBeDefined();
    const chosen = review.getByLabel("Asset", { exact: true });
    await expect(chosen, "the new asset is chosen").toHaveValue(String(made!.id));
    const created = `${name} was created. Cancel keeps it without any mappings.`;
    await expect(review.getByText(created, { exact: true }), "the Review says what Cancel does").toBeVisible();
    await expect(chosen, "and the select is described by it").toHaveAccessibleDescription(new RegExp(created.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(review).toBeHidden();
    expect((await assetsOf(request)).some((a) => a.id === made!.id), "Cancel keeps the asset").toBe(true);
    await expectTargetOn(request, null, "and it has no mappings");
  } finally {
    for (const a of (await assetsOf(request)).filter((x) => x.name.startsWith(MADE)).sort((x, y) => y.id - x.id)) await deleteAsset(request, a.id);
    await unmapTarget(request);
  }
});
