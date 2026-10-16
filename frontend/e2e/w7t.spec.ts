import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { rowAction, treeLink, userBlock } from "./shell";

// W7t (Discovery and asset-page polish, batch 1: an icon beside every crumb, children that follow their parent on the Discovery graph with Alt/Option to
// move a node alone, port names and a typo guard on the scope form, Scan again, Tidy layout, a summary line with Collapse all and Expand all, a source
// node whose buttons fit one row, and a pick bar that keeps Move to... beside its hint) on the state the earlier projects leave behind: admin `admin` /
// `correct-horse`. The stack is SHARED and w7t is the LAST project that works on its layout (w7u follows it and answers the graph from a stub): Tidy layout removes EVERY saved node place of the stack, and each case clears the layout
// first (`DELETE /api/discovery/layout`), so nothing here depends on what an earlier project dragged. What the spec makes starts `W7t <run> ` (the digits-only run
// suffix), the accounts and roles `w7t-`; beforeAll (an earlier run that stopped half way) and afterAll remove, whatever the run, the assets (with
// `?confirm=true`), the scopes, then the accounts and roles, and leave the saved layout empty. Scans cannot be deleted and stay in Recent scans.
//
// w7r (before this) may have removed the discovered Modbus source (Clear unmapped), so beforeAll makes its own scope (`W7t <run> sim`, ports 9000 and 5020) and
// scans it: that brings the Modbus simulator back (ten groups of six points) and gives Scan again a scan to repeat. The cases read what the graph holds from
// GET /api/discovery/graph at the moment they need it and never assume a source's name.
//
// How positions are read. A node's place is read in FLOW coordinates from the transform of its React Flow wrapper (`flowPos`), never from a screen box: the zoom,
// the opening view and an auto-pan move screen boxes, and flow values compare directly with what `GET /api/discovery/graph` says in `layout`. Every read that
// follows a drag is polled (React Flow settles the last position after the mouse is up), and a case that reloads polls the API until its save has landed first
// (the write chain is asynchronous). A reload forgets which sources and groups are open, so a case opens them again before it looks at their children.
//
// The cases (the file runs in this order; one failing does not stop the next):
//   crumbs      a deep asset's trail (explicit icons, long names): every crumb has its icon (decoration: aria-hidden, the link names are the labels), the current
//               crumb's icon is the header tile's, one line at 1440 and no sideways overflow at 800.
//   pick bar    at 1024 with the sidebar expanded, for the default column and the narrowest one: Move to... on the count's line, the bar 64 px high at 275 px of room
//               or less (32 px above it), nothing cut, Delete and Clear on the second line.
//   drag        a source with an open group and point is dragged: both keep their offset to it (1 px), only the source is saved (children without a place of their
//               own follow by the rule), and after a reload the opened group and point stand beside it again.
//   hidden      a collapsed source whose group has a saved place is dragged: the group's saved place moves by the same amount in the SAME save, and opening it puts it
//               beside the source, not over it (the owner's bug), also after a reload.
//   Alt         Alt held at the start moves the source alone: the open group and point stay; the drawn groups are pinned where they stand (they get places of their
//               own, saved with the source) so a rebuild (collapse and open, reload) leaves them there.
//   drop        a group dropped on an asset opens the review (it maps: Create mappings makes the mappings) and the group and its points are back at their start
//               places, nothing is saved; the asset is deleted at the end (which unmaps the source).
//   limit       the documented limit of Decision 3 (backlog AS): a group dragged out of the SECOND source keeps its place when the FIRST source opens and pushes
//               the second down. The step pins TODAY's behaviour so that a change is deliberate.
//   tidy        Tidy layout asks "Tidy the layout for everyone?" (Escape changes nothing and returns the focus), Tidy for everyone empties the saved layout (read
//               from the API) after a drag that was still being saved, and the sources stand in their default places again.
//   no edit     a role with discovery.view only: Tidy layout asks nothing and sends nothing, its own view goes to the default places, a toast says so, and the
//               shared layout is untouched.
//   summary     the line above the canvas equals what the API holds, Expand all opens what fits the 600-node budget (and says so when something does not),
//               Collapse all closes it, and each is aria-disabled when there is nothing to do.
//   layout      at 1440 and at 1024 x 640: no sideways overflow, the bar and its three buttons whole, the hint short, the source node's Details, Create assets...
//               and bin on ONE row inside the node, and (the w7r check, with the bar) the first source's title and Create assets button inside the canvas.
//   canvas drop with the graph response held for 1.5 s, the canvas row (`.graph-layout`) starts at the same height (0.5 px) in the loading branch and once the graph is
//               in, at 1440 x 900, 1024 x 640 and 800 x 600 (the header's actions hold their real width while loading, so the hint wraps the same way).
//   scope form  4080 warns with `4840 (OPC UA)`, 4840 and 4080 together still save (the Ports cell names 4840), 80 and 8080 do not warn, the Edit form warns too, and
//               the form does not move under the typing.
//   scan again  Recent scans: Scan again opens the preview and confirmation of the same scope, the panel is in view at 1024 x 640 after a scroll that had left it
//               out, the focus stays on the button; a scan of a deleted scope has the button aria-disabled with its reason and a click opens nothing.
//
// Locators. Playwright matches a name by case-insensitive SUBSTRING: every button name below is `exact: true` (or an anchored regular expression) and every lookup
// of a toggle or a Map button is scoped to its node (the same group name, LVP01 and the like, can exist in two sources). The bar's buttons are found inside
// `.graph-bar`. Screenshots go to .superpowers/sdd/overnight-w7/gallery/W7t/ when W7T_GALLERY=1.

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse" };
const RUN = Date.now().toString();
const PREFIX = `W7t ${RUN}`;
const SIM_SCOPE = `${PREFIX} sim`;
const GONE_SCOPE = `${PREFIX} gone`;
const FORM_SCOPE = `${PREFIX} form`;
/** Every name any run of this spec made: the digits-only run suffix after `W7t `. */
const anyRun = (name: string) => /^W7t \d+( |$)/.test(name);

const VIEWER_ROLE = "w7t-viewer-role"; // discovery.view only
const VIEWER = { username: "w7t-viewer", password: "w7t-viewer-pass", role: VIEWER_ROLE };

/** localStorage key of the tree column's width (lib/treeWidth.ts). */
const TREE_WIDTH_KEY = "dcdash.assetTreeWidth";
/** The pick bar is two lines when the tree body is this many px wide or less (the container query in styles/tree-move.css). */
const TWO_LINES_AT = 275;
/** lib/graph.ts: a source's block (SOURCE_H) and the most nodes one Expand all draws (EXPAND_NODE_BUDGET). */
const SOURCE_H = 136;
const EXPAND_BUDGET = 600;
/** lib/graph.ts PAGE_SIZE: the points a group draws before its "Show 50 more" node. */
const PAGE_SIZE = 50;
const NO_GROUP = "__ungrouped__";

const TIDY_TITLE = "Tidy the layout for everyone?";
const TIDY_CONFIRM = "Tidy for everyone";
const TIDY_SOLO = "Tidied for you only. Your role may not change the layout everyone sees.";
const GREW_NOTE = /closed: opening (it|them) would draw more than 600 nodes\.$/;

interface XY { x: number; y: number }
interface ApiPoint { id: number; name: string; mapping_id: number | null; asset_id: number | null }
interface ApiCluster { key: string; points: ApiPoint[] }
interface ApiGraphSource {
  id: number; name: string; connector_type: string; origin: "manual" | "discovered"; needs_credentials: boolean;
  clusters: ApiCluster[]; ungrouped: ApiPoint[];
}
interface ApiGraph { sources: ApiGraphSource[]; assets: { id: number }[]; unidentified: unknown[]; layout: Record<string, XY> }
interface ApiScope { id: number; name: string }
interface ApiScan { id: number; status: string; error: string | null }
interface ApiAsset { id: number; name: string; parent_id: number | null }
interface ApiRole { id: number; name: string; builtin: boolean }
interface ApiUser { id: number; username: string }
interface Box { x: number; y: number; width: number; height: number }

// ---------------------------------------------------------------------------------------------------------------------------------
// What the page works out from the graph, written here again so a change of wording is a change of this spec

