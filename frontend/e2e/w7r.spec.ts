import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { rowAction, userBlock } from "./shell";

// W7r (Scans and Discovery tidy: a Scan drawer, readable numbers and the scope, remove and clear discovered leftovers, a last-seen line on
// every node, a hand-added source that wins over a discovered duplicate, and a button that turns a source's groups into assets) on the state
// the earlier projects leave behind: admin `admin` / `correct-horse`. The stack is SHARED and w7r is its LAST project, because Clear unmapped
// removes EVERY unmapped discovered source of the stack, not only this spec's: after `discovery.spec` that is the Modbus source at
// simulator:5020 (the OPC UA source has all its 60 points mapped, the HTTP simulator is the hand-added `sim`), so the cases below read what is
// removable from GET /api/discovery/graph at the moment they need it and never assume a number.
// The Discovery graph is as tall as the stack's assets (64 px each, React Flow will not zoom out past 0.5), so openDiscovery makes the window
// tall enough first and then presses the Controls' fit view (the canvas now opens on the first sources instead of on the whole graph); the one
// case that looks at the opening view itself (the last layout case) loads /discovery directly in an ordinary window. What the spec makes starts `W7r <run> ` (the
// digits-only run suffix), the accounts and roles `w7r-`; afterAll (and beforeAll, for an earlier run that stopped half way) removes, whatever
// the run, the assets (with `?confirm=true`, so their mappings go too and the sources are unmapped again), the hand-added source, the scopes,
// then the accounts and the roles. Scans cannot be deleted and stay in Recent scans. The admin signs in through the API.
//
// Every case makes its own state: it runs a scan of this run's scope through the API (preview, then start with the host count and the digest,
// then poll until `done`: a second start while one runs is a 409) and reads the graph. Scopes use the target `simulator` (the same string
// discovery.spec used, so the endpoint keys match) and the ports 9000 and 5020: 9000 is the hand-added `sim` (found as `existing source`,
// not browsed), 5020 is the Modbus simulator (the discovered source with ten groups of six points); 4840 is left out, a scan would browse
// the 60-point OPC UA source again for nothing.
//
// The cases (the file runs in this order; one failing does not stop the next):
//   drawer        Scans, Details opens a dialog named `Scan #<id> — done` (an em dash) with the scope line and its ports, a stats line that says
//                 `checks` (not `ports checked`), the page behind locked (<html> overflow hidden, the shell inert) and unlocked again; Escape, the
//                 x and a click outside each close it and the focus is on THAT row's Details button.
//   numbers       the Recent scans cell reads `N source(s), M point(s)` (from the API's progress), the header is `Sources / points`, the title
//                 says it longer, the drawer's stats agree.
//   ports visible a scope saved with the mistyped port 4080 is scanned FROM THE PAGE (Scan, Start scan: the drawer opens by itself); its row's
//                 Scope cell and the drawer's scope line both show 4080.
//   last seen     `Seen in scan #<id>, <ago>` on every discovered node a scan found, `Added by hand` on the hand-added one, and the same line in
//                 the source panel.
//   remove one    a discovered source with nothing mapped has Remove; the dialog (Escape gives the focus back), confirm; the node is gone, its
//                 layout rows too, the focus is on Refresh, a toast, the Audit page reads `Deleted source <name>` and the row's detail says
//                 `unmapped_only`.
//   clear         `Clear unmapped (N)`: the dialog lists the names the API lists (one source reads as the single-source dialog), Escape returns
//                 the focus, confirm removes exactly those, the button is aria-disabled at 0, a rescan brings the Modbus source back as a new row.
//   scan running  while a scan is queued or running the remove route answers 409 with the sentence the dialog shows, whatever the ids.
//   mapped safe   ONE point of the Modbus source's sixty is mapped to an asset of the case (so a check that wants every point mapped, or
//                 compares mapped points with the point count, would let it go): its node has no Remove, it is not in the Clear list, and a
//                 direct POST gives `skipped: mapped` (also for a fully mapped source, `manual` for the hand-added one and `gone` for an
//                 id that does not exist), leaving it whole; the asset is deleted at the end, which unmaps the source again.
//   manual wins   a hand-added Modbus source at simulator:5020, made AFTER a scan created the discovered one: the next scan's 5020 finding is
//                 that source and says `existing source`, and the older discovered duplicate is not browsed (its last scan stays the old one).
//   permission    a role with `discovery.view` only sees the nodes and none of Remove, Clear unmapped, Create assets; the API answers 403 and
//                 the source stays; a role with `discovery.edit` as well sees Remove and Clear unmapped and still no Create assets.
//   layout        at 1440 and 1024 px: no horizontal overflow on Scans and Discovery, the drawer fits the window, the header actions fit, the three
//                 buttons of a source node stay inside it; and a fresh load at 1024 x 640 (the window as it is) opens on the first sources: the first
//                 Create assets button is inside the canvas and the title text is at least 9 px at the opening zoom.
//   create assets (LAST: it maps the Modbus source) the collapsed source node has `Create assets for N groups of <name>`; its dialog lists the
//                 groups, one parent, two groups chosen and renamed; the assets exist under the parent with six mappings each, the audit log
//                 counts two more accepts, the focus is back on the node's button.
//
// Locators. A scan's row is `tr:has([data-scan-details="<id>"])` (the Scope name `cell-name` is also in the Scopes table). Playwright matches a
// name by case-insensitive SUBSTRING: `Remove`, `Details`, `Close`, `Cancel` and `Refresh` are `exact: true`; a source node's buttons are named
// by their aria-label (`Details for <name>`, `Remove <name> from Discovery`, `Create assets for N groups of <name>`, a regular expression with the
// name escaped: it holds `:`); the confirm button of the delete dialog is `Remove` and the bulk dialog's is `Create 2 assets` (the node's button
// has a longer name). The numbers use the em dash and the multiplication sign the page uses.

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse" };
const RUN = Date.now().toString();
const PREFIX = `W7r ${RUN}`;
const SIM_SCOPE = `${PREFIX} sim`;
const TYPO_SCOPE = `${PREFIX} typo`;
const MANUAL_NAME = `${PREFIX} by hand`;
/** Every name any run of this spec made: the digits-only run suffix after `W7r `. */
const anyRun = (name: string) => /^W7r \d+ /.test(name);

const READER_ROLE = "w7r-reader-role"; // discovery.view only
const READER = { username: "w7r-reader", password: "w7r-reader-pass", role: READER_ROLE };
const EDITOR_ROLE = "w7r-editor-role"; // discovery.view + discovery.edit: Remove and Clear unmapped, not Create assets
const EDITOR = { username: "w7r-editor", password: "w7r-editor-pass", role: EDITOR_ROLE };

const SCAN_RUNNING = "A scan is running. Remove discovered sources when it has finished.";
const GONE = 2147483647; // the largest id the route accepts and no source has
const METRICS = ["active_power_kw", "energy_kwh", "voltage_v", "current_a", "power_factor", "frequency_hz"];