const pointsOf = (source: ApiGraphSource): ApiPoint[] => [...source.clusters.flatMap((c) => c.points), ...source.ungrouped];
/** The groups the graph draws for a source: its clusters, then the Ungrouped bag when it has points (lib/graph.ts groupsOf). */
const groupsOf = (source: ApiGraphSource): { key: string; points: ApiPoint[] }[] => [
  ...source.clusters.map((c) => ({ key: c.key, points: c.points })),
  ...(source.ungrouped.length > 0 ? [{ key: NO_GROUP, points: source.ungrouped }] : []),
];
const isMapped = (source: ApiGraphSource) => pointsOf(source).some((p) => p.mapping_id !== null || p.asset_id !== null);
const removable = (graph: ApiGraph) => graph.sources.filter((s) => s.origin === "discovered" && !isMapped(s));
const modbusOf = (graph: ApiGraph) => graph.sources.find((s) => s.origin === "discovered" && s.connector_type === "modbus");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 sources, 120 points, 6 mapped, 1 needs credentials" (lib/graphView.ts graphSummary): the points the graph draws, `asset_id !== null` is mapped, credentials only above 0. */
function summaryOf(graph: ApiGraph): string {
  let [points, mapped, needing] = [0, 0, 0];
  for (const source of graph.sources) {
    if (source.needs_credentials) needing++;
    for (const p of pointsOf(source)) {
      points++;
      if (p.asset_id !== null) mapped++;
    }
  }
  const parts = [plural(graph.sources.length, "source"), plural(points, "point"), `${mapped} mapped`];
  if (needing > 0) parts.push(`${needing} ${needing === 1 ? "needs" : "need"} credentials`);
  return parts.join(", ");
}

/**
 * What Expand all would draw from an all-closed graph: the groups of every source, the points of every group's first page (W12b: a group of more than PAGE_SIZE points opens
 * with that many, and a "Show 50 more" node stands at the end of its list) and one `more` node for each group that has points left out.
 */
function expandCost(graph: ApiGraph): { groups: number; points: number; more: number } {
  let [groups, points, more] = [0, 0, 0];
  for (const source of graph.sources) {
    for (const group of groupsOf(source)) {
      groups++;
      points += Math.min(group.points.length, PAGE_SIZE);
      if (group.points.length > PAGE_SIZE) more++;
    }
  }
  return { groups, points, more };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Requests

async function signInAs(page: Page, who: { username: string; password: string }): Promise<void> {
  const login = await page.request.post("/api/login", { data: { username: who.username, password: who.password } });
  expect(login.ok(), `signing in as ${who.username}: ${login.status()} ${await login.text()}`).toBe(true);
}
const signIn = (page: Page) => signInAs(page, ADMIN);

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

async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}
const graphOf = (request: APIRequestContext) => json<ApiGraph>(request, "/api/discovery/graph");
const layoutOf = async (request: APIRequestContext) => (await graphOf(request)).layout;

async function putLayout(request: APIRequestContext, places: Record<string, XY>): Promise<void> {
  const saved = await request.put("/api/discovery/layout", { data: { nodes: Object.entries(places).map(([node_id, p]) => ({ node_id, x: p.x, y: p.y })) } });
  expect(saved.status(), `saving the layout: ${await saved.text()}`).toBe(204);
}
async function clearLayout(request: APIRequestContext): Promise<void> {
  const cleared = await request.delete("/api/discovery/layout");
  expect(cleared.status(), `clearing the layout: ${await cleared.text()}`).toBe(204);
}

async function scopeNamed(request: APIRequestContext, name: string, ports: number[]): Promise<ApiScope> {
  const found = (await json<ApiScope[]>(request, "/api/scopes")).find((s) => s.name === name);
  if (found) return found;
  const made = await request.post("/api/scopes", { data: { name, targets: ["simulator"], ports } });
  expect(made.status(), `creating the scope ${name}: ${await made.text()}`).toBe(201);
  return (await made.json()) as ApiScope;
}

/** Previews the scope and starts a scan with the host count and the digest the preview gave (what the page does), then waits until it has ended `done`. */
async function runScan(request: APIRequestContext, scopeId: number): Promise<number> {
  const preview = await json<{ hosts: number; digest: string }>(request, `/api/scopes/${scopeId}/preview`);
  const started = await request.post(`/api/scopes/${scopeId}/scan`, { data: { confirm_host_count: preview.hosts, digest: preview.digest } });
  expect(started.status(), `starting the scan: ${await started.text()}`).toBe(202);
  const scanId = ((await started.json()) as { scan_id: number }).scan_id;
  let last: ApiScan | undefined;
  await expect
    .poll(async () => {
      last = await json<ApiScan>(request, `/api/scans/${scanId}`);
      return last.status === "done" || last.status === "failed";
    }, { timeout: 150_000, intervals: [500, 1000, 2000], message: `scan #${scanId} never ended` })
    .toBe(true);
  expect(last!.status, `scan #${scanId} ended ${last!.status}: ${last!.error}`).toBe("done");
  return scanId;
}

async function makeAsset(request: APIRequestContext, name: string, parentId: number | null = null, icon?: string): Promise<ApiAsset> {
  const made = await request.post("/api/assets", { data: { name, parent_id: parentId, kind: "generic", sort_order: 0, ...(icon ? { icon } : {}) } });
  expect(made.status(), `creating the asset ${name}: ${await made.text()}`).toBe(201);
  return (await made.json()) as ApiAsset;
}
async function deleteAsset(request: APIRequestContext, id: number): Promise<void> {
  const gone = await request.delete(`/api/assets/${id}?confirm=true`);
  expect([200, 204, 404], `deleting the asset ${id}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
}

/** Every account whose name starts with w7t-, then every custom role that does (a role an account holds cannot be deleted). */
async function removeAccounts(request: APIRequestContext): Promise<void> {
  for (const user of (await json<ApiUser[]>(request, "/api/users")).filter((u) => u.username.startsWith("w7t-"))) {
    const gone = await request.delete(`/api/users/${user.id}`);
    expect([204, 404], `deleting ${user.username}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
  for (const role of (await json<ApiRole[]>(request, "/api/roles")).filter((r) => !r.builtin && r.name.toLowerCase().startsWith("w7t-"))) {
    const gone = await request.delete(`/api/roles/${role.id}`);
    expect([204, 404], `deleting the role ${role.name}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
}

/** The assets (newest first, so a child goes before its parent), the scopes and the accounts of every run of this spec; the failures are collected. */
async function removeLeftovers(request: APIRequestContext, failures: string[]): Promise<void> {
  const attempt = async (what: string, step: () => Promise<void>) => {
    try {
      await step();
    } catch (e) {
      failures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await attempt("the assets", async () => {
    for (const asset of (await json<ApiAsset[]>(request, "/api/assets")).filter((a) => anyRun(a.name)).sort((a, b) => b.id - a.id)) await deleteAsset(request, asset.id);
  });
  await attempt("the scopes", async () => {
    for (const scope of (await json<ApiScope[]>(request, "/api/scopes")).filter((s) => anyRun(s.name))) {
      const gone = await request.delete(`/api/scopes/${scope.id}`);
      expect([204, 404], `deleting the scope ${scope.name}: ${gone.status()}`).toContain(gone.status());
    }
  });
  await attempt("the accounts and roles", () => removeAccounts(request));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The browser

const GALLERY = fileURLToPath(new URL("../../.superpowers/sdd/overnight-w7/gallery/W7t/", import.meta.url));
/** A screenshot into the gallery folder, only when W7T_GALLERY=1. */
async function shot(page: Page, name: string): Promise<void> {
  if (process.env.W7T_GALLERY !== "1") return;
  mkdirSync(GALLERY, { recursive: true });
  await page.screenshot({ path: `${GALLERY}${name}.png` });
}

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const toast = (page: Page, text: string | RegExp) => page.locator(".toast-stack .toast").filter({ hasText: text });
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const srcNode = (page: Page, source: { id: number }) => node(page, `src:${source.id}`);
const clusterNode = (page: Page, source: { id: number }, key: string) => node(page, `cluster:${source.id}:${key}`);
const pointNode = (page: Page, pointId: number) => node(page, `point:${pointId}`);
const assetNode = (page: Page, assetId: number) => node(page, `asset:${assetId}`);
const bar = (page: Page) => page.locator(".graph-bar");
const barButton = (page: Page, name: string) => bar(page).getByRole("button", { name, exact: true });
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

async function boxOf(target: Locator, what: string): Promise<Box> {
  const box = await target.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  return box!;
}
const centreOf = (box: Box): XY => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const overlap = (a: Box, b: Box) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

/** A node's place in FLOW coordinates, from the transform of its wrapper: the zoom and the pan do not enter. */
const flowPos = (target: Locator): Promise<XY> =>
  target.evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return { x: m.m41, y: m.m42 };
  });
const zoomOf = (page: Page) => page.locator(".react-flow__viewport").evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
const near = (a: XY, b: XY) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const minus = (a: XY, b: XY): XY => ({ x: a.x - b.x, y: a.y - b.y });
const plus = (a: XY, b: XY): XY => ({ x: a.x + b.x, y: a.y + b.y });

/** Polls until the node stands at `want` (1 px): React Flow settles the last position after the mouse is up. */
async function expectAt(target: Locator, want: XY, what: string): Promise<void> {
  await expect
    .poll(async () => near(await flowPos(target), want), { message: `${what} stands at (${want.x.toFixed(1)}, ${want.y.toFixed(1)})` })
    .toBeLessThanOrEqual(1);
}
/** Polls until `child` stands `offset` from `parent` (1 px). */
async function expectBeside(parent: Locator, child: Locator, offset: XY, what: string): Promise<void> {
  await expect
    .poll(async () => near(minus(await flowPos(child), await flowPos(parent)), offset), { message: `${what} keeps its offset (${offset.x.toFixed(1)}, ${offset.y.toFixed(1)}) to its parent` })
    .toBeLessThanOrEqual(1);
}
/** Polls the API until the saved places of `ids` are what `want` says (1 px); an id missing from the layout counts as far away. */
async function expectSaved(request: APIRequestContext, want: Record<string, XY>, what: string): Promise<void> {
  await expect
    .poll(async () => {
      const layout = await layoutOf(request);
      return Math.max(0, ...Object.entries(want).map(([id, p]) => (layout[id] ? near(layout[id], p) : 9999)));
    }, { message: `${what}: the save has landed` })
    .toBeLessThanOrEqual(1);
}

/** Resolves once `target` has stopped moving: React Flow animates the viewport, and boxes taken mid-animation are stale. */
async function stopped(target: Locator) {
  let previous = "";
  await expect.poll(async () => {
    const now = JSON.stringify(await target.boundingBox());
    const same = now !== "null" && now === previous;
    previous = now;
    return same;
  }, { intervals: [150], message: "never stopped moving" }).toBe(true);
}

/** The "fit view" control; the nodes are small, so re-fit whenever the layout changed. */
async function fitView(page: Page, target: Locator) {
  await page.getByRole("button", { name: "fit view" }).click();
  await stopped(target);
}

/** Re-fit when `target` is not fully inside the canvas (a node that is off-screen cannot be clicked or dragged). */
async function ensureOnCanvas(page: Page, target: Locator) {
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  const box = await target.boundingBox();
  const inside = box !== null && box.x >= pane.x && box.y >= pane.y && box.x + box.width <= pane.x + pane.width && box.y + box.height <= pane.y + pane.height;
  if (!inside) await fitView(page, target);
}

/**
 * Opens Discovery and waits until the canvas has drawn a node. The graph is as tall as the stack's assets (64 px each, React Flow's fit will not zoom out past
 * 0.5 here), so the window is made tall enough first (the page is exactly one window tall, so the canvas follows) and the Controls' fit view is pressed (the
 * canvas opens on the first sources instead of on the whole graph). The width stays what the case set.
 */
async function openDiscovery(page: Page): Promise<void> {
  const graph = await graphOf(page.request);
  const rows = Math.max(graph.assets.length * 64, graph.sources.length * 176 + graph.unidentified.length * 64);
  const need = Math.ceil(rows * 0.5 * 1.3 + 350);
  const view = page.viewportSize()!;
  if (need > view.height) await page.setViewportSize({ width: view.width, height: Math.min(need, 12_000) });
  await page.goto("/discovery");
  await expect(heading1(page, "Discovery")).toBeVisible();
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
  await stopped(page.locator(".react-flow__node").first());
  await fitView(page, page.locator(".react-flow__node").first());
}

/** Opens the source so that its groups are drawn, then fits the view (the new nodes may lie outside it). */
async function expandSource(page: Page, source: ApiGraphSource): Promise<void> {
  await ensureOnCanvas(page, srcNode(page, source));
  await srcNode(page, source).getByRole("button", { name: `Expand ${source.name}`, exact: true }).click();
  await expect(clusterNode(page, source, groupsOf(source)[0].key)).toBeVisible();
  await stopped(srcNode(page, source)); // W7u: a source's own + pans the camera for 300 ms; let it finish, or it could start after the fit below and win
  await fitView(page, srcNode(page, source));
}
/** Opens one group of an open source so that its points are drawn, then fits the view. */
async function expandGroup(page: Page, source: ApiGraphSource, key: string, firstPoint: ApiPoint): Promise<void> {
  await ensureOnCanvas(page, clusterNode(page, source, key));
  await clusterNode(page, source, key).getByRole("button", { name: /^Expand / }).click();
  await expect(pointNode(page, firstPoint.id)).toBeVisible();
  await fitView(page, srcNode(page, source));
}

/** The pointer path of a drag: d3-drag needs real intermediate moves (locator.dragTo is not enough). Alt (Option) is held for the whole drag and let go in `finally`. */
async function dragPath(page: Page, from: XY, to: XY, alt: boolean): Promise<void> {
  await page.mouse.move(from.x, from.y);
  if (alt) await page.keyboard.down("Alt");
  try {
    await page.mouse.down();
    await page.mouse.move(from.x + 6, from.y + 6, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps: 25 });
    await page.mouse.up();
  } finally {
    if (alt) await page.keyboard.up("Alt");
  }
}
/** Drags the middle of `handle` by `by` screen pixels. */
async function dragBy(page: Page, handle: Locator, by: XY, alt = false): Promise<void> {
  await stopped(handle);
  const from = centreOf(await boxOf(handle, "the drag handle"));
  await dragPath(page, from, plus(from, by), alt);
}
/** Drags the middle of `handle` onto the middle of `target`. */
async function dragOnto(page: Page, handle: Locator, target: Locator): Promise<void> {
  await stopped(handle);
  await stopped(target);
  await dragPath(page, centreOf(await boxOf(handle, "the drag handle")), centreOf(await boxOf(target, "the drop target")), false);
}

/** How far the page reaches past the window sideways, in px (0 when nothing overflows). */
const overflowOf = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** The Modbus simulator's source (ten groups of six points) and a group of it with nothing mapped. */
async function pickModbus(request: APIRequestContext): Promise<{ graph: ApiGraph; S: ApiGraphSource; K: ApiCluster; P: ApiPoint }> {
  const graph = await graphOf(request);
  const S = modbusOf(graph);
  expect(S, "the discovered Modbus source (beforeAll scanned for it)").toBeDefined();
  expect(S!.clusters.length, "with several groups").toBeGreaterThanOrEqual(2);
  const K = S!.clusters.find((c) => c.points.length > 0 && c.points.every((p) => p.asset_id === null));
  expect(K, "a group of it with nothing mapped").toBeDefined();
  return { graph, S: S!, K: K!, P: K!.points[0] };
}

// ---------------------------------------------------------------------------------------------------------------------------------

let simScope: ApiScope;
let simScanId = 0;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  await asAdmin(browser, async (request) => {
    const failures: string[] = [];
    await removeLeftovers(request, failures); // an earlier run that stopped half way
    expect(failures, "clearing the leftovers of an earlier run").toEqual([]);
    simScope = await scopeNamed(request, SIM_SCOPE, [9000, 5020]);
    simScanId = await runScan(request, simScope.id); // brings the Modbus simulator back if w7r's Clear unmapped removed it, and is the scan Scan again repeats
  });
});

test.afterAll(async ({ browser }) => {
  const failures: string[] = [];
  await asAdmin(browser, async (request) => {
    await removeLeftovers(request, failures);
    try {
      await clearLayout(request); // the stack is left with no saved places
    } catch (e) {
      failures.push(`the layout: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  expect(failures, "the clean-up left something behind").toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7t: the trail above an asset", () => {
  test("every crumb has its own icon beside it (decoration only), the current crumb wears the header tile's, and a long trail does not widen the page at 800 px", async ({ page }) => {
    test.setTimeout(150_000);
    await signIn(page);
    const site = await makeAsset(page.request, `${PREFIX} Campus North with a rather long name`, null, "building");
    const hall = await makeAsset(page.request, `${PREFIX} Data hall number one, west wing`, site.id, "room");
    const rack = await makeAsset(page.request, `${PREFIX} Row A, rack 07, cold aisle side`, hall.id, "rack");
    const device = await makeAsset(page.request, `${PREFIX} Server chassis 3 of rack 07`, rack.id, "server");
    const trail = [site, hall, rack];
    try {
      const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
      const items = crumbs.locator("li");
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/assets/${device.id}`);
      await expect(heading1(page, device.name)).toBeVisible();
      await expect(items, "Assets Tree, the three ancestors and the asset (the ancestors come from the list, which may load a moment later)").toHaveCount(5);

      await test.step("the link names and the current page are the labels alone", async () => {
        await expect(crumbs.getByRole("link")).toHaveText(["Assets Tree", ...trail.map((a) => a.name)]);
        await expect(crumbs.locator('[aria-current="page"]')).toHaveText(device.name);
      });

      await test.step("each crumb has exactly one icon, aria-hidden, about the size of the text, inside its own item", async () => {
        for (const [at, li] of (await items.all()).entries()) {
          await expect(li.locator(".crumb-icon"), `crumb ${at + 1}`).toHaveCount(1);
          await expect(li.locator('.crumb-icon[aria-hidden="true"] svg'), `crumb ${at + 1} is decoration`).toHaveCount(1);
          const icon = await boxOf(li.locator(".crumb-icon svg"), `the icon of crumb ${at + 1}`);
          const item = await boxOf(li, `crumb ${at + 1}`);
          expect(icon.width, `the icon of crumb ${at + 1} is as wide as the text is high`).toBeGreaterThanOrEqual(8);
          expect(icon.width).toBeLessThanOrEqual(20);
          expect(icon.x, `the icon of crumb ${at + 1}: left`).toBeGreaterThanOrEqual(item.x - 1);
          expect(icon.x + icon.width, `the icon of crumb ${at + 1}: right`).toBeLessThanOrEqual(item.x + item.width + 1);
          expect(icon.y, `the icon of crumb ${at + 1}: top`).toBeGreaterThanOrEqual(item.y - 1);
          expect(icon.y + icon.height, `the icon of crumb ${at + 1}: bottom`).toBeLessThanOrEqual(item.y + item.height + 1);
        }
      });

      await test.step("the icons are the assets' own (building, room, rack, server) and the asset's is the header tile's", async () => {
        const drawn = await crumbs.locator(".crumb-icon svg").evaluateAll((els) => els.map((el) => el.innerHTML));
        expect(drawn.length).toBe(5);
        expect(new Set(drawn).size, "five different drawings: the tree's icon first, then one for each asset").toBe(5);
        expect(drawn[4], "the current crumb wears the icon of the page title").toBe(await page.locator(".page-head .page-tile svg").innerHTML());
      });
      await shot(page, "crumbs-1440");

      await test.step("at 800 px the trail wraps instead of widening the page", async () => {
        await page.setViewportSize({ width: 800, height: 700 });
        await page.goto(`/assets/${device.id}`);
        await expect(heading1(page, device.name)).toBeVisible();
        await expect(items).toHaveCount(5);
        await settled(page);
        expect.soft(await overflowOf(page), "the page does not scroll sideways").toBeLessThanOrEqual(1);
        expect(await crumbs.evaluate((el) => el.scrollWidth - el.clientWidth), "and the trail does not either").toBeLessThanOrEqual(1);
      });
    } finally {
      for (const asset of [device, rack, hall, site]) await deleteAsset(page.request, asset.id);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

const tree = (page: Page) => page.getByRole("region", { name: "Asset tree" });
const slot = (page: Page) => tree(page).getByRole("group", { name: "Selection", exact: true });
const slotButton = (page: Page, name: string) => slot(page).getByRole("button", { name, exact: true });

/** The tree column has stopped moving (the stored width is clamped once the room is measured, and the sidebar animates). */
async function columnStill(page: Page): Promise<void> {
  let last = -1;
  await expect
    .poll(async () => {
      const width = (await boxOf(tree(page), "the tree column")).width;
      const same = width === last;
      last = width;
      return same;
    }, { message: "the tree column has stopped moving" })
    .toBe(true);
}
/** Makes sure the sidebar is the way wanted (it starts the way the window width chose, and has no resize listener) and the tree column has stopped moving. */
async function sidebar(page: Page, want: "expanded" | "minimized"): Promise<void> {
  const shell = page.locator(".shell");
  if ((await shell.getAttribute("data-sidebar")) !== want) await page.locator(".side-toggle").click();
  await expect(shell).toHaveAttribute("data-sidebar", want);
  await columnStill(page);
}

/** One pass over the pick bar at 1024 px with the sidebar expanded and the tree column stored at `stored` px (null = the default width). */
async function pickBarPass(page: Page, name: string, stored: number | null, where: string): Promise<void> {
  await page.goto("/assets");
  await page.evaluate(
    ([key, px]) => {
      if (px === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, String(px));
    },
    [TREE_WIDTH_KEY, stored] as [string, number | null],
  );
  await page.goto("/assets"); // the app reads the stored width when it loads
  await expect(treeLink(page, name)).toBeVisible();
  await sidebar(page, "expanded");

  const room = (await boxOf(tree(page).locator(".tree-body"), "the tree body")).width;
  const two = room <= TWO_LINES_AT;
  const note = `${where} (the tree body is ${room} px wide)`;
  if (stored !== null) expect(two, `the narrowest column is a two-line bar: ${note}`).toBe(true);

  const idle = await boxOf(slot(page), "the idle pick bar");
  expect(idle.height, `the bar is ${two ? 64 : 32} px high at ${note}`).toBe(two ? 64 : 32);
  await expect(slot(page).locator(two ? ".tree-slot-short" : ".tree-slot-long"), `the idle hint at ${note}`).toBeVisible();
  await expect(slot(page).locator(two ? ".tree-slot-long" : ".tree-slot-short"), `the other idle hint at ${note}`).toBeHidden();

  await treeLink(page, name).click({ modifiers: ["Control"] });
  await expect(slot(page)).toContainText("1 picked");
  const picked = await boxOf(slot(page), "the pick bar with a pick");
  expect(Math.abs(picked.height - idle.height), `the first pick changed the bar's height at ${note}`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(picked.y - idle.y), `the first pick moved the bar at ${note}`).toBeLessThanOrEqual(0.5);

  const count = await boxOf(slot(page).locator(".tree-slot-count"), "the count");
  const move = await boxOf(slotButton(page, "Move to..."), "Move to...");
  const clear = await boxOf(slotButton(page, "Clear"), "Clear");
  const del = await boxOf(slot(page).getByRole("button", { name: /^Delete/ }), "Delete");
  for (const [what, box] of [["the count", count], ["Move to...", move], ["Clear", clear], ["Delete", del]] as [string, Box][]) {
    expect(box.x, `${what} starts inside the bar at ${note}`).toBeGreaterThanOrEqual(picked.x - 0.5);
    expect(box.x + box.width, `${what} ends inside the bar at ${note}`).toBeLessThanOrEqual(picked.x + picked.width + 0.5);
    expect(box.y, `${what} starts inside the bar at ${note}`).toBeGreaterThanOrEqual(picked.y - 0.5);
    expect(box.y + box.height, `${what} ends inside the bar at ${note}`).toBeLessThanOrEqual(picked.y + picked.height + 0.5);
  }
  expect(await slot(page).evaluate((el) => el.scrollWidth - el.clientWidth), `the bar scrolls sideways at ${note}`).toBeLessThanOrEqual(1);
  expect(await slot(page).locator(".tree-slot-count").evaluate((el) => el.scrollWidth - el.clientWidth), `the count is cut at ${note}`).toBeLessThanOrEqual(1);
  // Move to... is on the FIRST line, the count's, whichever the bar's height.
  expect(Math.abs(centreOf(move).y - centreOf(count).y), `Move to... is on the count's line at ${note}`).toBeLessThanOrEqual(2);
  if (two) {
    expect(del.y, `Delete is on the second line, below the count and Move to..., at ${note}`).toBeGreaterThanOrEqual(Math.max(count.y + count.height, move.y + move.height) - 0.5);
    expect(Math.abs(clear.y - del.y), `Clear is on Delete's line at ${note}`).toBeLessThanOrEqual(1);
  } else {
    expect(Math.abs(centreOf(del).y - centreOf(count).y), `Delete is on the count's line at ${note}`).toBeLessThanOrEqual(2);
  }
  if (stored !== null) await shot(page, "pickbar-1024");

  await slotButton(page, "Clear").click(); // the next pass starts from a first pick again
  await expect(tree(page).locator(".node[data-picked]")).toHaveCount(0);
}

test.describe("W7t: the pick bar", () => {
  test("at 1024 px with the sidebar expanded Move to... shares the first line with the hint, the bar is 64 px at 275 px of room or less, and nothing is cut", async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const a = await makeAsset(page.request, `${PREFIX} bar A`);
    const b = await makeAsset(page.request, `${PREFIX} bar B`);
    try {
      await page.setViewportSize({ width: 1024, height: 640 });
      await test.step("the default column", () => pickBarPass(page, a.name, null, "1024 px, sidebar expanded, default column"));
      await test.step("the narrowest column (220 px): the two-line bar", () => pickBarPass(page, a.name, 220, "1024 px, sidebar expanded, column stored at 220 px"));
    } finally {
      await page.evaluate((key) => window.localStorage.removeItem(key), TREE_WIDTH_KEY).catch(() => undefined);
      for (const asset of [b, a]) await deleteAsset(page.request, asset.id);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7t: the Discovery graph, dragging", () => {
  test("dragging a source takes its open group and point along and they keep their offset; only the source is saved; after a reload the opened group and point are beside it again", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    const { S, K, P } = await pickModbus(page.request);
    await clearLayout(page.request);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDiscovery(page);
    const [src, group, point] = [srcNode(page, S), clusterNode(page, S, K.key), pointNode(page, P.id)];
    await expandSource(page, S);
    await expandGroup(page, S, K.key, P);
    const s0 = await flowPos(src);
    const offsets = { group: minus(await flowPos(group), s0), point: minus(await flowPos(point), s0) };

    let s1 = s0;
    await test.step("the group and the point keep their offset to the source while it is dragged", async () => {
      await dragBy(page, src.locator(".node-title"), { x: 140, y: 120 });
      await expect.poll(async () => near(await flowPos(src), s0), { message: "the source moved" }).toBeGreaterThan(40);
      s1 = await flowPos(src);
      await expectBeside(src, group, offsets.group, "the open group");
      await expectBeside(src, point, offsets.point, "the open point");
      await shot(page, "discovery-drag-1440");
    });

    await test.step("only the source is saved: a child with no place of its own follows by the rule and is not stored", async () => {
      await expectSaved(page.request, { [`src:${S.id}`]: s1 }, "the source");
      const keys = Object.keys(await layoutOf(page.request));
      expect(keys, "the layout holds the source and nothing under it").toEqual([`src:${S.id}`]);
    });

    await test.step("after a reload the opened group and point stand beside the source again", async () => {
      await openDiscovery(page);
      await expectAt(src, s1, "the source");
      await expandSource(page, S);
      await expandGroup(page, S, K.key, P);
      await expectAt(src, s1, "the source, with its children open");
      await expectBeside(src, group, offsets.group, "the group after the reload");
      await expectBeside(src, point, offsets.point, "the point after the reload");
    });
  });

  test("a collapsed source's group has a saved place that moves with the source in the SAME save; opening it puts it beside the source, not over it, also after a reload", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    const { S, K } = await pickModbus(page.request);
    const groupId = `cluster:${S.id}:${K.key}`;
    await clearLayout(page.request);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDiscovery(page);
    const [src, group] = [srcNode(page, S), clusterNode(page, S, K.key)];
    const s0 = await flowPos(src);
    // The group has a place of its own right beside the source (where it opens by default), saved while the source is closed.
    const own0 = { x: s0.x + 360, y: s0.y + SOURCE_H };
    await putLayout(page.request, { [groupId]: own0 });
    await openDiscovery(page); // read again: the page knows the saved place of the hidden group
    await expectAt(src, s0, "the source (it has no place of its own)");
    await ensureOnCanvas(page, src);

    // Drag the source onto the spot where the hidden group was saved: if the group stayed behind it would open under the source.
    const zoom = await zoomOf(page);
    await dragBy(page, src.locator(".node-title"), { x: 360 * zoom, y: SOURCE_H * zoom });
    await expect.poll(async () => near(await flowPos(src), s0), { message: "the source moved" }).toBeGreaterThan(100);
    const s1 = await flowPos(src);
    const moved = minus(s1, s0);
    const own1 = plus(own0, moved);

    await test.step("the hidden group's saved place moved by the same amount, in the same save as the source", async () => {
      await expectSaved(page.request, { [`src:${S.id}`]: s1, [groupId]: own1 }, "the source and its hidden group");
    });

    await test.step("opening the source puts the group at the moved place, beside the source and not over it", async () => {
      await expandSource(page, S);
      await expectAt(group, own1, "the group");
      await stopped(src);
      expect(overlap(await boxOf(src, "the source"), await boxOf(group, "the group")), "the group does not cover the source").toBe(false);
    });

    await test.step("the same after a reload", async () => {
      await openDiscovery(page);
      await expandSource(page, S);
      await expectAt(src, s1, "the source");
      await expectAt(group, own1, "the group");
      expect(overlap(await boxOf(src, "the source"), await boxOf(group, "the group")), "the group does not cover the source after the reload").toBe(false);
    });
  });

  test("Alt (Option) held at the start moves the source alone: the open group and point stay; the drawn groups are pinned, so collapsing and opening, and a reload, leave them where they were", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    const { S, K, P } = await pickModbus(page.request);
    await clearLayout(page.request);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDiscovery(page);
    const [src, group, point] = [srcNode(page, S), clusterNode(page, S, K.key), pointNode(page, P.id)];
    await expandSource(page, S);
    await expandGroup(page, S, K.key, P);
    const others = groupsOf(S).filter((g) => g.key !== K.key);
    const other = others[0];
    const before = {
      src: await flowPos(src), group: await flowPos(group), point: await flowPos(point),
      other: await flowPos(clusterNode(page, S, other.key)),
    };

    await test.step("the source moves and its open group, its point and a closed group stay", async () => {
      await dragBy(page, src.locator(".node-title"), { x: 140, y: 120 }, true);
      await expect.poll(async () => near(await flowPos(src), before.src), { message: "the source moved" }).toBeGreaterThan(40);
      await settled(page);
      await expectAt(group, before.group, "the open group");
      await expectAt(point, before.point, "the open point");
      await expectAt(clusterNode(page, S, other.key), before.other, "another group of the source");
    });
    const moved = await flowPos(src);

    await test.step("the save holds the source and the groups it left standing, and no point", async () => {
      const want = [`src:${S.id}`, ...groupsOf(S).map((g) => `cluster:${S.id}:${g.key}`)].sort();
      await expect.poll(async () => Object.keys(await layoutOf(page.request)).sort(), { message: "the save has landed" }).toEqual(want);
      await expectSaved(page.request, { [`src:${S.id}`]: moved, [`cluster:${S.id}:${K.key}`]: before.group }, "the source and the open group");
    });

    await test.step("collapsing and opening the source (a rebuild) leaves the children where they were", async () => {
      await ensureOnCanvas(page, src);
      await src.getByRole("button", { name: `Collapse ${S.name}`, exact: true }).click();
      await expect(group).toHaveCount(0);
      await ensureOnCanvas(page, src);
      await src.getByRole("button", { name: `Expand ${S.name}`, exact: true }).click();
      await expect(group).toBeVisible();
      await expect(point).toBeVisible();
      await expectAt(src, moved, "the source");
      await expectAt(group, before.group, "the open group");
      await expectAt(point, before.point, "the open point");
    });

    await test.step("and so does a reload", async () => {
      await openDiscovery(page);
      await expandSource(page, S);
      await expandGroup(page, S, K.key, P);
      await expectAt(src, moved, "the source");
      await expectAt(group, before.group, "the group");
      await expectAt(point, before.point, "the point");
    });
  });

  test("a group dropped on an asset opens the review and, with it, the group and its points are back where they started and nothing is saved; confirming maps them", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    const { S, K, P } = await pickModbus(page.request);
    await clearLayout(page.request);
    const target = await makeAsset(page.request, `${PREFIX} drop target`);
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openDiscovery(page);
      const [src, group, point] = [srcNode(page, S), clusterNode(page, S, K.key), pointNode(page, P.id)];
      await expandSource(page, S);
      await expandGroup(page, S, K.key, P);
      await ensureOnCanvas(page, assetNode(page, target.id));
      const before = { src: await flowPos(src), group: await flowPos(group), point: await flowPos(point) };

      await dragOnto(page, group.locator(".node-title"), assetNode(page, target.id));
      const dialog = page.getByRole("dialog", { name: "Review mappings", exact: true });
      await expect(dialog, "the drop is a request to map").toBeVisible();

      await test.step("the group and its point are back at their start places and the source never moved", async () => {
        await expectAt(group, before.group, "the group");
        await expectAt(point, before.point, "the point");
        await expectAt(src, before.src, "the source");
        await settled(page);
        expect(Object.keys(await layoutOf(page.request)), "nothing was saved").toEqual([]);
      });

      await test.step("confirming maps the group's points to the asset, and the places stay", async () => {
        await dialog.getByRole("button", { name: "Create mappings", exact: true }).click();
        await expect(dialog).toBeHidden({ timeout: 60_000 });
        const summary = await json<{ metrics: { metric: string }[] }>(page.request, `/api/assets/${target.id}/summary`);
        expect(summary.metrics.length, "the asset has the group's mappings").toBeGreaterThan(0);
        await expectAt(group, before.group, "the group after the mapping");
        await expectAt(point, before.point, "the point after the mapping");
        expect(Object.keys(await layoutOf(page.request)), "still nothing saved").toEqual([]);
      });
    } finally {
      await deleteAsset(page.request, target.id); // with its mappings: the Modbus source is unmapped again
    }
  });

  test("the documented limit (Decision 3, backlog AS): a group dragged out of a later source keeps its place when an earlier source opens and pushes that source down", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    await clearLayout(page.request);
    const graph = await graphOf(page.request);
    // A is an earlier source that has groups (opening it pushes everything below it down), B a later one with a group to drag.
    let pair: { A: ApiGraphSource; B: ApiGraphSource } | null = null;
    for (const [b, B] of graph.sources.entries()) {
      const A = graph.sources.slice(0, b).find((s) => groupsOf(s).length > 0);
      if (A && B.clusters.length > 0) { pair = { A, B }; break; }
    }
    if (!pair) {
      test.info().annotations.push({ type: "note", description: "no pair of sources (an earlier one with groups, a later one with a cluster) on this stack: the step is skipped" });
      return;
    }
    const { A, B } = pair;
    const key = B.clusters[0].key;
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDiscovery(page);
    const [srcB, groupB] = [srcNode(page, B), clusterNode(page, B, key)];
    await expandSource(page, B);
    const b0 = await flowPos(srcB);

    await dragBy(page, groupB.locator(".node-title"), { x: 0, y: 100 });
    await expect.poll(async () => (await flowPos(groupB)).y, { message: "the group was dragged" }).toBeGreaterThan(b0.y + SOURCE_H + 40);
    const dragged = await flowPos(groupB);
    const offer = page.getByRole("button", { name: "Dismiss", exact: true });
    if (await offer.isVisible()) await offer.click(); // the "Create asset from this cluster?" offer is not what this case is about
    await expectSaved(page.request, { [`cluster:${B.id}:${key}`]: dragged }, "the dragged group");

    await ensureOnCanvas(page, srcNode(page, A));
    await srcNode(page, A).getByRole("button", { name: `Expand ${A.name}`, exact: true }).click();
    await expect(clusterNode(page, A, groupsOf(A)[0].key)).toBeVisible();
    // The premise: the later source stands lower now (its place is the default one, measured from the earlier block) ...
    await expect.poll(async () => (await flowPos(srcB)).y, { message: "the later source was pushed down" }).toBeGreaterThan(b0.y + 30);
    // ... and the pin: the group has a place of its own, so it stays where it was dragged, however far its parent has gone. If a later change makes it follow, this
    // line is what to change on purpose (the plan's Decision 3: "Known limit, parked on purpose"; Tidy layout puts both right).
    await settled(page);
    await expectAt(groupB, dragged, "the dragged group (today it stays)");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

/** Where every source node stands (flow coordinates), by node id. */
const sourcePlaces = (page: Page): Promise<Record<string, XY>> =>
  page.locator('.react-flow__node[data-id^="src:"]').evaluateAll((els) => {
    const places: Record<string, XY> = {};
    for (const el of els) {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      places[el.getAttribute("data-id")!] = { x: m.m41, y: m.m42 };
    }
    return places;
  });

test.describe("W7t: the Discovery bar", () => {
  test("Tidy layout asks first (Escape changes nothing and returns the focus); Tidy for everyone empties the saved layout, after a drag that was still being saved, and every source is back in its default place", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    await clearLayout(page.request);
    const graph = await graphOf(page.request);
    expect(graph.sources.length, "the stack has sources").toBeGreaterThan(0);
    const [first, second] = graph.sources;
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDiscovery(page);
    const defaults = await sourcePlaces(page);
    expect(Object.keys(defaults).length, "a node for every source").toBe(graph.sources.length);

    // Places the person had saved: the sources far from their columns.
    await putLayout(page.request, { [`src:${first.id}`]: { x: -300, y: 40 }, ...(second ? { [`src:${second.id}`]: { x: -300, y: 400 } } : {}) });
    await openDiscovery(page);
    await expectAt(srcNode(page, first), { x: -300, y: 40 }, "the first source (saved)");

    await ensureOnCanvas(page, srcNode(page, first));
    await dragBy(page, srcNode(page, first).locator(".node-title"), { x: 60, y: 80 }); // its save may still be on its way when Tidy is pressed
    await expect.poll(async () => near(await flowPos(srcNode(page, first)), { x: -300, y: 40 }), { message: "the first source was dragged" }).toBeGreaterThan(20);

    const tidy = barButton(page, "Tidy layout");
    const dialog = page.getByRole("dialog", { name: TIDY_TITLE, exact: true });
    await test.step("Tidy layout asks for everyone; Escape closes the question, changes nothing and the focus is back on the button", async () => {
      await tidy.click();
      await expect(dialog).toBeVisible();
      await expect(dialog.locator(".confirm-body")).toContainText("Every node goes back to its default column for all users.");
      await expect(dialog.getByRole("button", { name: TIDY_CONFIRM, exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(tidy, "the focus is back on Tidy layout").toBeFocused();
      expect(Object.keys(await layoutOf(page.request)), "the saved places are still there").toContain(`src:${first.id}`);
    });

    await test.step("Tidy for everyone removes every saved place and the sources stand where they stand by default", async () => {
      await tidy.click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: TIDY_CONFIRM, exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect.poll(async () => Object.keys(await layoutOf(page.request)), { message: "the saved layout is empty" }).toEqual([]);
      for (const [id, place] of Object.entries(defaults)) await expectAt(node(page, id), place, `${id} (default)`);
      await page.waitForTimeout(500);
      expect(Object.keys(await layoutOf(page.request)), "and the drag's own save did not come back after it").toEqual([]);
    });
  });

  test("a role that may only view Discovery: Tidy layout asks nothing and sends nothing, its own view goes to the default places and a toast says so; the shared layout is untouched", async ({ page, browser }) => {
    test.setTimeout(240_000);
    await signIn(page);
    const graph = await graphOf(page.request);
    const first = graph.sources[0];
    expect(first, "the stack has a source").toBeDefined();
    await asAdmin(browser, async (request) => {
      await removeAccounts(request);
      const role = await request.post("/api/roles", { data: { name: VIEWER_ROLE, description: "made by w7t.spec.ts", permissions: ["discovery.view"] } });
      expect(role.status(), `creating the role: ${await role.text()}`).toBe(201);
      const user = await request.post("/api/users", { data: { username: VIEWER.username, password: VIEWER.password, role: VIEWER.role } });
      expect(user.status(), `creating the account: ${await user.text()}`).toBe(201);
      await clearLayout(request);
      await putLayout(request, { [`src:${first.id}`]: { x: -300, y: 40 } });
    });

    await signInAs(page, VIEWER);
    const sent: string[] = [];
    page.on("request", (request) => { if (request.method() !== "GET") sent.push(`${request.method()} ${new URL(request.url()).pathname}`); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDiscovery(page);
    await expect(userBlock(page)).toContainText(VIEWER.username);
    await expectAt(srcNode(page, first), { x: -300, y: 40 }, "the first source (the shared layout shows to everyone)");

    await barButton(page, "Tidy layout").click();
    await expect(toast(page, TIDY_SOLO).first(), "a toast says it is for them only").toBeVisible();
    await expect(page.getByRole("dialog"), "no question").toHaveCount(0);
    await expectAt(srcNode(page, first), { x: 0, y: 0 }, "the first source in the viewer's own view (default place)");
    expect(sent.filter((request) => request.includes("/api/discovery/layout")), `nothing was sent to the layout route (every write this page made: ${sent.join(", ") || "none"})`).toEqual([]);

    const layout = await asAdmin(browser, (request) => layoutOf(request));
    expect(layout[`src:${first.id}`], "the shared layout still has the saved place").toEqual({ x: -300, y: 40 });
  });

  test("the line above the canvas equals what the API holds; Expand all opens what fits the 600-node budget (and says so when something does not), Collapse all closes it; each waits when there is nothing to do", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    await clearLayout(page.request);
    const graph = await graphOf(page.request);
    const cost = expandCost(graph);
    const fits = cost.groups + cost.points + cost.more <= EXPAND_BUDGET;
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDiscovery(page);
    const [collapse, expand] = [barButton(page, "Collapse all"), barButton(page, "Expand all")];
    const groups = page.locator('.react-flow__node[data-id^="cluster:"]');
    const points = page.locator('.react-flow__node[data-id^="point:"]');

    await test.step("the summary line is the API's numbers, one announcer", async () => {
      const summary = page.locator(".graph-summary");
      await expect(summary).toHaveText(summaryOf(graph));
      await expect(summary).toHaveAttribute("aria-live", "polite");
      await expect(page.locator(".graph-bar [aria-live]"), "ONE live region in the bar").toHaveCount(1);
    });

    await test.step("at first nothing is open: Collapse all waits, Expand all is ready", async () => {
      await expect(groups).toHaveCount(0);
      await expect(collapse).toHaveAttribute("aria-disabled", "true");
      await expect(collapse).toHaveAttribute("title", "Nothing is open");
      await expect(expand).not.toHaveAttribute("aria-disabled", "true");
    });

    await test.step(fits ? "Expand all opens every source and group (it fits the budget), without a word" : "Expand all opens what fits and says what stays closed", async () => {
      await expand.click();
      if (fits) {
        await expect(groups, `a node for each of the ${cost.groups} groups`).toHaveCount(cost.groups);
        await expect(points, `and for each of the ${cost.points} points (a group over ${PAGE_SIZE} draws its first page)`).toHaveCount(cost.points);
        await expect(page.locator('.react-flow__node[data-id^="more:"]'), `and a Show ${PAGE_SIZE} more node for each of the ${cost.more} groups with points left out`).toHaveCount(cost.more);
        await expect(toast(page, GREW_NOTE), "nothing stays closed, so no toast").toHaveCount(0);
        await expect(expand).toHaveAttribute("aria-disabled", "true");
        await expect(expand).toHaveAttribute("title", "Everything is open");
      } else {
        await expect(toast(page, GREW_NOTE).first()).toBeVisible();
        await expect(expand, "something is still closed, so the button stays ready").not.toHaveAttribute("aria-disabled", "true");
      }
      await expect(collapse).not.toHaveAttribute("aria-disabled", "true");
    });

    await test.step("Collapse all closes everything and then waits", async () => {
      await collapse.click();
      await expect(groups).toHaveCount(0);
      await expect(points).toHaveCount(0);
      await expect(collapse).toHaveAttribute("aria-disabled", "true");
      await expect(expand).not.toHaveAttribute("aria-disabled", "true");
    });
  });

  test("at 1440 and at 1024 x 640: no sideways overflow, the bar and its three buttons whole, the hint short, a source node's Details, Create assets... and bin on ONE row, and the canvas opens on the first source with its Create assets button inside", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    await clearLayout(page.request);
    const graph = await graphOf(page.request);
    expect(graph.sources.length, "the stack has sources").toBeGreaterThan(0);
    const target = removable(graph).find((s) => s.connector_type === "modbus") ?? removable(graph)[0];
    if (!target) test.info().annotations.push({ type: "note", description: "no removable source on this stack: the node-button row is not measured" });

    for (const [width, height] of [[1440, 900], [1024, 640]] as const) {
      await test.step(`${width} x ${height}`, async () => {
        await page.setViewportSize({ width, height });
        await page.goto("/discovery"); // an ordinary window: openDiscovery would make it taller and press fit view, which would hide what is under test
        await expect(heading1(page, "Discovery")).toBeVisible();
        const first = srcNode(page, graph.sources[0]);
        await expect(first).toBeVisible({ timeout: 30_000 });
        await stopped(first);
        await settled(page);
        expect.soft(await overflowOf(page), `no sideways overflow at ${width}`).toBeLessThanOrEqual(1);

        // The bar: its summary and buttons lie inside it, in a row, without touching, and inside the window. W12b: a chevron joins Collapse all and Expand all and the Unmapped only
        // switch ends the row; the three old buttons keep their order.
        const barBox = await boxOf(bar(page), "the bar");
        expect.soft(barBox.height, "the bar is about 36 px high").toBeGreaterThanOrEqual(34);
        expect.soft(barBox.height).toBeLessThanOrEqual(40);
        const parts: [string, Box][] = [["the summary", await boxOf(page.locator(".graph-summary"), "the summary")]];
        for (const name of ["Collapse all", "Expand all", "Tidy layout"]) parts.push([name, await boxOf(barButton(page, name), name)]);
        parts.push(["Unmapped only", await boxOf(bar(page).locator(".graph-bar-switch"), "the Unmapped only switch")]);
        // A chevron is the other half of its button (it overlaps the button's border by 1 px on purpose): it is checked inside the bar, not for touching.
        const chevrons: [string, Box][] = [];
        for (const name of ["More ways to collapse", "More ways to expand"]) chevrons.push([name, await boxOf(barButton(page, name), name)]);
        for (const [what, box] of [...parts, ...chevrons]) {
          expect.soft(box.x, `${what}: left edge inside the bar`).toBeGreaterThanOrEqual(barBox.x - 1);
          expect.soft(box.x + box.width, `${what}: right edge inside the bar`).toBeLessThanOrEqual(barBox.x + barBox.width + 1);
          expect.soft(box.y, `${what}: top inside the bar`).toBeGreaterThanOrEqual(barBox.y - 1);
          expect.soft(box.y + box.height, `${what}: bottom inside the bar`).toBeLessThanOrEqual(barBox.y + barBox.height + 1);
          expect.soft(box.x + box.width, `${what}: inside the window`).toBeLessThanOrEqual(width + 1);
        }
        for (let i = 1; i < parts.length; i++) expect.soft(parts[i - 1][1].x + parts[i - 1][1].width, `${parts[i - 1][0]} and ${parts[i][0]} do not touch`).toBeLessThanOrEqual(parts[i][1].x + 1);
        const canvas = await boxOf(page.locator(".graph-canvas"), "the canvas");
        test.info().annotations.push({ type: "measure", description: `${width} x ${height}: the bar is ${barBox.height}px high, the canvas ${canvas.width} x ${canvas.height}px` });

        // The hint is the short one. W7u moved the keys (Alt or Option moves a node alone, and the rest) into the tip beside it.
        const hint = ((await page.locator(".page-head .sub").textContent()) ?? "").trim();
        expect.soft(hint, "the hint is the legend and the way to map").toContain("Dashed: discovered. Solid: assets.");
        expect.soft(hint.length, `the hint is ${hint.length} characters`).toBeLessThanOrEqual(150);
        if (width === 1440) {
          await page.getByRole("button", { name: "What can I do on the canvas?", exact: true }).click();
          expect.soft(await page.getByRole("note").innerText(), "the tip names Alt and Option").toContain("Alt or Option");
          await page.keyboard.press("Escape");
          await expect(page.getByRole("note"), "Escape closes the tip").toHaveCount(0);
        }
        if (width === 1440) await shot(page, "discovery-bar-1440");

        // The source node: Details, Create assets... and the bin (no text) on one row, inside the node.
        if (target) {
          const row = srcNode(page, target).locator(".gnode-actions");
          const buttons = await row.getByRole("button").all();
          expect.soft(buttons.length, "Details, Create assets... and Remove").toBeGreaterThanOrEqual(2);
          const nodeBox = await boxOf(srcNode(page, target).locator(".gnode"), "the source node");
          const centres: number[] = [];
          for (const button of buttons) {
            const box = await boxOf(button, "a node button");
            centres.push(centreOf(box).y);
            expect.soft(box.x, "a node button: left").toBeGreaterThanOrEqual(nodeBox.x - 1);
            expect.soft(box.x + box.width, "a node button: right").toBeLessThanOrEqual(nodeBox.x + nodeBox.width + 1);
            expect.soft(box.y + box.height, "a node button: bottom").toBeLessThanOrEqual(nodeBox.y + nodeBox.height + 1);
          }
          expect.soft(Math.max(...centres) - Math.min(...centres), `the node's ${buttons.length} buttons share one row (centres ${centres.map((c) => c.toFixed(1)).join(", ")})`).toBeLessThanOrEqual(2);
          const remove = row.getByRole("button", { name: `Remove ${target.name} from Discovery`, exact: true });
          await expect.soft(remove, "the bin keeps its name").toHaveCount(1);
          await expect.soft(remove).toHaveAttribute("title", "Remove");
          expect.soft((await remove.innerText()).trim(), "and has no visible text").toBe("");
          expect.soft((await boxOf(remove, "the bin")).width, "just an icon wide").toBeLessThanOrEqual(40);
        }

        if (width === 1024) {
          // w7r's check, with the bar: the graph opens on the first sources, readable, and the first source's title and Create assets button are inside the canvas.
          const inCanvas = (box: Box) =>
            box.x >= canvas.x - 1 && box.y >= canvas.y - 1 && box.x + box.width <= canvas.x + canvas.width + 1 && box.y + box.height <= canvas.y + canvas.height + 1;
          const title = first.locator(".node-title");
          expect.soft(inCanvas(await boxOf(title, "the first source's title")), "the first source's title lies inside the canvas box").toBe(true);
          const zoom = await zoomOf(page);
          const size = await title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
          expect.soft(zoom, "the opening zoom is held between 0.75 and 1").toBeGreaterThanOrEqual(0.749);
          expect.soft(zoom).toBeLessThanOrEqual(1.001);
          expect.soft(size * zoom, `the title is ${size}px at zoom ${zoom}`).toBeGreaterThanOrEqual(8.99);
          let checked = false;
          for (const source of graph.sources.slice(0, 3)) {
            const button = srcNode(page, source).getByRole("button", { name: /^Create assets for \d+ groups? of / });
            if ((await button.count()) === 0) continue;
            expect.soft(inCanvas(await boxOf(button, "Create assets")), `${source.name}: Create assets lies inside the canvas box`).toBe(true);
            checked = true;
            break;
          }
          if (!checked) test.info().annotations.push({ type: "note", description: "none of the first three sources has a Create assets button on this stack" });
        }
      });
    }
  });

  test("the canvas does not drop when the graph arrives: with the graph held for 1.5 s, .graph-layout starts at the same height in the loading branch and once loaded, at 1440 x 900, 1024 x 640 and 800 x 600", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    await page.route("**/api/discovery/graph", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return route.continue();
    });
    try {
      for (const [width, height] of [[1440, 900], [1024, 640], [800, 600]] as const) {
        await test.step(`${width} x ${height}`, async () => {
          await page.setViewportSize({ width, height });
          await page.goto("/discovery");
          // The loading branch: the place held for the bar is there (and the bar is not), the canvas is the skeleton region.
          await expect(page.locator(".graph-bar-space")).toBeVisible({ timeout: 30_000 });
          await expect(bar(page)).toHaveCount(0);
          await page.evaluate(() => document.fonts.ready);
          const loadingTop = (await boxOf(page.locator(".graph-layout"), "the canvas row while loading")).y;
          // The graph arrives: the bar is drawn and the placeholder is gone.
          await expect(bar(page)).toBeVisible({ timeout: 30_000 });
          await expect(page.locator(".graph-bar-space")).toHaveCount(0);
          await expect(page.locator(".graph-canvas")).toBeVisible();
          await page.evaluate(() => document.fonts.ready);
          const loadedTop = (await boxOf(page.locator(".graph-layout"), "the canvas row once loaded")).y;
          test.info().annotations.push({ type: "measure", description: `${width} x ${height}: .graph-layout top ${loadingTop.toFixed(1)} while loading, ${loadedTop.toFixed(1)} loaded` });
          expect.soft(Math.abs(loadedTop - loadingTop), `the canvas row starts at ${loadingTop} while loading and at ${loadedTop} once the graph is in (a drop of ${(loadedTop - loadingTop).toFixed(1)}px)`).toBeLessThanOrEqual(0.5);
        });
      }
    } finally {
      await page.unroute("**/api/discovery/graph");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7t: the Scans page", () => {
  test("the scope form names the ports it knows, warns (never blocks) about one that looks like a typo, warns in the Edit form too, and does not move under the typing", async ({ page }) => {
    test.setTimeout(150_000);
    await signIn(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/scans");
    await expect(heading1(page, "Scans")).toBeVisible();
    await page.getByRole("button", { name: "New scope", exact: true }).click();
    const ports = page.getByLabel("Ports");
    await expect(ports).toBeVisible();
    await page.getByLabel("Name").fill(FORM_SCOPE);
    await page.getByLabel("Targets").fill("simulator");
    const note = page.locator("#scope-ports-note");
    const warnings = note.locator(".warning");
    const saveButton = page.getByRole("button", { name: "Save", exact: true });
    const typo = "4080 is not a port any connector uses; did you mean 4840 (OPC UA)?";

    await ports.fill("80");
    await expect(warnings, "80 is an everyday port").toHaveCount(0);
    const saveAt = (await boxOf(saveButton, "Save")).y;

    await test.step("4080 warns, naming 4840 (OPC UA), in the slot that was already there", async () => {
      await ports.fill("4080");
      await expect(warnings).toHaveText(typo);
      await shot(page, "scans-form-warning-1440");
      expect(Math.abs((await boxOf(saveButton, "Save")).y - saveAt), "Save did not move").toBeLessThanOrEqual(1);
    });

    await test.step("the ports it knows read with their names, and 8080 is quiet", async () => {
      await ports.fill("502 4840");
      await expect(warnings).toHaveCount(0);
      await expect(note).toHaveText("Reads as 502 (Modbus), 4840 (OPC UA)");
      expect(Math.abs((await boxOf(saveButton, "Save")).y - saveAt), "Save did not move for the readout").toBeLessThanOrEqual(1);
      await ports.fill("80 8080");
      await expect(warnings).toHaveCount(0);
    });

    await test.step("a warning never blocks: 4840 4080 saves, and the Ports cell names 4840", async () => {
      await ports.fill("4840 4080");
      await expect(warnings).toHaveText(typo);
      await saveButton.click();
      await expect(toast(page, "Scan scope created").first()).toBeVisible();
      const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: FORM_SCOPE, exact: true }) });
      await expect(row).toBeVisible();
      await expect(row.getByRole("cell").nth(2)).toHaveText("4840 (OPC UA), 4080");

      await (await rowAction(page, row, "Edit")).click();
      await expect(page.getByLabel("Ports")).toHaveValue("4840, 4080");
      await expect(page.locator("#scope-ports-note .warning"), "the Edit form warns too").toHaveText(typo);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByLabel("Ports")).toHaveCount(0);
    });
  });

  test("Scan again previews the same scope and brings its confirmation into view at 1024 x 640; a scan of a deleted scope has the button aria-disabled with its reason", async ({ page }) => {
    test.setTimeout(400_000);
    await signIn(page);
    // Padding scopes make the Scopes table tall, so the confirmation (it stands above that table) is off screen when the button low in Recent scans is pressed.
    for (let i = 1; i <= 6; i++) await scopeNamed(page.request, `${PREFIX} pad ${i}`, [9000]);
    const goneScope = await scopeNamed(page.request, GONE_SCOPE, [9000]);
    const goneScan = await runScan(page.request, goneScope.id);
    const deleted = await page.request.delete(`/api/scopes/${goneScope.id}`);
    expect(deleted.status(), "deleting the scope after its scan").toBe(204);

    await page.setViewportSize({ width: 1024, height: 640 });
    await page.goto("/scans");
    await expect(heading1(page, "Scans")).toBeVisible();
    const again = page.locator(`[data-scan-again="${simScanId}"]`);
    await expect(again).toBeVisible({ timeout: 30_000 });
    const panel = page.locator(".confirm-scan");

    await test.step("the button of a scan whose scope exists is ready and says what it does", async () => {
      await expect(again).not.toHaveAttribute("aria-disabled", "true");
      await expect(again).toHaveAttribute("title", `Preview and scan "${SIM_SCOPE}" again`);
    });

    await test.step("pressed low on the page, it opens the preview of the same scope, the confirmation is in view and the focus stays on the button", async () => {
      await again.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await settled(page);
      const nav = await page.locator(".navbar").boundingBox();
      const top = nav ? Math.max(0, nav.y + nav.height) : 0;
      const title = await boxOf(heading1(page, "Scans"), "the page title");
      expect(title.y + title.height, "the page was scrolled: the title and the place of the confirmation are out of view").toBeLessThan(top);
      await again.click();
      await expect(panel).toBeVisible();
      await expect(panel.locator(".confirm-title")).toHaveText(`Scan "${SIM_SCOPE}"?`);
      await expect(panel).toContainText("1 host × 2 ports (2 checks)");
      await expect
        .poll(async () => {
          const box = await panel.boundingBox();
          return box !== null && box.y >= top - 1 && box.y + box.height <= 640 + 1;
        }, { message: "the confirmation is brought into view" })
        .toBe(true);
      await expect(again, "the focus stays on the pressed button").toBeFocused();
      await panel.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(panel).toHaveCount(0);
    });

    await test.step("the scan of a deleted scope: aria-disabled (never native disabled), the reason as its title, and a click opens nothing", async () => {
      const gone = page.locator(`[data-scan-again="${goneScan}"]`);
      await gone.scrollIntoViewIfNeeded();
      await expect(gone).toHaveAttribute("aria-disabled", "true");
      await expect(gone).toHaveAttribute("title", "The scope was deleted.");
      expect(await gone.evaluate((el) => el.hasAttribute("disabled")), "not a native disabled button").toBe(false);
      await gone.click({ force: true }); // an aria-disabled button is "not enabled" to Playwright: force skips that check
      await settled(page);
      await expect(panel, "no confirmation").toHaveCount(0);
    });
  });
});