interface ApiPoint { id: number; name: string; mapping_id: number | null; asset_id: number | null; suggestion: { metric: string; scale: number } }
interface ApiCluster { key: string; points: ApiPoint[] }
interface ApiGraphSource {
  id: number; name: string; connector_type: string; origin: "manual" | "discovered"; point_count: number;
  last_scan: { scan_id: number; at: string } | null; clusters: ApiCluster[]; ungrouped: ApiPoint[];
}
interface ApiGraph { sources: ApiGraphSource[]; assets: { id: number }[]; unidentified: unknown[]; layout: Record<string, { x: number; y: number }> }
interface ApiScope { id: number; name: string }
interface ApiFinding { host: string; port: number; source_id: number | null; connector_type: string | null; outcome: string; detail: string }
interface ApiScan {
  id: number; status: string; error: string | null; scope_name: string; targets: string[]; ports: number[];
  progress: Record<string, number>; findings: ApiFinding[];
}
interface ApiAsset { id: number; name: string; parent_id: number | null }
interface ApiRole { id: number; name: string; builtin: boolean }
interface ApiUser { id: number; username: string }
interface ApiSource { id: number; name: string }
interface ApiAudit { action: string; detail: Record<string, unknown> }
interface RemoveAnswer { removed: { id: number; name: string }[]; skipped: { id: number; name: string | null; reason: string }[] }

// ---------------------------------------------------------------------------------------------------------------------------------
// What the page works out from the graph, written here again so a change of wording is a change of this spec

const pointsOf = (source: ApiGraphSource) => [...source.clusters.flatMap((c) => c.points), ...source.ungrouped];
const isMapped = (source: ApiGraphSource) => pointsOf(source).some((p) => p.mapping_id !== null || p.asset_id !== null);
/** Discovered and nothing mapped, in the order the graph lists them (name, id): the order the page's Clear unmapped uses. */
const removable = (graph: ApiGraph) => graph.sources.filter((s) => s.origin === "discovered" && !isMapped(s));
const modbusOf = (graph: ApiGraph) => graph.sources.find((s) => s.origin === "discovered" && s.connector_type === "modbus");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "A and B", "A, B and C", and past five "A, B, C, D, E and 2 more" (lib/graph.ts nameList). */
function nameList(names: readonly string[]): string {
  if (names.length > 5) return `${names.slice(0, 5).join(", ")} and ${names.length - 5} more`;
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
/** The title and the sentence of the delete dialog (lib/graph.ts removalDialogText): one source reads differently from several. */
function removeDialogText(names: readonly string[]): { title: string; message: string } {
  if (names.length === 1) {
    return {
      title: `Remove "${names[0]}" from Discovery?`,
      message: "It has nothing mapped, so no asset, billing figure or dashboard depends on it. A scan can find it again.",
    };
  }
  return {
    title: `Remove ${names.length} unmapped sources?`,
    message: `${nameList(names)}. Sources with a mapped point are never touched. A scan can find these again.`,
  };
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

/** This run's scope, made on first use. */
async function scopeNamed(request: APIRequestContext, name: string, ports: number[]): Promise<ApiScope> {
  const found = (await json<ApiScope[]>(request, "/api/scopes")).find((s) => s.name === name);
  if (found) return found;
  const made = await request.post("/api/scopes", { data: { name, targets: ["simulator"], ports } });
  expect(made.status(), `creating the scope ${name}: ${await made.text()}`).toBe(201);
  return (await made.json()) as ApiScope;
}
const simScope = (request: APIRequestContext) => scopeNamed(request, SIM_SCOPE, [9000, 5020]);

/** Previews the scope and starts a scan with the host count and the digest the preview gave (what the page does). Returns at once, the scan runs. */
async function startScan(request: APIRequestContext, scopeId: number): Promise<number> {
  const preview = await json<{ hosts: number; digest: string }>(request, `/api/scopes/${scopeId}/preview`);
  const started = await request.post(`/api/scopes/${scopeId}/scan`, { data: { confirm_host_count: preview.hosts, digest: preview.digest } });
  expect(started.status(), `starting the scan: ${await started.text()}`).toBe(202);
  return ((await started.json()) as { scan_id: number }).scan_id;
}

/** Polls the scan until it has ended and asserts that it ended `done` (a second scan cannot start while one is queued or running). */
async function finished(request: APIRequestContext, scanId: number): Promise<ApiScan> {
  let last: ApiScan | undefined;
  await expect
    .poll(async () => {
      last = await json<ApiScan>(request, `/api/scans/${scanId}`);
      return last.status === "done" || last.status === "failed";
    }, { timeout: 150_000, intervals: [500, 1000, 2000], message: `scan #${scanId} never ended` })
    .toBe(true);
  expect(last!.status, `scan #${scanId} ended ${last!.status}: ${last!.error}`).toBe("done");
  return last!;
}
const runScan = async (request: APIRequestContext, scopeId: number) => finished(request, await startScan(request, scopeId));

async function makeAsset(request: APIRequestContext, name: string, parentId: number | null = null): Promise<ApiAsset> {
  const made = await request.post("/api/assets", { data: { name, parent_id: parentId, kind: "generic", sort_order: 0 } });
  expect(made.status(), `creating the asset ${name}: ${await made.text()}`).toBe(201);
  return (await made.json()) as ApiAsset;
}

/** Maps one point of the source (a guess that is not "custom") to the asset through the same route the page uses. */
async function mapOnePoint(request: APIRequestContext, source: ApiGraphSource, asset: ApiAsset): Promise<void> {
  const point = pointsOf(source).find((p) => p.mapping_id === null && p.suggestion.metric !== "custom");
  expect(point, `${source.name} has an unmapped point with a known metric`).toBeDefined();
  const made = await request.post("/api/discovery/accept", {
    data: { source_id: source.id, asset_id: asset.id, points: [{ point_id: point!.id, metric: point!.suggestion.metric, scale: point!.suggestion.scale }] },
  });
  expect(made.status(), `mapping a point of ${source.name}: ${await made.text()}`).toBe(201);
}

async function auditItems(request: APIRequestContext, action: string): Promise<ApiAudit[]> {
  return (await json<{ items: ApiAudit[] }>(request, `/api/audit?action=${action}&limit=200`)).items;
}
const auditTotal = async (request: APIRequestContext, action: string) => (await json<{ total: number }>(request, `/api/audit?action=${action}&limit=1`)).total;

/** Every account whose name starts with w7r-, then every custom role that does (a role an account holds cannot be deleted). */
async function removeAccounts(request: APIRequestContext): Promise<void> {
  for (const user of (await json<ApiUser[]>(request, "/api/users")).filter((u) => u.username.startsWith("w7r-"))) {
    const gone = await request.delete(`/api/users/${user.id}`);
    expect([204, 404], `deleting ${user.username}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
  for (const role of (await json<ApiRole[]>(request, "/api/roles")).filter((r) => !r.builtin && r.name.toLowerCase().startsWith("w7r-"))) {
    const gone = await request.delete(`/api/roles/${role.id}`);
    expect([204, 404], `deleting the role ${role.name}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
}

/** The assets (their mappings go with them), the hand-added source and the scopes of every run of this spec, newest first; the failures are collected. */
async function removeLeftovers(request: APIRequestContext, failures: string[]): Promise<void> {
  const attempt = async (what: string, step: () => Promise<void>) => {
    try {
      await step();
    } catch (e) {
      failures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await attempt("the assets", async () => {
    for (const asset of (await json<ApiAsset[]>(request, "/api/assets")).filter((a) => anyRun(a.name)).sort((a, b) => b.id - a.id)) {
      const gone = await request.delete(`/api/assets/${asset.id}?confirm=true`);
      expect([200, 204, 404], `deleting the asset ${asset.name}: ${gone.status()}`).toContain(gone.status());
    }
  });
  await attempt("the hand-added source", async () => {
    for (const source of (await json<ApiSource[]>(request, "/api/sources")).filter((s) => anyRun(s.name))) {
      const gone = await request.delete(`/api/sources/${source.id}?confirm=true`);
      expect([204, 404], `deleting the source ${source.name}: ${gone.status()}`).toContain(gone.status());
    }
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

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const toast = (page: Page, text: string) => page.locator(".toast-stack .toast").filter({ hasText: text });
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const srcNode = (page: Page, source: { id: number }) => node(page, `src:${source.id}`);
const refreshButton = (page: Page) => page.getByRole("button", { name: "Refresh", exact: true });
const clearButton = (page: Page, count: number | RegExp = /\d+/) =>
  page.getByRole("button", { name: typeof count === "number" ? `Clear unmapped (${count})` : new RegExp(`^Clear unmapped \\(${count.source}\\)$`), exact: typeof count === "number" });
const removeButton = (page: Page, source: { name: string }) => page.getByRole("button", { name: `Remove ${source.name} from Discovery`, exact: true });
const detailsButton = (page: Page, source: { name: string }) => page.getByRole("button", { name: `Details for ${source.name}`, exact: true });
const createButton = (page: Page, source: { name: string }) => page.getByRole("button", { name: new RegExp(`^Create assets for \\d+ groups? of ${escaped(source.name)}$`) });
const scanRow = (page: Page, scanId: number) => page.locator(`tr:has([data-scan-details="${scanId}"])`);
const scanDrawer = (page: Page, scanId: number, status = "done") => page.getByRole("dialog", { name: `Scan #${scanId} — ${status}`, exact: true });

/** Resolves once `target` has stopped moving: React Flow animates the viewport and the drawer slides in, and boxes taken mid-animation are stale. */
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

/** Re-fit when `target` is not fully inside the canvas (a node that is off-screen cannot be clicked). */
async function ensureOnCanvas(page: Page, target: Locator) {
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  const box = await target.boundingBox();
  const inside = box !== null && box.x >= pane.x && box.y >= pane.y && box.x + box.width <= pane.x + pane.width && box.y + box.height <= pane.y + pane.height;
  if (!inside) await fitView(page, target);
}

/**
 * Opens Discovery and waits until the canvas has drawn at least one node (the heading is also in the loading skeleton).
 * The canvas opens on the first three sources (W7r fix wave), so every case here presses the Controls' fit view first: they were written for the
 * whole graph in view. React Flow's fit view will not zoom out past 0.5 and the asset column is 64 px per asset (the source column 176 px per collapsed source), so on this
 * stack, at the end of the chain and with dozens of assets, the first sources would sit above the window and could not be clicked. The window is made
 * tall enough for the whole graph at that zoom first (the page is exactly one window tall, so the canvas follows). Read with the signed-in
 * account's own graph: every role that sees the page may read it.
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

/** Opens Scans and waits until the Recent scans table has its Details buttons. */
async function openScans(page: Page): Promise<void> {
  await page.goto("/scans");
  await expect(heading1(page, "Scans")).toBeVisible();
  await expect(page.locator("[data-scan-details]").first()).toBeVisible({ timeout: 30_000 });
}

/** What locks the page behind a drawer: <html> overflow and the inert shell. */
const lockState = (page: Page) =>
  page.evaluate(() => ({
    overflow: getComputedStyle(document.documentElement).overflow,
    inert: document.querySelector(".shell")?.hasAttribute("inert") ?? false,
  }));

/** How far past its box each scrolling frame and the page itself reach sideways, in px (0 when nothing overflows). */
const sideways = (page: Page) =>
  page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    frames: [...document.querySelectorAll<HTMLElement>(".table-wrap")].map((el) => el.scrollWidth - el.clientWidth),
  }));

/** Asserts that the box lies inside the window, give or take a pixel. */
async function expectInWindow(page: Page, target: Locator, what: string) {
  const view = page.viewportSize()!;
  const box = (await target.boundingBox())!;
  expect(box, `${what} is laid out`).toBeTruthy();
  expect(box.x, `${what}: left edge`).toBeGreaterThanOrEqual(-1);
  expect(box.y, `${what}: top edge`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `${what}: right edge, window ${view.width}`).toBeLessThanOrEqual(view.width + 1);
  expect(box.y + box.height, `${what}: bottom edge, window ${view.height}`).toBeLessThanOrEqual(view.height + 1);
}

// ---------------------------------------------------------------------------------------------------------------------------------

test.beforeAll(async ({ browser }) => {
  await asAdmin(browser, async (request) => {
    const failures: string[] = [];
    await removeLeftovers(request, failures); // an earlier run that stopped half way
    expect(failures, "clearing the leftovers of an earlier run").toEqual([]);
  });
});

test.afterAll(async ({ browser }) => {
  const failures: string[] = [];
  await asAdmin(browser, (request) => removeLeftovers(request, failures));
  expect(failures, "the clean-up left something behind").toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7r: the Scans page", () => {
  test("Details opens the scan in a drawer that says what was scanned; Escape, the x and a click outside close it and the focus is on that row's Details", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    const scan = await runScan(page.request, (await simScope(page.request)).id);
    expect(scan.progress.hosts, "the scope is one host").toBe(1);
    expect(scan.progress.pairs, "and two ports").toBe(2);

    await openScans(page);
    const details = page.locator(`[data-scan-details="${scan.id}"]`);
    const drawer = scanDrawer(page, scan.id);
    const open = async () => {
      if (!(await drawer.isVisible())) await details.click();
      await expect(drawer).toBeVisible();
    };

    await test.step("the dialog is named for the scan and its status, and says what was scanned", async () => {
      await open();
      await expect(drawer.locator(".scan-scope")).toHaveText(`${SIM_SCOPE}: simulator, ports 9000, 5020`);
      await expect(drawer.locator(".scan-stats")).toContainText("2 checks (1 host × 2 ports)");
      await expect(drawer.locator(".scan-stats"), "the old wording is gone").not.toContainText("ports checked");
      await expect(drawer.getByRole("table").locator("tbody tr"), "one finding per open port").toHaveCount(scan.findings.length);
      await expect(drawer.getByRole("link", { name: "Open the discovery graph", exact: true })).toBeVisible();
    });

    await test.step("the page behind is locked while it is open", async () => {
      expect(await lockState(page), "<html> does not scroll and the shell is inert").toEqual({ overflow: "hidden", inert: true });
      // A wheel turn over the dimmed page moves nothing (when the page is short enough not to scroll at all this proves nothing, the lock above does).
      const before = await page.evaluate(() => window.scrollY);
      await page.mouse.move(100, 400);
      await page.mouse.wheel(0, 600);
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      expect(await page.evaluate(() => window.scrollY), "the page behind did not scroll").toBe(before);
    });

    for (const [how, close] of [
      ["Escape", () => page.keyboard.press("Escape")],
      ["the x", () => drawer.getByRole("button", { name: "Close", exact: true }).click()],
      ["a click outside", () => page.locator(".drawer-backdrop").click({ position: { x: 20, y: 300 } })],
    ] as const) {
      await test.step(`${how} closes it, unlocks the page and puts the focus on this row's Details`, async () => {
        await open();
        await stopped(drawer);
        await close();
        await expect(drawer).toBeHidden();
        await expect(details, `the focus is on Details of scan #${scan.id}`).toBeFocused();
        await expect.poll(async () => (await lockState(page)).inert, { message: "the shell is live again" }).toBe(false);
        expect((await lockState(page)).overflow, "and the page scrolls again").not.toBe("hidden");
      });
    }
  });

  test("Recent scans reads 'N sources, M points' under 'Sources / points', and the drawer agrees", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    const scan = await runScan(page.request, (await simScope(page.request)).id);
    const sources = Math.max(0, (scan.progress.claimed ?? 0) - (scan.progress.needs_credentials ?? 0));
    const points = scan.progress.points ?? 0;

    await openScans(page);
    await expect(page.getByRole("columnheader", { name: "Sources / points", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Claimed / points", exact: true }), "the old header is gone").toHaveCount(0);
    const row = scanRow(page, scan.id);
    const cell = row.locator("td.scan-figures");
    await expect(cell).toHaveText(`${plural(sources, "source")}, ${plural(points, "point")}`);
    await expect(cell).toHaveText(/^\d+ sources?, \d+ points?$/);
    await expect(cell, "the title says it longer").toHaveAttribute("title", `${plural(sources, "source")} recognised, ${plural(points, "point")} found`);
    await expect(row.locator(".cell-sub"), "the Scope cell shows what was scanned").toHaveText("simulator, ports 9000, 5020");

    await row.locator("[data-scan-details]").click();
    const stats = scanDrawer(page, scan.id).locator(".scan-stats");
    await expect(stats).toContainText(`${scan.progress.open} open`);
    await expect(stats).toContainText(`${plural(sources, "source")} recognised`);
    await expect(stats).toContainText(plural(points, "point"));
  });

  test("a scope saved with the mistyped port 4080 shows 4080 in its scan's Scope cell and in the drawer that opens when the scan starts", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    const typo = await scopeNamed(page.request, TYPO_SCOPE, [9000, 4080]);
    await page.goto("/scans");
    await expect(heading1(page, "Scans")).toBeVisible();

    const scopeRowOf = page.getByRole("row").filter({ has: page.getByRole("cell", { name: typo.name, exact: true }) });
    await (await rowAction(page, scopeRowOf, "Scan")).click();
    await expect(page.getByText("1 hosts × 2 ports (2 checks)")).toBeVisible();
    await page.getByRole("button", { name: "Start scan", exact: true }).click();

    // A started scan opens its drawer by itself; its id is in the title.
    const drawer = page.getByRole("dialog", { name: /^Scan #\d+/ });
    await expect(drawer).toBeVisible();
    const title = drawer.getByRole("heading", { level: 2 });
    await expect(title).toHaveText(/^Scan #\d+ — done$/, { timeout: 120_000 });
    const id = Number(/#(\d+)/.exec(await title.innerText())![1]);
    await expect(drawer.locator(".scan-scope")).toHaveText(`${TYPO_SCOPE}: simulator, ports 9000, 4080`);
    await expect(drawer.locator(".scan-stats")).toContainText("2 checks (1 host × 2 ports)");
    await expect(drawer.locator(".scan-stats")).toContainText("1 open");

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    const row = scanRow(page, id);
    await expect(row, "the new scan heads Recent scans").toBeVisible();
    await expect(row.locator(".cell-sub")).toHaveText("simulator, ports 9000, 4080");
    await expect(row.locator(".cell-sub")).toHaveAttribute("title", "simulator, ports 9000, 4080");
    await expect(row.locator("[data-scan-details]"), "the focus went back to the row").toBeFocused();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7r: the Discovery graph", () => {
  test("every discovered node says in which scan it was last seen, the hand-added one says so, and so does the source panel", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    const scan = await runScan(page.request, (await simScope(page.request)).id);
    const graph = await graphOf(page.request);
    const found = scan.findings.filter((f) => f.source_id !== null).map((f) => graph.sources.find((s) => s.id === f.source_id)!);
    const discovered = found.filter((s) => s.origin === "discovered");
    const manual = found.filter((s) => s.origin === "manual");
    expect(discovered.length, "the scan found a discovered source (the Modbus simulator)").toBeGreaterThan(0);
    expect(manual.length, "and the hand-added sim").toBeGreaterThan(0);

    await openDiscovery(page);
    for (const source of discovered) {
      await expect(srcNode(page, source).locator(".gnode-seen"), `${source.name} was seen in scan #${scan.id}`).toHaveText(new RegExp(`^Seen in scan #${scan.id}(, .+)?$`));
    }
    for (const source of manual) {
      await expect(srcNode(page, source).locator(".gnode-seen"), `${source.name} was added by hand`).toHaveText("Added by hand");
    }

    const first = discovered[0];
    await ensureOnCanvas(page, srcNode(page, first));
    await detailsButton(page, first).click();
    const panel = page.getByRole("complementary", { name: "Source details" });
    await expect(panel).toContainText(first.name);
    await expect(panel).toContainText(new RegExp(`Seen in scan #${scan.id}(, .+)?`));
  });

  test("Remove takes a discovered source with nothing mapped off the graph, with its layout rows, and the Audit page reads it by name", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    await runScan(page.request, (await simScope(page.request)).id);
    const before = await graphOf(page.request);
    const candidates = removable(before);
    expect(candidates.length, "a discovered source with nothing mapped (the Modbus simulator)").toBeGreaterThan(0);
    const target = candidates.find((s) => s.connector_type === "modbus") ?? candidates[0];
    const point = pointsOf(target)[0];

    // Positions the person had dragged: the source node (to the LEFT of the source column, which starts at x = 0, and far from the asset column at
    // x = 1200 and more: nothing can cover its Remove button), one of its groups and one of its points.
    const keys = [`src:${target.id}`, `cluster:${target.id}:${target.clusters[0]?.key ?? "x"}`, ...(point ? [`point:${point.id}`] : [])];
    const saved = await page.request.put("/api/discovery/layout", { data: { nodes: keys.map((node_id, i) => ({ node_id, x: -300 + i * 10, y: 40 + i * 10 })) } });
    expect(saved.status(), `saving the layout: ${await saved.text()}`).toBe(204);
    expect(Object.keys((await graphOf(page.request)).layout), "the layout rows are there").toEqual(expect.arrayContaining(keys));

    await openDiscovery(page);
    const target$ = srcNode(page, target);
    await ensureOnCanvas(page, target$);
    await expect(removeButton(page, target)).toBeVisible();
    const nodesBefore = await page.locator(".react-flow__node").count();
    const text = removeDialogText([target.name]);

    await removeButton(page, target).click();
    const dialog = page.getByRole("dialog", { name: text.title, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".confirm-body")).toHaveText(text.message);

    await test.step("Escape closes the dialog and the focus is on the Remove button that opened it", async () => {
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(removeButton(page, target)).toBeFocused();
      await expect(target$, "nothing was removed").toBeVisible();
    });

    await ensureOnCanvas(page, target$);
    await removeButton(page, target).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(toast(page, "Removed 1 source").first()).toBeVisible();
    await expect(target$, "the node is gone").toHaveCount(0);
    await expect(page.locator(".react-flow__node"), "and only that one").toHaveCount(nodesBefore - 1);
    await expect(refreshButton(page), "the node that held the focus is gone, so Refresh has it").toBeFocused();

    await test.step("the server removed the source, its layout rows and wrote one audit row that names it", async () => {
      const after = await graphOf(page.request);
      expect(after.sources.some((s) => s.id === target.id), "the source is gone").toBe(false);
      expect(Object.keys(after.layout).filter((k) => keys.includes(k)), "and so are its layout rows").toEqual([]);
      const rows = (await auditItems(page.request, "source.deleted")).filter((e) => e.detail.source_id === target.id);
      expect(rows, "one source.deleted row").toHaveLength(1);
      expect(rows[0].detail).toMatchObject({ name: target.name, points: 0, mappings: 0, unmapped_only: true });
    });

    await test.step("the Audit page reads it as 'Deleted source <name>'", async () => {
      await page.goto("/audit");
      await expect(heading1(page, "Audit log")).toBeVisible();
      await expect(page.getByRole("row").filter({ hasText: `Deleted source ${target.name}` }).first()).toBeVisible();
    });
  });

  test("Clear unmapped lists what the graph says is removable, removes exactly that, goes to 0, and a rescan brings the Modbus source back", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    const scope = await simScope(page.request);
    await runScan(page.request, scope.id);
    const before = await graphOf(page.request);
    const listed = removable(before);
    const names = listed.map((s) => s.name);
    expect(names.length, "something is removable: the scan brought the Modbus source back").toBeGreaterThan(0);
    const keep = before.sources.filter((s) => !listed.includes(s));
    const text = removeDialogText(names);

    await openDiscovery(page);
    const clear = clearButton(page, names.length);
    await expect(clear, "the count in the button").toBeVisible();
    await expect(clear).not.toHaveAttribute("aria-disabled", "true");
    await clear.click();
    const dialog = page.getByRole("dialog", { name: text.title, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".confirm-body"), "the names the API lists, the first five, and the promise").toHaveText(text.message);
    for (const kept of keep.filter((s) => s.origin === "discovered")) {
      await expect(dialog.locator(".confirm-body"), `${kept.name} has a mapped point and is not in the list`).not.toContainText(kept.name);
    }

    await test.step("Escape closes only the dialog and the focus is on the Clear button", async () => {
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(clear).toBeFocused();
      for (const source of listed) await expect(srcNode(page, source)).toBeVisible();
    });

    await clear.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(toast(page, `Removed ${plural(names.length, "source")}`).first()).toBeVisible();
    for (const source of listed) await expect(srcNode(page, source), `${source.name} is gone`).toHaveCount(0);
    for (const source of keep) await expect(srcNode(page, source), `${source.name} stays`).toBeVisible();

    await test.step("the button is aria-disabled at 0 and keeps the focus (or, if nothing is left at all, the page says so)", async () => {
      const after = await graphOf(page.request);
      expect(removable(after), "nothing removable is left").toEqual([]);
      expect(after.sources.map((s) => s.id).sort(), "exactly the listed ones went").toEqual(keep.map((s) => s.id).sort());
      if (after.sources.length > 0) {
        const zero = clearButton(page, 0);
        await expect(zero).toHaveAttribute("aria-disabled", "true");
        await expect(zero).toHaveAttribute("title", "Nothing to clear");
        await expect(zero).toBeFocused();
      } else {
        await expect(page.getByText("Nothing discovered yet")).toBeVisible();
      }
    });

    await test.step("a rescan finds the Modbus simulator again, as a new source", async () => {
      await runScan(page.request, scope.id);
      const again = await graphOf(page.request);
      const modbus = modbusOf(again);
      expect(modbus, "the Modbus source is back").toBeDefined();
      expect(listed.map((s) => s.id), "as a new row").not.toContain(modbus!.id);
      await openDiscovery(page);
      await expect(clearButton(page, removable(again).length)).toBeVisible();
    });
  });

  test("the remove route refuses while a scan is queued or running, and removes nothing", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    const scope = await simScope(page.request);
    const before = await graphOf(page.request);
    const bait = before.sources.find((s) => s.origin === "manual"); // a source the route would only skip, so a scan that ended early cannot cost data
    expect(bait, "the hand-added sim").toBeDefined();

    const scanId = await startScan(page.request, scope.id);
    const refused = await page.request.post("/api/discovery/sources/remove", { data: { source_ids: [bait!.id] } });
    expect(refused.status(), `the scan is queued or running: ${await refused.text()}`).toBe(409);
    expect(((await refused.json()) as { detail: string }).detail).toBe(SCAN_RUNNING);
    await finished(page.request, scanId);

    const after = await graphOf(page.request);
    expect(after.sources.map((s) => s.id).sort(), "nothing was removed").toEqual(expect.arrayContaining(before.sources.map((s) => s.id).sort()));
  });

  test("one mapped point out of many protects a source: no Remove, not in the Clear list, and a direct POST skips it (also a fully mapped one, a hand-added one and one that is gone)", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    const scope = await simScope(page.request);
    await runScan(page.request, scope.id);
    const start = await graphOf(page.request);
    const chosen = modbusOf(start);
    expect(chosen, "the discovered Modbus source (sixty points)").toBeDefined();
    expect(isMapped(chosen!), "with nothing mapped yet").toBe(false);
    expect(chosen!.point_count, "many points, so that one mapped point is the boundary").toBeGreaterThan(1);

    // ONE point mapped and every other point of the source left alone: a check that compares the mapped points with the point count, or asks
    // that every point be mapped, would let this source be removed. The asset is taken away again at the end, which unmaps the source.
    const asset = await makeAsset(page.request, `${PREFIX} mapped`);
    try {
      await mapOnePoint(page.request, chosen!, asset);
      const graph = await graphOf(page.request);
      const mapped = graph.sources.find((s) => s.id === chosen!.id)!;
      expect(pointsOf(mapped).filter((p) => p.mapping_id !== null), "exactly one point is mapped").toHaveLength(1);
      expect(mapped.point_count, "and the others are not").toBe(chosen!.point_count);
      const manual = graph.sources.find((s) => s.origin === "manual");
      expect(manual, "the hand-added sim").toBeDefined();
      const full = graph.sources.find((s) => s.origin === "discovered" && s.id !== mapped.id && isMapped(s)); // the OPC UA source after discovery.spec
      const listed = removable(graph);
      expect(listed.map((s) => s.id), "the mapped source is not removable").not.toContain(mapped.id);

      await test.step("the page: its node has Details and no Remove, and Clear unmapped counts only the others", async () => {
        await openDiscovery(page);
        await ensureOnCanvas(page, srcNode(page, mapped));
        await expect(detailsButton(page, mapped), "the node is there").toBeVisible();
        await expect(removeButton(page, mapped), "and has no Remove").toHaveCount(0);
        await expect(page.getByRole("button", { name: /^Remove .* from Discovery$/ }), "Remove only on the removable ones").toHaveCount(listed.length);
        await expect(clearButton(page, listed.length)).toBeVisible();
        if (listed.length > 0) {
          const text = removeDialogText(listed.map((s) => s.name));
          await clearButton(page, listed.length).click();
          const dialog = page.getByRole("dialog", { name: text.title, exact: true });
          await expect(dialog.locator(".confirm-body")).toHaveText(text.message);
          await expect(dialog.locator(".confirm-body"), "the mapped source is not named").not.toContainText(mapped.name);
          await page.keyboard.press("Escape");
          await expect(dialog).toBeHidden();
        } else {
          await expect(clearButton(page, 0), "nothing left to clear").toHaveAttribute("aria-disabled", "true");
        }
      });

      await test.step("the API: the route skips it (and a fully mapped one, the hand-added source and the missing id), and removes nothing", async () => {
        const ids = [mapped.id, manual!.id, GONE, ...(full ? [full.id] : [])];
        const answered = await page.request.post("/api/discovery/sources/remove", { data: { source_ids: ids } });
        expect(answered.status(), await answered.text()).toBe(200);
        const body = (await answered.json()) as RemoveAnswer;
        expect(body.removed, "nothing was removed").toEqual([]);
        const skipped = Object.fromEntries(body.skipped.map((s) => [s.id, [s.reason, s.name]]));
        expect(skipped[mapped.id]).toEqual(["mapped", mapped.name]);
        expect(skipped[manual!.id]).toEqual(["manual", manual!.name]);
        expect(skipped[GONE]).toEqual(["gone", null]);
        if (full) expect(skipped[full.id]).toEqual(["mapped", full.name]);
        const after = (await graphOf(page.request)).sources.find((s) => s.id === mapped.id);
        expect(after, "the source is still there").toBeDefined();
        expect(after!.point_count, "with all its points").toBe(mapped.point_count);
        expect(pointsOf(after!).filter((p) => p.mapping_id !== null), "and its mapping").toHaveLength(1);
      });
    } finally {
      const gone = await page.request.delete(`/api/assets/${asset.id}?confirm=true`);
      expect([200, 204, 404], `removing the asset this case made: ${gone.status()}`).toContain(gone.status());
    }
  });

  test("a hand-added Modbus source at the discovered one's address wins: the next scan reports it as an existing source and does not browse the duplicate", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    const scope = await simScope(page.request);
    const first = await runScan(page.request, scope.id);
    const discovered = modbusOf(await graphOf(page.request));
    expect(discovered, "the first scan made (or found) the discovered Modbus source").toBeDefined();
    expect(discovered!.last_scan?.scan_id, "and saw it").toBe(first.id);

    let manualId: number | null = null;
    try {
      const made = await page.request.post("/api/sources", { data: { name: MANUAL_NAME, connector_type: "modbus", config: { host: "simulator", port: 5020 }, enabled: false } });
      expect(made.status(), `adding the Modbus source by hand: ${await made.text()}`).toBe(201);
      manualId = ((await made.json()) as { id: number }).id;

      const second = await runScan(page.request, scope.id);
      const modbusFinding = second.findings.find((f) => f.port === 5020);
      expect(modbusFinding, "the scan found the Modbus port again").toBeDefined();
      expect(modbusFinding!.source_id, "the finding is the hand-added source, not the older discovered one").toBe(manualId);
      expect(modbusFinding!.detail).toBe("existing source");
      expect(second.findings.filter((f) => f.source_id === discovered!.id), "the discovered duplicate has no finding in this scan").toEqual([]);

      const graph = await graphOf(page.request);
      const stale = graph.sources.find((s) => s.id === discovered!.id);
      expect(stale, "the duplicate is kept, nothing was merged or deleted").toBeDefined();
      expect(stale!.last_scan?.scan_id, "it was not browsed again: its last scan is still the first one").toBe(first.id);
      expect(stale!.point_count, "with its points").toBe(discovered!.point_count);

      await openDiscovery(page);
      await expect(srcNode(page, { id: manualId }).locator(".gnode-seen")).toHaveText("Added by hand");
      await expect(srcNode(page, discovered!).locator(".gnode-seen")).toHaveText(new RegExp(`^Seen in scan #${first.id}(, .+)?$`));
      await expect(srcNode(page, { id: manualId }).getByRole("button", { name: /^Remove / }), "a hand-added source has no Remove").toHaveCount(0);
    } finally {
      if (manualId !== null) {
        const gone = await page.request.delete(`/api/sources/${manualId}?confirm=true`);
        expect([204, 404], `removing the hand-added source: ${gone.status()}`).toContain(gone.status());
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7r: who sees what", () => {
  test("discovery.view sees the graph and none of Remove, Clear unmapped or Create assets, and the API says 403; discovery.edit adds Remove and Clear unmapped", async ({ browser, page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    await runScan(page.request, (await simScope(page.request)).id);
    const graph = await graphOf(page.request);
    const target = removable(graph).find((s) => s.connector_type === "modbus") ?? removable(graph)[0];
    expect(target, "a discovered source that Remove and Create assets would be offered on").toBeDefined();
    const count = removable(graph).length;

    await asAdmin(browser, async (request) => {
      await removeAccounts(request);
      for (const [role, permissions, who] of [
        [READER_ROLE, ["discovery.view"], READER],
        [EDITOR_ROLE, ["discovery.view", "discovery.edit"], EDITOR],
      ] as const) {
        const made = await request.post("/api/roles", { data: { name: role, description: "made by w7r.spec.ts", permissions } });
        expect(made.status(), `creating the role ${role}: ${await made.text()}`).toBe(201);
        const user = await request.post("/api/users", { data: { username: who.username, password: who.password, role: who.role } });
        expect(user.status(), `creating the account ${who.username}: ${await user.text()}`).toBe(201);
      }
    });

    await test.step("the API: reading is allowed, removing and accepting are 403, and the source stays", async () => {
      await as(browser, READER, async (api) => {
        expect((await api.get("/api/discovery/graph")).status(), "the graph").toBe(200);
        expect((await api.get("/api/scans")).status(), "the scans").toBe(200);
        const removing = await api.post("/api/discovery/sources/remove", { data: { source_ids: [target.id] } });
        expect(removing.status(), `removing: ${await removing.text()}`).toBe(403);
        const accepting = await api.post("/api/discovery/accept", { data: { source_id: target.id, new_asset: { name: `${PREFIX} refused` }, points: [{ point_id: pointsOf(target)[0].id, metric: "active_power_kw" }] } });
        expect(accepting.status(), `accepting: ${await accepting.text()}`).toBe(403);
        expect((await api.put("/api/discovery/layout", { data: { nodes: [] } })).status(), "the layout").toBe(403);
      });
      expect((await graphOf(page.request)).sources.some((s) => s.id === target.id), "the source is still there").toBe(true);
    });

    await test.step("the page for discovery.view: the node and its Details, and none of the three", async () => {
      await signInAs(page, READER);
      await openDiscovery(page);
      await expect(userBlock(page)).toContainText(READER.username);
      await ensureOnCanvas(page, srcNode(page, target));
      await expect(detailsButton(page, target), "something is there to be absent next to").toBeVisible();
      await expect(refreshButton(page)).toBeVisible();
      await expect(page.getByRole("button", { name: /^Remove .* from Discovery$/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Clear unmapped/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Create assets for / })).toHaveCount(0);
    });

    await test.step("the Scans page opens the drawer for discovery.view too", async () => {
      await openScans(page);
      const first = page.locator("[data-scan-details]").first();
      await first.click();
      await expect(page.getByRole("dialog", { name: /^Scan #\d+/ })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: /^Scan #\d+/ })).toBeHidden();
      await expect(first).toBeFocused();
    });

    await test.step("discovery.edit adds Remove and Clear unmapped, and still no Create assets (that is discovery.accept)", async () => {
      await signInAs(page, EDITOR);
      await openDiscovery(page);
      await expect(userBlock(page)).toContainText(EDITOR.username);
      await ensureOnCanvas(page, srcNode(page, target));
      await expect(removeButton(page, target)).toBeVisible();
      await expect(clearButton(page, count)).toBeVisible();
      await expect(page.getByRole("button", { name: /^Create assets for / })).toHaveCount(0);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7r: layout", () => {
  for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
    test(`at ${width} px: no sideways overflow on Scans and Discovery, the drawer fits the window, the header actions fit and a source node holds its three buttons`, async ({ page }) => {
      test.setTimeout(240_000);
      await signIn(page);
      const scan = await runScan(page.request, (await simScope(page.request)).id);
      const graph = await graphOf(page.request);
      const target = removable(graph).find((s) => s.connector_type === "modbus") ?? removable(graph)[0];
      expect(target, "a source with Remove and Create assets on its node").toBeDefined();
      await page.setViewportSize({ width, height });

      await test.step("Scans: the page and its tables do not scroll sideways", async () => {
        await openScans(page);
        const over = await sideways(page);
        expect(over.page, "the page").toBeLessThanOrEqual(1);
        for (const frame of over.frames) expect(frame, "a table frame").toBeLessThanOrEqual(1);
      });

      await test.step("the drawer lies inside the window, its body does not scroll sideways, its link is in view", async () => {
        await page.locator(`[data-scan-details="${scan.id}"]`).click();
        const drawer = scanDrawer(page, scan.id);
        await expect(drawer).toBeVisible();
        await stopped(drawer);
        await expectInWindow(page, drawer, "the drawer");
        const body = await drawer.locator(".drawer-body").evaluate((el) => el.scrollWidth - el.clientWidth);
        expect(body, "the drawer body").toBeLessThanOrEqual(1);
        await expectInWindow(page, drawer.getByRole("link", { name: "Open the discovery graph", exact: true }), "the footer link");
        await page.keyboard.press("Escape");
        await expect(drawer).toBeHidden();
      });

      await test.step("Discovery: no sideways overflow, the header actions fit, the node's buttons are inside the node", async () => {
        await openDiscovery(page);
        const over = await sideways(page);
        expect(over.page, "the page").toBeLessThanOrEqual(1);
        await ensureOnCanvas(page, srcNode(page, target));

        const head = page.locator(".page-head").first();
        const headBox = (await head.boundingBox())!;
        const refresh = refreshButton(page);
        const clear = clearButton(page);
        const [a, b] = [(await refresh.boundingBox())!, (await clear.boundingBox())!];
        await expectInWindow(page, refresh, "Refresh");
        await expectInWindow(page, clear, "Clear unmapped");
        for (const box of [a, b]) {
          expect(box.x, "inside the header, left").toBeGreaterThanOrEqual(headBox.x - 1);
          expect(box.x + box.width, "inside the header, right").toBeLessThanOrEqual(headBox.x + headBox.width + 1);
        }
        // Side by side, or (if the header ever wraps them) one above the other: never on top of each other.
        expect(a.x + a.width <= b.x + 1 || a.y + a.height <= b.y + 1, `Refresh ${JSON.stringify(a)} and Clear unmapped ${JSON.stringify(b)} overlap`).toBe(true);

        const box = (await srcNode(page, target).locator(".gnode").boundingBox())!;
        const buttons = srcNode(page, target).getByRole("button");
        expect(await buttons.count(), "Toggle, Details, Create assets and Remove").toBeGreaterThanOrEqual(4);
        for (const button of await buttons.all()) {
          const inner = (await button.boundingBox())!;
          const label = (await button.getAttribute("aria-label")) ?? "a button";
          expect(inner.x, `${label}: left`).toBeGreaterThanOrEqual(box.x - 1);
          expect(inner.x + inner.width, `${label}: right`).toBeLessThanOrEqual(box.x + box.width + 1);
          expect(inner.y + inner.height, `${label}: bottom`).toBeLessThanOrEqual(box.y + box.height + 1);
        }
      });
    });
  }

  // I1 of the whole-wave review: at a laptop's width the graph used to open fitted to everything, which with a tall asset column zoomed to the
  // floor and pushed the sources (the only nodes with Create assets and Remove) off the edge. It now opens on the first three sources, readable.
  // Loaded directly in an ordinary window: openDiscovery makes the window taller and presses fit view, which would hide what is under test.
  test("a fresh load at 1024 x 640 opens on the source column: the first Create assets button is inside the canvas and the node text is readable", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    await runScan(page.request, (await simScope(page.request)).id);
    const graph = await graphOf(page.request);
    expect(graph.sources.length, "the stack has sources").toBeGreaterThan(0);
    await page.setViewportSize({ width: 1024, height: 640 });
    await page.goto("/discovery");
    await expect(heading1(page, "Discovery")).toBeVisible();
    const first = srcNode(page, graph.sources[0]);
    await expect(first).toBeVisible({ timeout: 30_000 });
    await stopped(first);

    const canvas = (await page.locator(".graph-canvas").boundingBox())!;
    const inCanvas = (box: { x: number; y: number; width: number; height: number }) =>
      box.x >= canvas.x - 1 && box.y >= canvas.y - 1 && box.x + box.width <= canvas.x + canvas.width + 1 && box.y + box.height <= canvas.y + canvas.height + 1;
    const zoomOf = () => first.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el.closest(".react-flow__viewport")!).transform).a);

    await test.step("the first source's title is inside the canvas and, at the zoom the canvas opened with, at least 9 px tall text", async () => {
      const title = first.locator(".node-title");
      expect(inCanvas((await title.boundingBox())!), "the first source's title lies inside the canvas box").toBe(true);
      const zoom = await zoomOf();
      const size = await title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(zoom, "the opening zoom is held between 0.75 and 1").toBeGreaterThanOrEqual(0.749);
      expect(zoom).toBeLessThanOrEqual(1.001);
      expect(size * zoom, `the title is ${size}px at zoom ${zoom}`).toBeGreaterThanOrEqual(8.99); // 12 px at the 0.75 floor is exactly 9
    });

    await test.step("the first Create assets button among the first three sources (if one has it) is inside the canvas", async () => {
      for (const source of graph.sources.slice(0, 3)) {
        const button = srcNode(page, source).getByRole("button", { name: /^Create assets for \d+ groups? of / });
        if ((await button.count()) === 0) continue;
        expect(inCanvas((await button.boundingBox())!), `${source.name}: Create assets lies inside the canvas box`).toBe(true);
        return;
      }
      test.info().annotations.push({ type: "note", description: "none of the first three sources has a Create assets button on this stack" });
    });

    await test.step("the Controls' fit view still fits everything (it never zooms in past the opening view)", async () => {
      const opening = await zoomOf();
      await fitView(page, first);
      expect(await zoomOf(), "fit view shows at least as much as the opening view").toBeLessThanOrEqual(opening + 0.001);
    });

    await test.step("and after Fit View every node of the graph lies inside the canvas (the zoom floor is low enough to show a tall graph whole)", async () => {
      const outside = await page.locator(".react-flow__node").evaluateAll((els) =>
        els.map((el) => ({ id: el.getAttribute("data-id"), r: el.getBoundingClientRect() })).map(({ id, r }) => ({ id, box: { x: r.x, y: r.y, width: r.width, height: r.height } })));
      expect(outside.length, "the graph has nodes").toBeGreaterThan(0);
      expect(outside.filter(({ box }) => !inCanvas(box)).map(({ id }) => id), "nodes outside the canvas box after Fit View").toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Last: this case maps the Modbus source (the afterAll deletes the assets, which unmaps it again).

test.describe("W7r: creating assets from a source", () => {
  test("the collapsed source node has Create assets; the dialog turns two chosen groups into assets under one parent, with their mappings", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    await runScan(page.request, (await simScope(page.request)).id);
    const graph = await graphOf(page.request);
    const source = modbusOf(graph);
    expect(source, "the discovered Modbus source (ten groups of six points)").toBeDefined();
    expect(isMapped(source!), "with nothing mapped yet").toBe(false);
    const parent = await makeAsset(page.request, `${PREFIX} parent`);
    const acceptedBefore = await auditTotal(page.request, "discovery.accepted");

    await openDiscovery(page);
    await ensureOnCanvas(page, srcNode(page, source!));
    const open = createButton(page, source!);
    await expect(open, "on the collapsed node, no expanding first").toBeVisible();
    const total = Number(/for (\d+) groups? of/.exec((await open.getAttribute("aria-label")) ?? "")![1]);
    expect(total, "several groups to choose from").toBeGreaterThanOrEqual(2);
    await open.click();

    const dialog = page.getByRole("dialog", { name: "Create an asset for each group", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Parent asset", { exact: true }), "focus starts on the parent").toBeFocused();
    const table = dialog.getByRole("table", { name: "Groups to create assets from" });
    await expect(table.locator("tbody tr"), "one row per group the button counted").toHaveCount(total);
    await expect(dialog).toContainText("These are the scan's guesses. To change a metric or a scale first, use New asset... on the group instead.");
    await expect(table.locator(".bulk-list").first(), "the dialog shows the metric and the scale it will use").toContainText("active_power_kw ×1");

    const groups = await table.locator("td.bulk-group").allTextContents();
    expect(groups.length).toBe(total);
    const [one, two] = groups;
    const created = [`${PREFIX} ${one}`, `${PREFIX} ${two}`];

    await dialog.getByLabel("Parent asset", { exact: true }).selectOption(String(parent.id));
    for (const group of groups.slice(2)) await dialog.getByRole("checkbox", { name: `Include ${group}`, exact: true }).uncheck();
    await dialog.getByLabel(`Asset name for ${one}`, { exact: true }).fill(created[0]);
    await dialog.getByLabel(`Asset name for ${two}`, { exact: true }).fill(created[1]);
    await dialog.getByRole("button", { name: "Create 2 assets", exact: true }).click();

    await expect(dialog, "closes by itself when every chosen group is an asset").toBeHidden({ timeout: 120_000 });
    await expect(toast(page, "Created 2 assets").first()).toBeVisible();

    await test.step("two assets under the parent, six mappings each, two more accepts in the audit log", async () => {
      const children = (await json<ApiAsset[]>(page.request, "/api/assets")).filter((a) => a.parent_id === parent.id);
      expect(children.map((a) => a.name).sort(), "exactly the two chosen groups").toEqual([...created].sort());
      for (const child of children) {
        const summary = await json<{ metrics: { metric: string }[] }>(page.request, `/api/assets/${child.id}/summary`);
        expect(summary.metrics.map((m) => m.metric).sort(), `${child.name} mappings`).toEqual([...METRICS].sort());
      }
      expect(await auditTotal(page.request, "discovery.accepted"), "one accept per group").toBe(acceptedBefore + 2);
    });

    await test.step("the node still offers the groups that are left, and the focus is on that button", async () => {
      const left = createButton(page, source!);
      await expect(left).toBeVisible();
      await expect(left).toHaveAttribute("aria-label", `Create assets for ${plural(total - 2, "group")} of ${source!.name}`);
      await expect(left).toBeFocused();
    });
  });
});
