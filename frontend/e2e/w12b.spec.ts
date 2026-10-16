import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  bigGroup, bigModel, bigPointId, bigSourceId, DRAG_SHAPES, node as nid, PAGED_SHAPES, SMALL, SMALL_GROUPS, SMALL_NAMES, smallModel,
  type ApiCluster, type ApiGraphModel, type ApiPoint, type Metric, type Shape, type XY,
} from "./graphModel";

// W12b (the Discovery canvas made faster for big graphs, and easier to move about in: an Expand all that stays responsive, solid fan-out edges past 150 points, groups paged
// at 50 points with a "Show 50 more" node, an "Unmapped only" switch, folded asset subtrees, Expand/Collapse of a selection or a branch, and the arrow keys). Admin `admin` /
// `correct-horse`, the account the earlier projects use.
//
// THIS SPEC WRITES NOTHING TO THE STACK, like w7u. Every case answers GET /api/discovery/graph from a generated model (e2e/graphModel.ts, synthetic ids from 9,000,000 up) and the
// layout's PUT and DELETE through `page.route`; the one write a case makes on purpose, the Review's POST /api/discovery/accept (case 4), is answered here too and applied to the
// generated model, so the graph the page reads again shows the point mapped. Any OTHER write the app tries (the sign-in aside) is refused with a 500 and written down, and
// afterEach fails the case that made one. The role-limited case answers /api/me with a short permission list instead of making a role. Each case runs in a fresh browser context, so
// the browser-side view settings (the switch, the folded assets, the sidebar) start from nothing.
//
// The cases (every case at 1440 x 900 and at 1024 x 640, each its own test; one failing does not stop the next):
//   1  Expand all on a 500-point graph (one source, 10 groups of 50): from the click to the first point drawn and visible, measured IN THE PAGE (performance.now around the click and a rAF
//      poll), under 900 ms (3 times the 300 ms target). A miss is measured once more, alone, after a reload, and only that second reading counts.
//   2  Fan-out edges: the group-to-point edges of a group are dashed up to 150 drawn points and SOLID past it (a group of 200, pressed up to 150 and then to 200), a group of 60 stays
//      dashed, and the source-to-group edges stay dashed throughout.
//   3  Show more: a group of 120 opens with 50 points, the node `Show 50 more points of <group>, 70 left` and a line `50 of 120 shown`; pressed with the mouse and then with Enter it draws
//      100 and 120 points, vanishes at the end, and the focus is on a point; a mapped point beyond the page keeps an aggregated edge (`N mapped`) from the group to its asset; closing the
//      group and opening it again is back to 50.
//   4  Unmapped only: a) the switch, the summary that starts `Showing U of N points` (fully visible at 1024 with the sidebar expanded), mapped points, all-mapped groups and sources gone,
//      no mapped edge, remembered over a reload, and Find (Ctrl+K) for a hidden mapped point turns it off with the toast; b) mapping through the Review while it is on leaves the focus on
//      a named element (a point, a group, a source or the canvas), never <body>.
//   5  Folded assets: `Hide sub-assets of <name>`, the `N mapped` badge, the sub-assets and their edges gone, the mapped edges ending on the folded asset as ONE edge with the summed
//      label, `Show sub-assets of <name>` brings them back, remembered over a reload, and the toggle is there for a role with only discovery.view and assets.view.
//   6  Expand/Collapse of a selection and of a branch: the chevrons `More ways to expand` / `More ways to collapse` are aria-disabled with their reason while nothing is selected; a Shift-drag box
//      around two groups and Expand selection (bar, then the selection's right-click menu) opens them with the toast `Opened 2 groups.`; the branch items of the bar and of a source's
//      right-click menu; every toast is in the polite toast region.
//   7  Keyboard: a) Tab reaches a node; ArrowDown/ArrowUp go between sibling groups, ArrowRight to the first child, ArrowLeft to the parent; Enter on a source or group toggles it, on a point it
//      does not; the ContextMenu key opens the node's menu; a focused node wrapper has an accessible name such as `LVP02, group of 6 points, 3 mapped, open`; the focus is never <body>.
//      b) in a group of 120 the camera pans (never zooms) to a node that was off screen, and ArrowDown from the last point of a page reaches the Show more button, whose Enter draws the next page.
//   8  A toggle in a 2,022-node graph (DRAG_SHAPES, opened with repeated Expand all): collapse then expand one group, timed in the page: 600 ms for the collapse and 800 ms for the expand
//      (about 3 times what was measured), once more alone on a miss.
//   9  Hover in that graph: from the pointer arriving on a point to the `lit` class, less the 120 ms dwell, under 50 ms (3 times the 16 ms target), once more alone on a miss.
//  10  The console: no error message and no uncaught exception during any of these cases (checked after each; the 401 on /api/me of a signed-out page would be the one allowed).
//
// Locators. Playwright matches a name by case-insensitive SUBSTRING: the lookups of buttons are `exact: true` (`More ways to expand` and `Expand all` share a word, a chevron is aria-disabled
// and so needs `force` to be clicked, a node wrapper is named by its aria-label `<name>, <kind>, ...`). Positions come from a node's transform or its box. The camera is waited for
// (`cameraStill`) before a case presses a node or reads a box. Timings that are limits carry the limit in LIMIT below, so the controller can move one without reading the cases.

const ADMIN = { username: "admin", password: "correct-horse" };

interface Size { width: number; height: number }
const SIZES: readonly Size[] = [{ width: 1440, height: 900 }, { width: 1024, height: 640 }];

/** lib/graph.ts: an open group draws this many points at first, "Show 50 more" adds this many, and past FAN_DASH_LIMIT drawn points the edges to them are solid. */
const PAGE_SIZE = 50;
const FAN_DASH_LIMIT = 150;
/** hooks/useGraphHighlight.ts HOVER_DWELL_MS: the rest the pointer must take on a node before its path is lit. */
const DWELL_MS = 120;
/** The limits of the timed cases: 3 times the target of the plan (Expand all 300 ms, hover work 16 ms) or of the measured values (the toggle), in milliseconds. */
const LIMIT = { expandAll: 900, collapse: 600, expand: 800, hoverAfterDwell: 50 } as const;
/** sidebarState.ts NARROW_QUERY: under this window width the sidebar starts minimized. */
const NARROW = 1180;
/** lib/graphView.ts selectionStates: the words a blocked item or chevron gives. */
const REASON = {
  nothingSelected: "Select a source, group or asset first.",
  alreadyClosed: "Everything selected is already closed.",
} as const;

interface Box { x: number; y: number; width: number; height: number }

// ---------------------------------------------------------------------------------------------------------------------------------
// The stub: the generated graph, the Review's POST, and the refusal of every other write

interface Accept { source_id: number; asset_id?: number; points: { point_id: number; metric: Metric }[] }

interface Stub {
  /** The graph as the page reads it now (a mapping the Review made is in it). */
  model: ApiGraphModel;
  /** The places the layout holds now (the model's, then what the page PUT; DELETE empties it). */
  layout: Record<string, XY>;
  /** How many times the page read the graph: 0 would mean the generated graph never reached it. */
  reads: number;
  /** The bodies of the POST /api/discovery/accept the page sent. */
  accepts: Accept[];
  /** Writes the stub does not know. The page gets a 500 and afterEach fails the case. */
  stray: string[];
  /** Console errors and uncaught exceptions of the page (case 10). */
  errors: string[];
}
let current: Stub | null = null;

test.afterEach(() => {
  const stub = current;
  current = null;
  expect(stub?.stray ?? [], "the spec writes nothing to the stack: these requests were refused").toEqual([]);
  expect(stub?.errors ?? [], "case 10: the page logged no error").toEqual([]);
});

let nextMapping = 9_500_000;

/** Maps a point of the model the way the server would after an accept: the asset, the mapping id and the metric it was mapped with. */
function assign(point: ApiPoint, assetId: number, metric: Metric = point.suggestion.metric): void {
  point.asset_id = assetId;
  point.mapping_id = ++nextMapping;
  point.mapped_metric = metric;
}
function assignById(model: ApiGraphModel, pointId: number, assetId: number, metric: Metric): number {
  for (const source of model.sources) {
    for (const point of [...source.ungrouped, ...source.clusters.flatMap((c) => c.points)]) {
      if (point.id === pointId) {
        assign(point, assetId, metric);
        return point.mapping_id!;
      }
    }
  }
  throw new Error(`the generated graph has no point ${pointId}`);
}

async function stubGraph(page: Page, model: ApiGraphModel): Promise<Stub> {
  const stub: Stub = { model, layout: { ...model.layout }, reads: 0, accepts: [], stray: [], errors: [] };
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location().url;
    if (/\/api\/me$/.test(url) && /401/.test(message.text())) return; // the sign-in page asks before anyone is signed in; these cases sign in first
    stub.errors.push(`console: ${message.text()} (${url})`);
  });
  page.on("pageerror", (error) => stub.errors.push(`pageerror: ${error.message}`));
  // Registered FIRST, so it is asked last: a request that is not a read and not the sign-in is refused and written down.
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    if (method === "GET" || method === "HEAD" || path === "/api/login") return route.continue();
    stub.stray.push(`${method} ${path}`);
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "w12b: this spec writes nothing" }) });
  });
  await page.route(/\/api\/discovery\/graph(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    stub.reads++;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...stub.model, layout: stub.layout }) });
  });
  await page.route(/\/api\/discovery\/layout(\?.*)?$/, async (route) => {
    const method = route.request().method();
    if (method === "PUT") {
      const body = route.request().postDataJSON() as { nodes: { node_id: string; x: number; y: number }[] };
      for (const n of body.nodes) stub.layout[n.node_id] = { x: n.x, y: n.y };
      return route.fulfill({ status: 204 });
    }
    if (method === "DELETE") {
      stub.layout = {};
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
  await page.route(/\/api\/discovery\/accept(\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Accept;
    stub.accepts.push(body);
    const ids = body.points.map((p) => assignById(stub.model, p.point_id, body.asset_id ?? 0, p.metric));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asset_id: body.asset_id, mapping_ids: ids }) });
  });
  current = stub;
  return stub;
}

/** The signed-in account keeps its session, but the page is told it holds only these permissions (the page decides what to draw from /api/me). */
async function limitTo(page: Page, permissions: readonly string[]): Promise<void> {
  await page.route((url) => url.pathname === "/api/me", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const real = await route.fetch();
    const me = (await real.json()) as Record<string, unknown>;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...me, role: "w12b-reader", permissions }) });
  });
}

async function signIn(page: Page): Promise<void> {
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in as ${ADMIN.username}: ${login.status()} ${await login.text()}`).toBe(true);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Locators and small readings

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const nodeSel = (id: string) => `.react-flow__node[data-id="${id}"]`;
const nodeEl = (page: Page, id: string) => page.locator(nodeSel(id));
const titleOf = (page: Page, id: string) => nodeEl(page, id).locator(".node-title");
const bar = (page: Page) => page.locator(".graph-bar");
const barButton = (page: Page, name: string) => bar(page).getByRole("button", { name, exact: true });
const unmappedSwitch = (page: Page) => bar(page).getByRole("switch", { name: "Unmapped only", exact: true });
const summaryEl = (page: Page) => page.locator(".graph-summary");
const findField = (page: Page) => page.getByRole("combobox", { name: "Search the graph", exact: true });
const findOptions = (page: Page) => page.locator(".graph-find").getByRole("option");
const menuEl = (page: Page) => page.locator('.graph-menu[role="menu"]');
/** A toast, looked up in the polite region the toasts are announced from. */
const toast = (page: Page, text: string | RegExp) => page.locator('.toast-stack[aria-live="polite"] .toast').filter({ hasText: text });
const clusters = (page: Page) => page.locator('.react-flow__node[data-id^="cluster:"]');
const pointNodes = (page: Page) => page.locator('.react-flow__node[data-id^="point:"]');
const moreNodes = (page: Page) => page.locator('.react-flow__node[data-id^="more:"]');
const moreId = (clusterId: string) => `more:${clusterId}`;
const edgeSel = (id: string) => `.react-flow__edge[data-id="${id}"]`;
const edgeEl = (page: Page, id: string) => page.locator(edgeSel(id));
const edgesWith = (page: Page, prefix: string) => page.locator(`.react-flow__edge[data-id^="${prefix}"]`);
/** The count label of an edge (`2 mapped`): a <text> inside the edge's group. */
const edgeLabel = (page: Page, id: string) => page.locator(`${edgeSel(id)} .react-flow__edge-text`);

async function boxOf(target: Locator, what: string): Promise<Box> {
  const box = await target.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  return box!;
}
const centreOf = (box: Box): XY => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const inside = (box: Box, frame: Box) => box.x >= frame.x - 1 && box.y >= frame.y - 1 && box.x + box.width <= frame.x + frame.width + 1 && box.y + box.height <= frame.y + frame.height + 1;
const median = (values: number[]) => (values.length === 0 ? 0 : [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]);
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const zoomOf = (page: Page) => page.locator(".react-flow__viewport").evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
const panOf = (page: Page) => page.locator(".react-flow__viewport").evaluate((el) => { const m = new DOMMatrixReadOnly(getComputedStyle(el).transform); return { x: m.e, y: m.f }; });
const focusedNodeId = (page: Page) => page.evaluate(() => document.activeElement?.closest(".react-flow__node")?.getAttribute("data-id") ?? null);
const selectedIds = (page: Page) => page.locator(".react-flow__node.selected").evaluateAll((els) => els.map((el) => el.getAttribute("data-id") ?? "").sort());
/** Puts the focus on an element without scrolling anything (the canvas is overflow hidden: a plain focus() on a node far off screen would scroll the canvas itself). */
const focusQuietly = (target: Locator) => target.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));

interface Focus { body: boolean; nodeId: string | null; canvas: boolean; label: string }
const focusOf = (page: Page): Promise<Focus> =>
  page.evaluate(() => {
    const el = document.activeElement;
    return {
      body: !el || el === document.body || el === document.documentElement,
      nodeId: el?.closest(".react-flow__node")?.getAttribute("data-id") ?? null,
      canvas: !!el?.classList.contains("graph-canvas"),
      label: el?.getAttribute("aria-label") ?? "",
    };
  });
/** The focus stands on something (case 7: after every action <body> is not where it is). */
async function expectFocusKept(page: Page, message: string): Promise<void> {
  const focus = await focusOf(page);
  expect(focus.body, `${message}: the focus is not on <body>`).toBe(false);
}
/** The focus ends on a node or on the canvas group, which are named (case 4b): polled, since the page moves it after the dialog has gone. */
async function expectFocusNamed(page: Page, message: string): Promise<void> {
  await expect
    .poll(async () => {
      const focus = await focusOf(page);
      return !focus.body && (focus.nodeId !== null || focus.canvas);
    }, { message: `${message}: the focus is on a node or on the canvas, not on <body>` })
    .toBe(true);
}

/** The name a node wrapper has (lib/graph.ts `ariaLabel`s). */
const sourceName = (name: string, groups: number, points: number, open: boolean) => `${name}, source, ${plural(groups, "group")}, ${plural(points, "point")}, ${open ? "open" : "closed"}`;
const groupName = (key: string, points: number, mapped: number, open: boolean) => `${key}, group of ${plural(points, "point")}, ${mapped} mapped, ${open ? "open" : "closed"}`;

const measured = (what: string, value: unknown) => {
  test.info().annotations.push({ type: "measure", description: `${what}: ${JSON.stringify(value)}` });
};

// ---------------------------------------------------------------------------------------------------------------------------------
// The camera and the opening of a page

/** Resolves once the viewport has stopped moving (two reads 120 ms apart agree twice): Fit View glides, and a source's own + pans for 300 ms. */
async function cameraStill(page: Page): Promise<void> {
  let last = "";
  let same = 0;
  await expect
    .poll(async () => {
      const now = await page.locator(".react-flow__viewport").evaluate((el) => getComputedStyle(el).transform);
      same = now === last ? same + 1 : 0;
      last = now;
      return same >= 2;
    }, { intervals: [120], message: "the camera never came to rest" })
    .toBe(true);
}

async function fitViewNow(page: Page): Promise<void> {
  await page.getByRole("button", { name: "fit view" }).click();
  await cameraStill(page);
}

interface Opening extends Partial<Size> { permissions?: readonly string[]; fit?: boolean }
/** Signs in, installs the stub for `model` and sets the window; the page is not opened yet. */
async function prepare(page: Page, model: ApiGraphModel, { width = 1440, height = 900, permissions }: Opening = {}): Promise<Stub> {
  await signIn(page);
  const stub = await stubGraph(page, model);
  if (permissions) await limitTo(page, permissions);
  await page.setViewportSize({ width, height });
  return stub;
}
/** Waits for the first node of a page that has just loaded (or been reloaded) and for the camera to rest. */
async function graphDrawn(page: Page): Promise<void> {
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 60_000 });
  await cameraStill(page);
}
/** Opens Discovery and waits for the first node and for the camera to rest. */
async function visit(page: Page, stub: Stub): Promise<void> {
  await page.goto("/discovery");
  await expect(heading1(page, "Discovery")).toBeVisible();
  await graphDrawn(page);
  expect(stub.reads, "the page read the generated graph, not the stack's").toBeGreaterThan(0);
}
/** prepare + visit + Fit View (the window opens on the first sources; Fit View shows the whole graph). */
async function arrive(page: Page, model: ApiGraphModel, opening: Opening = {}): Promise<Stub> {
  const stub = await prepare(page, model, opening);
  await visit(page, stub);
  if (opening.fit !== false) await fitViewNow(page);
  return stub;
}
async function reloaded(page: Page): Promise<void> {
  await page.reload();
  await graphDrawn(page);
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

/** Shift-drag a box around `ids` (the nodes inside it, and room of 14 px around them, and nothing else). The Shift key is let go whatever happens. */
async function boxSelect(page: Page, ids: string[]): Promise<void> {
  const boxes = await Promise.all(ids.map((id) => boxOf(nodeEl(page, id), `node ${id}`)));
  const [x0, y0] = [Math.min(...boxes.map((b) => b.x)) - 14, Math.min(...boxes.map((b) => b.y)) - 14];
  const [x1, y1] = [Math.max(...boxes.map((b) => b.x + b.width)) + 14, Math.max(...boxes.map((b) => b.y + b.height)) + 14];
  const onPane = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.classList.contains("react-flow__pane") ?? false, [x0, y0]);
  expect(onPane, `the corner (${x0.toFixed(0)}, ${y0.toFixed(0)}) of the box is on the empty canvas`).toBe(true);
  await page.keyboard.down("Shift");
  try {
    await expect(page.locator(".react-flow__pane.selection"), "Shift switches the pane to selecting").toHaveCount(1);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 12 });
    await page.mouse.up();
  } finally {
    await page.keyboard.up("Shift");
  }
  await expect.poll(() => selectedIds(page), { message: "the nodes inside the box are selected" }).toEqual([...ids].sort());
}

/** The sidebar starts minimized in a window under 1180 px: the widest the bar can be asked to share its row with is the expanded one. */
async function expandSidebar(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Expand sidebar", exact: true });
  if ((await toggle.count()) > 0) await toggle.click();
  await expect(page.locator(".shell")).toHaveAttribute("data-sidebar", "expanded");
  await cameraStill(page);
}

/** A real pointer press when the button is on screen; else the click event itself (a node far down a long list lies outside the canvas, and Playwright cannot scroll a canvas). */
async function pressWithMouse(page: Page, button: Locator): Promise<void> {
  const box = await button.boundingBox();
  const pane = await boxOf(page.locator(".react-flow__pane"), "the pane");
  if (box && inside(box, pane)) {
    try {
      await button.click({ timeout: 3_000 });
      return;
    } catch {
      /* something lies over it (a tool, the minimap): the event itself will do */
    }
  }
  await button.dispatchEvent("click");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Timings, in the page

interface Click {
  /** The buttons to look through (a CSS selector) and, to tell them apart, the exact text of the one to press. */
  button: string;
  text?: string;
  /** Done when this node is drawn and not hidden (React Flow keeps a node hidden until it is measured) ... */
  done?: string;
  /** ... or when this one is gone. */
  gone?: string;
}
/** Presses a button INSIDE the page and returns how long it took, in ms, until the node in `done` is drawn and visible or the one in `gone` has left. The round trips of the driver are not in it. */
const timedClick = (page: Page, click: Click): Promise<number> =>
  page.evaluate(async ({ button, text, done, gone }: Click) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>(button)).find((el) => text === undefined || el.textContent === text);
    if (!target) throw new Error(`no button matches ${button}${text === undefined ? "" : ` with the text ${text}`}`);
    const t0 = performance.now();
    target.click();
    return await new Promise<number>((resolve, reject) => {
      const tick = () => {
        const now = performance.now();
        if (gone !== undefined) {
          if (!document.querySelector(gone)) return resolve(now - t0);
        } else if (done !== undefined) {
          const el = document.querySelector(done);
          if (el && getComputedStyle(el).visibility !== "hidden") return resolve(now - t0);
        }
        if (now - t0 > 60_000) return reject(new Error("the page did not finish within a minute"));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, click);

/**
 * Lessons C: a timing that misses is measured once more, alone (`again` puts the page back first), and only the second reading counts: a first reading on a busy machine says
 * little about the build. Both readings are written down.
 */
async function judged<T extends number | number[]>(what: string, passes: (readings: T) => boolean, measure: () => Promise<T>, again: () => Promise<void>): Promise<T> {
  const first = await measure();
  if (passes(first)) {
    measured(what, { readings: [first], counted: first });
    return first;
  }
  await again();
  const second = await measure();
  measured(what, { readings: [first, second], counted: second });
  return second;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Models

/** One offline source of 200 + 60 points in two groups: the fan-out edges are solid past 150 drawn points, dashed below. */
const FAN_SHAPES: readonly Shape[] = [{ groups: 2, pointsPerGroup: 0, groupSizes: [200, 60], status: "offline" }];
/** Ten offline sources of ... see PAGED_SHAPES and DRAG_SHAPES in graphModel.ts; the first one is `W7u Big 1`. */
const BIG_SOURCE = bigSourceId(1);
const BIG_SOURCE_NAME = "W7u Big 1";

/** The small model with every point of one group mapped to an asset (a group all mapped: the filter takes it away). */
function mapGroup(cluster: ApiCluster, assetId: number): void {
  for (const point of cluster.points) if (point.asset_id === null) assign(point, assetId);
}
/**
 * The small model as the filter case needs it: Alpha keeps LVP01 (1 of 3 mapped) and has LVP02 all mapped (6 of 6), Bravo's one group is all mapped (a source with nothing left to map),
 * Charlie (2 ungrouped points) and Delta (SIM-D, 2 points) are untouched. 15 points, 9 mapped, 6 unmapped, 4 sources.
 */
function filterModel(): ApiGraphModel {
  const model = smallModel();
  mapGroup(model.sources[0].clusters[1], SMALL.hall);
  mapGroup(model.sources[1].clusters[0], SMALL.rack);
  return model;
}

const GROUP_OF = (index: number) => bigGroup(1, index);

// ---------------------------------------------------------------------------------------------------------------------------------
// The cases

for (const size of SIZES) {
  const at = `${size.width} x ${size.height}`;

  test.describe(`W12b at ${at}`, () => {
    // -------------------------------------------------------------------------------------------------------------------------
    test("1 Expand all on a 500-point graph draws the first point quickly (measured in the page)", async ({ page }) => {
      test.setTimeout(240_000);
      const shapes: readonly Shape[] = [{ groups: 10, pointsPerGroup: 50, status: "offline" }];
      await arrive(page, bigModel(shapes), { ...size, fit: false });
      const first = nid.point(bigPointId(shapes, 1, 1, 1));
      await expect(pointNodes(page), "nothing is open yet").toHaveCount(0);

      const click: Click = { button: ".graph-bar button", text: "Expand all", done: nodeSel(first) };
      const reading = await judged(
        `Expand all, ${at}, 500 points: click to the first point visible (ms)`,
        (ms) => ms < LIMIT.expandAll,
        () => timedClick(page, click),
        async () => { await reloaded(page); },
      );
      expect(reading, `Expand all took ${round(reading)} ms to show its first point, the limit is ${LIMIT.expandAll}`).toBeLessThan(LIMIT.expandAll);
      await expect(pointNodes(page), "every point of the ten groups is drawn (a group of exactly one page is not paged)").toHaveCount(500);
      await expect(moreNodes(page)).toHaveCount(0);
    });

    // -------------------------------------------------------------------------------------------------------------------------
    test("2 the fan-out edges are dashed up to 150 drawn points and solid past it; the source-to-group edges stay dashed", async ({ page }) => {
      test.setTimeout(240_000);
      await arrive(page, bigModel(FAN_SHAPES), { ...size, fit: false });
      const group1 = nid.cluster(BIG_SOURCE, GROUP_OF(1));
      const group2 = nid.cluster(BIG_SOURCE, GROUP_OF(2));
      /** The dash pattern of every edge whose id starts with `prefix`, as "6 4" or "none". */
      const dashesOf = (prefix: string) =>
        edgesWith(page, prefix).evaluateAll((els) => els.map((el) => {
          const path = el.querySelector(".react-flow__edge-path");
          return path ? getComputedStyle(path).strokeDasharray.replace(/px/g, "").split(/[\s,]+/).filter(Boolean).join(" ") : "missing";
        }));
      const fan = (group: string) => `e:${group}>point:`;
      /** Waits until the group has `count` fan-out edges drawn, then says what dash they all have (one value, or the mixture). */
      const fanDash = async (group: string, count: number): Promise<string> => {
        await expect.poll(() => edgesWith(page, fan(group)).count(), { message: `${count} edges leave ${group}`, timeout: 30_000 }).toBe(count);
        return [...new Set(await dashesOf(fan(group)))].join(" | ");
      };
      // The nodes lie far down a long list, off the canvas: the click event itself (a pointer cannot reach them without panning, which case 7 does with the keys).
      const pressMore = (group: string) => nodeEl(page, moreId(group)).getByRole("button").dispatchEvent("click");

      await barButton(page, "Expand all").click();
      await expect(clusters(page)).toHaveCount(2);
      await expect(moreNodes(page), "both groups are over a page").toHaveCount(2);
      await expect(pointNodes(page)).toHaveCount(2 * PAGE_SIZE);

      await test.step("a page of 50: dashed", async () => {
        expect(await fanDash(group1, PAGE_SIZE)).toBe("6 4");
        expect(await fanDash(group2, PAGE_SIZE)).toBe("6 4");
      });
      await test.step("the group of 60, all drawn: still dashed", async () => {
        await pressMore(group2);
        await expect(pointNodes(page)).toHaveCount(PAGE_SIZE + 60);
        await expect(moreNodes(page), "the 60-point group has nothing left to show").toHaveCount(1);
        expect(await fanDash(group2, 60), "60 drawn points are under the limit").toBe("6 4");
      });
      await test.step("the group of 200 at 100 and at exactly 150: dashed (the limit is for MORE than 150)", async () => {
        await pressMore(group1);
        await expect(pointNodes(page)).toHaveCount(100 + 60);
        expect(await fanDash(group1, 100)).toBe("6 4");
        await pressMore(group1);
        await expect(pointNodes(page)).toHaveCount(FAN_DASH_LIMIT + 60);
        expect(await fanDash(group1, FAN_DASH_LIMIT), "150 drawn points are not past the limit").toBe("6 4");
      });
      await test.step("at 200: solid, and the group of 60 and the source's edges are untouched", async () => {
        await pressMore(group1);
        await expect(pointNodes(page)).toHaveCount(200 + 60);
        await expect(moreNodes(page), "everything is drawn").toHaveCount(0);
        expect(await fanDash(group1, 200), "past 150 drawn points the edges are solid").toBe("none");
        expect(await fanDash(group2, 60), "the group of 60 stays dashed").toBe("6 4");
        await expect.poll(() => edgesWith(page, `e:${nid.source(BIG_SOURCE)}>`).count()).toBe(2);
        expect([...new Set(await dashesOf(`e:${nid.source(BIG_SOURCE)}>`))], "the source-to-group edges stay dashed").toEqual(["6 4"]);
      });
    });

    // -------------------------------------------------------------------------------------------------------------------------
    test("3 a group of 120 opens with 50 points and Show more; the mouse and Enter draw 100 and 120; a mapped point beyond the page keeps its edge; closing starts again at 50", async ({ page }) => {
      test.setTimeout(240_000);
      expect(PAGED_SHAPES[0].groupSizes?.[0], "the first group of PAGED_SHAPES is the one of 120").toBe(120);
      const model = bigModel(PAGED_SHAPES);
      const [assetA, assetB] = [model.assets[0].id, model.assets[1].id];
      const listed = model.sources[0].clusters[0].points;
      // 0-based places in the group: 4 is on the first page, 60 and 74 on the second, 109 on the third.
      for (const place of [60, 74]) assign(listed[place], assetA);
      for (const place of [4, 109]) assign(listed[place], assetB);
      const pointId = (place: number) => nid.point(listed[place].id);

      await arrive(page, model, { ...size, fit: false });
      const group = GROUP_OF(1);
      const cid = nid.cluster(BIG_SOURCE, group);
      const source = nodeEl(page, nid.source(BIG_SOURCE));
      await source.getByRole("button", { name: `Expand ${BIG_SOURCE_NAME}`, exact: true }).click();
      await expect(nodeEl(page, cid)).toBeVisible();
      await cameraStill(page);
      await nodeEl(page, cid).getByRole("button", { name: `Expand ${group}`, exact: true }).click();

      const moreButton = (left: number) => nodeEl(page, moreId(cid)).getByRole("button", { name: `Show ${Math.min(PAGE_SIZE, left)} more points of ${group}, ${left} left`, exact: true });
      const aggregated = (asset: number) => `m:${cid}>${nid.asset(asset)}`;
      const ownEdge = (place: number, asset: number) => `m:${pointId(place)}>${nid.asset(asset)}`;

      await test.step("the first page", async () => {
        await expect(pointNodes(page)).toHaveCount(PAGE_SIZE);
        await expect(moreButton(70), "the Show more button names the group and what is left").toBeVisible();
        await expect(nodeEl(page, cid)).toContainText("50 of 120 shown");
        await expect(nodeEl(page, cid)).toHaveAttribute("aria-label", groupName(group, 120, 4, true));
        await expect(edgeEl(page, ownEdge(4, assetB)), "a point on the page has its own edge").toHaveCount(1);
        await expect(edgeEl(page, aggregated(assetA)), "the two mapped points beyond the page keep ONE edge from the group").toHaveCount(1);
        await expect(edgeLabel(page, aggregated(assetA))).toHaveText("2 mapped");
        await expect(edgeEl(page, aggregated(assetB)), "the third beyond the page, to another asset").toHaveCount(1);
        await expect(edgeLabel(page, aggregated(assetB)), "one mapping needs no count").toHaveCount(0);
      });

      await test.step("the mouse: 100 points", async () => {
        await pressWithMouse(page, moreButton(70));
        await expect(pointNodes(page)).toHaveCount(2 * PAGE_SIZE);
        await expect(moreButton(20), "the last page is the 20 that are left").toBeVisible();
        await expect(nodeEl(page, cid)).toContainText("100 of 120 shown");
        await expect.poll(async () => (await focusOf(page)).nodeId?.startsWith("point:"), { message: "the focus went to a point of the new page" }).toBe(true);
        await expect(edgeEl(page, aggregated(assetA)), "the two mapped points are drawn now, so the group's edge for them is gone").toHaveCount(0);
        await expect(edgeEl(page, ownEdge(60, assetA)), "and each has its own").toHaveCount(1);
        await expect(edgeEl(page, ownEdge(74, assetA))).toHaveCount(1);
        await expect(edgeEl(page, aggregated(assetB)), "the one still beyond the page keeps its edge").toHaveCount(1);
      });

      await test.step("the keyboard: Enter on the focused button draws the rest, the node goes and the focus stays on a point", async () => {
        await focusQuietly(moreButton(20));
        await page.keyboard.press("Enter");
        await expect(pointNodes(page)).toHaveCount(120);
        await expect(moreNodes(page), "the Show more node is gone at the end").toHaveCount(0);
        await expect.poll(async () => (await focusOf(page)).nodeId?.startsWith("point:"), { message: "the focus is on a point, not on <body>" }).toBe(true);
        await expect(nodeEl(page, cid)).not.toContainText("shown");
        await expect(edgesWith(page, `m:${cid}>`), "no aggregated edge is left: every point is drawn").toHaveCount(0);
        await expect(edgesWith(page, "m:point:"), "the four mapped points have one edge each").toHaveCount(4);
      });

      await test.step("closing the group and opening it again is back at 50", async () => {
        await nodeEl(page, cid).getByRole("button", { name: `Collapse ${group}`, exact: true }).dispatchEvent("click");
        await expect(pointNodes(page)).toHaveCount(0);
        await expect(moreNodes(page)).toHaveCount(0);
        await nodeEl(page, cid).getByRole("button", { name: `Expand ${group}`, exact: true }).dispatchEvent("click");
        await expect(pointNodes(page)).toHaveCount(PAGE_SIZE);
        await expect(moreButton(70)).toBeVisible();
      });
    });

    // -------------------------------------------------------------------------------------------------------------------------
    test("4a Unmapped only: the switch, the count, what goes, no mapped edge, remembered over a reload, and Find turns it off", async ({ page }) => {
      test.setTimeout(240_000);
      await arrive(page, filterModel(), size);
      const [alpha, bravo, charlie, delta] = [SMALL.alpha, SMALL.bravo, SMALL.charlie, SMALL.delta].map((id) => nid.source(id));
      const lvp01 = nid.cluster(SMALL.alpha, SMALL_GROUPS.lvp01);
      const lvp02 = nid.cluster(SMALL.alpha, SMALL_GROUPS.lvp02);
      const mappedPoint = nid.point(SMALL.alphaMapped); // LVP01 kW, mapped to the rack
      const switchEl = unmappedSwitch(page);
      const LEAD = "Showing 6 of 15 points";

      await test.step("the switch is there and off; the summary is the whole graph's", async () => {
        await expect(switchEl).toBeVisible();
        await expect(switchEl).not.toBeChecked();
        await expect(summaryEl(page)).toHaveText("4 sources, 15 points, 9 mapped, 1 needs credentials");
        await expect(edgesWith(page, "m:"), "mapped edges are drawn").not.toHaveCount(0);
      });

      await test.step("on: the count leads the summary, whole at 1024 with the sidebar expanded; Expand all draws the unmapped points only", async () => {
        await expandSidebar(page);
        await switchEl.click();
        await expect(switchEl).toBeChecked();
        await expect(summaryEl(page)).toHaveText("Showing 6 of 15 points, 4 sources, 9 mapped, 1 needs credentials");
        const reach = await summaryEl(page).evaluate((el, lead) => {
          const text = el.firstChild;
          if (!(text instanceof Text)) return { right: 0, limit: 0, cut: true, starts: false };
          const range = document.createRange();
          range.setStart(text, 0);
          range.setEnd(text, Math.min(lead.length, text.length));
          return { right: range.getBoundingClientRect().right, limit: el.getBoundingClientRect().right, cut: el.scrollWidth > el.clientWidth, starts: text.data.startsWith(lead) };
        }, LEAD);
        expect(reach.starts, "the line starts with the count").toBe(true);
        // A line that the bar had to cut ends in an ellipsis about a character wide: the count must end before it.
        expect(reach.right, `the count ends at ${reach.right.toFixed(0)} px, the line at ${reach.limit.toFixed(0)} px${reach.cut ? " (and is cut)" : ""}`).toBeLessThanOrEqual(reach.limit - (reach.cut ? 16 : 0));

        await barButton(page, "Expand all").click();
        await expect(pointNodes(page), "LVP01's two unmapped points, Charlie's two and Delta's two").toHaveCount(6);
        await expect(nodeEl(page, mappedPoint), "a mapped point is not drawn").toHaveCount(0);
        await expect(nodeEl(page, lvp02), "a group that is all mapped is not drawn").toHaveCount(0);
        await expect(nodeEl(page, bravo), "a source that is all mapped is not drawn").toHaveCount(0);
        for (const id of [alpha, charlie, delta, lvp01]) await expect(nodeEl(page, id), `${id} still has something to map`).toBeVisible();
        await expect(titleOf(page, lvp01), "the group's title keeps its total").toHaveText("LVP01 (3)");
        await expect(edgesWith(page, "m:"), "no mapped edge is drawn").toHaveCount(0);
        await expect(nodeEl(page, nid.asset(SMALL.hall)), "the assets stay").toBeVisible();
      });

      await test.step("off: everything comes back", async () => {
        await switchEl.click();
        await expect(switchEl).not.toBeChecked();
        await expect(nodeEl(page, bravo)).toBeVisible();
        await expect(summaryEl(page)).toHaveText("4 sources, 15 points, 9 mapped, 1 needs credentials");
        await expect(edgesWith(page, "m:")).not.toHaveCount(0);
        await switchEl.click();
        await expect(switchEl).toBeChecked();
      });

      await test.step("it is remembered after a reload", async () => {
        await reloaded(page);
        await expect(unmappedSwitch(page)).toBeChecked();
        await expect(summaryEl(page)).toContainText(LEAD);
        await expect(nodeEl(page, nid.source(SMALL.bravo)), "and Bravo is still not drawn").toHaveCount(0);
        expect(await page.evaluate(() => window.localStorage.getItem("dcdash.discovery.unmapped-only"))).toBe("on");
      });

      await test.step("Find for a mapped point that the filter hides turns it off and says so", async () => {
        const spot = await emptySpot(page);
        await page.mouse.click(spot.x, spot.y); // the canvas takes the focus, so Ctrl+K is Find's
        await page.keyboard.press("Control+K");
        await expect(findField(page)).toBeFocused();
        await findField(page).pressSequentially("lvp02 pf");
        await expect(findOptions(page)).toHaveCount(1);
        await page.keyboard.press("Enter");
        await expect(toast(page, "Unmapped only is off so LVP02 PF can be shown.")).toBeVisible();
        await expect(unmappedSwitch(page)).not.toBeChecked();
        await expect(summaryEl(page)).toHaveText("4 sources, 15 points, 9 mapped, 1 needs credentials");
        const target = filterModel().sources[0].clusters[1].points.find((p) => p.name === "LVP02 PF")!;
        await expect(nodeEl(page, nid.point(target.id)), "the point is drawn").toBeVisible();
        await expect.poll(() => focusedNodeId(page), { message: "and holds the focus" }).toBe(nid.point(target.id));
      });
    });

    // -------------------------------------------------------------------------------------------------------------------------
    test("4b mapping through the Review while Unmapped only is on leaves the focus on a named element, never <body>", async ({ page }) => {
      test.setTimeout(240_000);
      const stub = await arrive(page, filterModel(), size);
      await unmappedSwitch(page).click();
      await expect(unmappedSwitch(page)).toBeChecked();
      await barButton(page, "Expand all").click();
      await expect(pointNodes(page)).toHaveCount(6);
      await fitViewNow(page);

      const deltaPoints = filterModel().sources[3].clusters[0].points;
      const mapThrough = async (name: string) => {
        const id = nid.point(deltaPoints.find((p) => p.name === name)!.id);
        await nodeEl(page, id).getByRole("button", { name: `Map ${name} to asset…`, exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Review mappings" });
        await expect(dialog).toBeVisible();
        await dialog.getByRole("combobox", { name: "Asset", exact: true }).selectOption(String(SMALL.rack));
        // The Rack already has active_power_kw: that row starts unticked ("This asset already has ..."), so give it a metric the Rack lacks and tick it.
        const row = dialog.getByRole("row", { name: new RegExp(name) });
        const tick = row.getByRole("checkbox");
        if (!(await tick.isChecked())) {
          await row.getByRole("combobox").selectOption("frequency_hz");
          if (!(await tick.isChecked())) await tick.check();
        }
        await dialog.getByRole("button", { name: "Create mappings", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(nodeEl(page, id), `${name} is mapped now, so the filter takes its node away`).toHaveCount(0);
        return id;
      };

      await test.step("one of two points of a group: the focus goes on within the group", async () => {
        await mapThrough("SIM-D power");
        await expectFocusNamed(page, "after mapping SIM-D power");
        expect(stub.accepts, "the Review sent one accept").toHaveLength(1);
        expect(stub.accepts[0].points.map((p) => p.point_id)).toEqual([deltaPoints[0].id]);
      });

      await test.step("the last point of the only group of the source: group and source go too, the focus goes to the canvas or another node", async () => {
        await fitViewNow(page);
        await mapThrough("SIM-D energy");
        await expectFocusNamed(page, "after mapping SIM-D energy");
        await expect(nodeEl(page, nid.source(SMALL.delta)), "Delta has nothing left to map, so it is not drawn").toHaveCount(0);
        expect(stub.accepts).toHaveLength(2);
      });
    });

    // -------------------------------------------------------------------------------------------------------------------------
    test("5a folded assets: Hide sub-assets, the badge, one summed edge on the folded asset, Show brings them back, remembered over a reload", async ({ page }) => {
      test.setTimeout(240_000);
      await arrive(page, smallModel(), size);
      const [hall, rack] = [nid.asset(SMALL.hall), nid.asset(SMALL.rack)];
      const toRack = `m:${nid.source(SMALL.alpha)}>${rack}`;
      const toHall = `m:${nid.source(SMALL.alpha)}>${hall}`;
      const hide = nodeEl(page, hall).getByRole("button", { name: `Hide sub-assets of ${SMALL_NAMES.hall}`, exact: true });
      const show = nodeEl(page, hall).getByRole("button", { name: `Show sub-assets of ${SMALL_NAMES.hall}`, exact: true });

      await test.step("open: the hall has a toggle, the rack (no sub-asset) has none; Alpha has an edge to each", async () => {
        await expect(hide).toBeVisible();
        await expect(nodeEl(page, rack).getByRole("button", { name: /sub-assets of/ })).toHaveCount(0);
        await expect(nodeEl(page, hall)).toHaveAttribute("aria-label", `${SMALL_NAMES.hall}, asset, 1 sub-asset, open`);
        await expect(edgeEl(page, toRack)).toHaveCount(1);
        await expect(edgeEl(page, toHall)).toHaveCount(1);
        await expect(edgeLabel(page, toHall), "three points are mapped to the hall").toHaveText("3 mapped");
        await expect(edgesWith(page, "a:"), "the hall-to-rack edge").toHaveCount(1);
      });

      await test.step("hide: the rack and its edges go; the hall wears the badge and takes all four mappings on ONE edge", async () => {
        await hide.click();
        await expect(nodeEl(page, rack)).toHaveCount(0);
        await expect(show).toBeVisible();
        await expect(nodeEl(page, hall).locator(".gnode-mapped"), "four points are mapped to the hall or to what it hides").toHaveText("4 mapped");
        await expect(nodeEl(page, hall)).toHaveAttribute("aria-label", `${SMALL_NAMES.hall}, asset, 1 sub-asset, 4 mapped inside, closed`);
        await expect(edgesWith(page, "a:"), "the edge to the hidden rack is gone").toHaveCount(0);
        await expect(edgeEl(page, toRack)).toHaveCount(0);
        await expect(edgesWith(page, `m:${nid.source(SMALL.alpha)}>`), "ONE edge from Alpha now").toHaveCount(1);
        await expect(edgeLabel(page, toHall), "with the summed label").toHaveText("4 mapped");
        await expectFocusKept(page, "after hiding the sub-assets");
        expect(await page.evaluate(() => window.localStorage.getItem("dcdash.discovery.assets-closed")), "the fold is stored").toBe(JSON.stringify([SMALL.hall]));
      });

      await test.step("it is remembered after a reload", async () => {
        await reloaded(page);
        await expect(show).toBeVisible();
        await expect(nodeEl(page, rack)).toHaveCount(0);
        await expect(nodeEl(page, hall).locator(".gnode-mapped")).toHaveText("4 mapped");
      });

      await test.step("show: everything is back", async () => {
        await show.click();
        await expect(nodeEl(page, rack)).toBeVisible();
        await expect(hide).toBeVisible();
        await expect(nodeEl(page, hall).locator(".gnode-mapped")).toHaveCount(0);
        await expect(edgeEl(page, toRack)).toHaveCount(1);
        await expect(edgeLabel(page, toHall)).toHaveText("3 mapped");
        await expect(edgesWith(page, "a:")).toHaveCount(1);
        await expectFocusKept(page, "after showing the sub-assets");
      });
    });

    test("5b the fold is there for a role that holds only discovery.view and assets.view", async ({ page }) => {
      test.setTimeout(180_000);
      await arrive(page, smallModel(), { ...size, permissions: ["discovery.view", "assets.view"] });
      const hall = nid.asset(SMALL.hall);
      await expect(nodeEl(page, hall).getByRole("button", { name: /Add a sub-asset/ }), "this role changes no asset: no + on the node").toHaveCount(0);
      await nodeEl(page, hall).getByRole("button", { name: `Hide sub-assets of ${SMALL_NAMES.hall}`, exact: true }).click();
      await expect(nodeEl(page, nid.asset(SMALL.rack))).toHaveCount(0);
      await expect(nodeEl(page, hall).getByRole("button", { name: `Show sub-assets of ${SMALL_NAMES.hall}`, exact: true })).toBeVisible();
      await expect(nodeEl(page, hall).locator(".gnode-mapped")).toHaveText("4 mapped");
    });

    // -------------------------------------------------------------------------------------------------------------------------
    test("6 Expand and Collapse of a selection and of a branch, from the bar and from the right-click menus", async ({ page }) => {
      test.setTimeout(300_000);
      await arrive(page, smallModel(), size);
      const expandMore = barButton(page, "More ways to expand");
      const collapseMore = barButton(page, "More ways to collapse");
      const [alpha, bravo] = [nid.source(SMALL.alpha), nid.source(SMALL.bravo)];
      const [lvp01, lvp02] = [nid.cluster(SMALL.alpha, SMALL_GROUPS.lvp01), nid.cluster(SMALL.alpha, SMALL_GROUPS.lvp02)];
      // `.last()`: the same words may still be on screen from the step before (a toast stays for several seconds), as in w12a.
      const polite = (text: string | RegExp) => toast(page, text).last();

      await test.step("nothing is selected: both chevrons are aria-disabled, with the reason in their title and as their description; a click opens nothing", async () => {
        for (const chevron of [expandMore, collapseMore]) {
          await expect(chevron).toHaveAttribute("aria-disabled", "true");
          await expect(chevron).toHaveAttribute("title", REASON.nothingSelected);
          await expect(chevron).toHaveAccessibleDescription(REASON.nothingSelected);
          await chevron.click({ force: true }); // an aria-disabled button is "not enabled" to Playwright: force skips that check
          await expect(menuEl(page)).toHaveCount(0);
        }
      });

      await test.step("open Alpha: its two groups are drawn, closed; box-select both", async () => {
        await nodeEl(page, alpha).getByRole("button", { name: `Expand ${SMALL_NAMES.alpha}`, exact: true }).click();
        await expect(clusters(page)).toHaveCount(2);
        await cameraStill(page);
        await fitViewNow(page);
        await boxSelect(page, [lvp01, lvp02]);
        await expect(expandMore, "something can be opened").not.toHaveAttribute("aria-disabled", "true");
        await expect(collapseMore, "nothing selected is open").toHaveAttribute("aria-disabled", "true");
        await expect(collapseMore).toHaveAttribute("title", REASON.alreadyClosed);
      });

      await test.step("the bar: Expand selection opens both groups and says so; Collapse selection closes them", async () => {
        await expandMore.click();
        const menu = page.getByRole("menu", { name: "Expand options", exact: true });
        await expect(menu).toBeVisible();
        await menu.getByRole("menuitem", { name: "Expand selection", exact: true }).click();
        await expect(polite("Opened 2 groups.")).toBeVisible();
        await expect(pointNodes(page), "LVP01's three points and LVP02's six").toHaveCount(9);
        await expectFocusKept(page, "after Expand selection");
        await expect(collapseMore, "now the selection can be closed").not.toHaveAttribute("aria-disabled", "true");
        await collapseMore.click();
        const closing = page.getByRole("menu", { name: "Collapse options", exact: true });
        await expect(closing).toBeVisible();
        await closing.getByRole("menuitem", { name: "Collapse selection", exact: true }).click();
        await expect(polite("Closed 2 groups.")).toBeVisible();
        await expect(pointNodes(page)).toHaveCount(0);
        await expectFocusKept(page, "after Collapse selection");
      });

      await test.step("the selection's right-click menu has the same two items, a blocked one with its reason", async () => {
        await page.locator(".react-flow__nodesselection-rect").click({ button: "right" });
        const menu = menuEl(page);
        await expect(menu).toBeVisible();
        const blocked = menu.getByRole("menuitem", { name: /^Collapse selection/ });
        await expect(blocked).toHaveAttribute("aria-disabled", "true");
        await expect(blocked).toContainText(REASON.alreadyClosed);
        await menu.getByRole("menuitem", { name: "Expand selection", exact: true }).click();
        await expect(polite("Opened 2 groups.")).toBeVisible();
        await expect(pointNodes(page)).toHaveCount(9);
        await expectFocusKept(page, "after the menu's Expand selection");
      });

      await test.step("the empty canvas's menu lists them too, blocked while nothing is selected", async () => {
        const spot = await emptySpot(page);
        await page.mouse.click(spot.x, spot.y); // a click on the empty canvas clears the selection
        await expect.poll(() => selectedIds(page)).toEqual([]);
        await page.mouse.click(spot.x, spot.y, { button: "right" });
        const menu = menuEl(page);
        await expect(menu).toBeVisible();
        for (const label of [/^Expand selection/, /^Collapse selection/]) {
          const item = menu.getByRole("menuitem", { name: label });
          await expect(item).toHaveAttribute("aria-disabled", "true");
          await expect(item).toContainText(REASON.nothingSelected);
        }
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
      });

      await test.step("the bar's branch items: Collapse this branch closes Alpha and forgets its groups, Expand this branch opens it with both", async () => {
        await fitViewNow(page);
        await boxSelect(page, [alpha]);
        await collapseMore.click();
        await page.getByRole("menu", { name: "Collapse options", exact: true }).getByRole("menuitem", { name: "Collapse this branch", exact: true }).click();
        await expect(polite("Closed 1 source and 2 groups.")).toBeVisible();
        await expect(clusters(page)).toHaveCount(0);
        await expandMore.click();
        await page.getByRole("menu", { name: "Expand options", exact: true }).getByRole("menuitem", { name: "Expand this branch", exact: true }).click();
        await expect(polite("Opened 1 source and 2 groups.")).toBeVisible();
        await expect(clusters(page)).toHaveCount(2);
        await expect(pointNodes(page), "the groups are open too").toHaveCount(9);
        await expectFocusKept(page, "after Expand this branch");
      });

      await test.step("a source's right-click menu: Expand this branch on a closed source, then Collapse this branch", async () => {
        const spot = await emptySpot(page);
        await page.mouse.click(spot.x, spot.y);
        await expect.poll(() => selectedIds(page)).toEqual([]);
        await fitViewNow(page);
        const open = async () => {
          const at = centreOf(await boxOf(titleOf(page, bravo), "the title of Bravo"));
          await page.mouse.click(at.x, at.y, { button: "right" });
          await expect(menuEl(page)).toBeVisible();
        };
        await open();
        await menuEl(page).getByRole("menuitem", { name: /^Expand this branch/ }).click();
        await expect(polite("Opened 1 source and 1 group.")).toBeVisible();
        const rackB = nid.cluster(SMALL.bravo, SMALL_GROUPS.rackB);
        await expect(nodeEl(page, rackB)).toBeVisible();
        await expect(nodeEl(page, nid.point(SMALL.bravoPower)), "and the group is open: its points are drawn").toBeVisible();
        await expectFocusKept(page, "after the menu's Expand this branch");

        await open();
        await menuEl(page).getByRole("menuitem", { name: /^Collapse this branch/ }).click();
        await expect(polite("Closed 1 source and 1 group.")).toBeVisible();
        await expect(nodeEl(page, rackB)).toHaveCount(0);
        await expectFocusKept(page, "after the menu's Collapse this branch");
        // The toasts are announced: they are in the polite region (the locator above looks only there).
        await expect(page.locator('.toast-stack[aria-live="polite"]')).toHaveCount(1);
      });
    });

    // -------------------------------------------------------------------------------------------------------------------------
    test("7a the keyboard: Tab, the arrows between siblings, parent and child, Enter, the ContextMenu key, and the names of the nodes", async ({ page }) => {
      test.setTimeout(240_000);
      await arrive(page, smallModel(), size);
      const alpha = nid.source(SMALL.alpha);
      const [lvp01, lvp02] = [nid.cluster(SMALL.alpha, SMALL_GROUPS.lvp01), nid.cluster(SMALL.alpha, SMALL_GROUPS.lvp02)];
      const lvp02Points = smallModel().sources[0].clusters[1].points;
      const [kw, kwh] = [nid.point(lvp02Points[0].id), nid.point(lvp02Points[1].id)];
      const NAME = {
        alphaClosed: sourceName(SMALL_NAMES.alpha, 2, 9, false), alphaOpen: sourceName(SMALL_NAMES.alpha, 2, 9, true),
        lvp01: groupName(SMALL_GROUPS.lvp01, 3, 1, false), lvp02Closed: groupName(SMALL_GROUPS.lvp02, 6, 3, false), lvp02Open: groupName(SMALL_GROUPS.lvp02, 6, 3, true),
        kw: `${lvp02Points[0].name}, point, mapped to ${SMALL_NAMES.hall}`,
      };
      /** Presses a key and waits for the focus to land on `id`; <body> is never where it is. */
      const land = async (key: string, id: string) => {
        await page.keyboard.press(key);
        await expect.poll(() => focusedNodeId(page), { message: `${key} lands on ${id}` }).toBe(id);
        await expectFocusKept(page, `after ${key}`);
      };
      /** A key that has nowhere to go leaves the focus where it is. */
      const stay = async (key: string, id: string) => {
        await page.keyboard.press(key);
        await page.waitForTimeout(250);
        expect(await focusedNodeId(page), `${key} has nowhere to go, so the focus stays on ${id}`).toBe(id);
      };

      await test.step("Tab from the canvas reaches the first node, which is named", async () => {
        const spot = await emptySpot(page);
        await page.mouse.click(spot.x, spot.y); // the focus is in the canvas group
        await page.keyboard.press("Tab");
        expect.soft(await focusedNodeId(page), "the first Tab stop in the canvas is the first source").toBe(alpha);
        if ((await focusedNodeId(page)) !== alpha) await focusQuietly(nodeEl(page, alpha)); // go on from there whatever Tab did
        await expect(nodeEl(page, alpha)).toHaveAttribute("aria-label", NAME.alphaClosed);
        await expect(nodeEl(page, alpha)).toHaveAccessibleName(NAME.alphaClosed);
        await expect(nodeEl(page, alpha), "a screen reader is told the keys").toHaveAccessibleDescription(/Arrow keys move between nodes/);
      });

      await test.step("Enter opens the source; the focus stays on it", async () => {
        await page.keyboard.press("Enter");
        await expect(clusters(page)).toHaveCount(2);
        await expect(nodeEl(page, alpha)).toHaveAttribute("aria-label", NAME.alphaOpen);
        expect(await focusedNodeId(page)).toBe(alpha);
        await expectFocusKept(page, "after Enter on a source");
      });

      await test.step("ArrowRight goes to the first child, ArrowDown and ArrowUp between the groups", async () => {
        await land("ArrowRight", lvp01);
        await expect(nodeEl(page, lvp01)).toHaveAttribute("aria-label", NAME.lvp01);
        await land("ArrowDown", lvp02);
        await expect(nodeEl(page, lvp02)).toHaveAttribute("aria-label", NAME.lvp02Closed);
        await stay("ArrowDown", lvp02);
        await land("ArrowUp", lvp01);
        await land("ArrowDown", lvp02);
      });

      await test.step("Enter on a group opens it; its first child is its first point; ArrowLeft goes back to the group", async () => {
        await page.keyboard.press("Enter");
        await expect(pointNodes(page)).toHaveCount(6);
        await expect(nodeEl(page, lvp02)).toHaveAttribute("aria-label", NAME.lvp02Open);
        await expectFocusKept(page, "after Enter on a group");
        await land("ArrowRight", kw);
        await expect(nodeEl(page, kw)).toHaveAttribute("aria-label", NAME.kw);
        await land("ArrowDown", kwh);
        await land("ArrowUp", kw);
        await stay("ArrowRight", kw);
        await land("ArrowLeft", lvp02);
        await page.keyboard.press("Enter");
        await expect(pointNodes(page), "Enter closes it again").toHaveCount(0);
        await expect(nodeEl(page, lvp02)).toHaveAttribute("aria-label", NAME.lvp02Closed);
        await page.keyboard.press("Enter");
        await expect(pointNodes(page)).toHaveCount(6);
        await expectFocusKept(page, "after Enter twice on a group");
      });

      await test.step("the ContextMenu key opens the point's menu and Escape gives the focus back to it", async () => {
        await land("ArrowRight", kw);
        await page.keyboard.press("ContextMenu");
        const menu = menuEl(page);
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("menuitem").first(), "the focus is in the menu").toBeFocused();
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
        await expect.poll(() => focusedNodeId(page), { message: "the focus is back on the point" }).toBe(kw);
      });

      await test.step("Enter on a point does not open or close anything", async () => {
        await page.keyboard.press("Enter");
        await page.waitForTimeout(250);
        await expect(pointNodes(page)).toHaveCount(6);
        await expect(nodeEl(page, lvp02)).toHaveAttribute("aria-label", NAME.lvp02Open);
        await expectFocusKept(page, "after Enter on a point");
      });
    });

    test("7b the camera pans, never zooms, to a node that was off screen; ArrowDown from the last point reaches Show more and Enter draws the next page", async ({ page }) => {
      test.setTimeout(300_000);
      const model = bigModel(PAGED_SHAPES);
      await arrive(page, model, { ...size, fit: false });
      const group = GROUP_OF(1);
      const cid = nid.cluster(BIG_SOURCE, group);
      const pointAt = (n: number) => nid.point(bigPointId(PAGED_SHAPES, 1, 1, n));
      await nodeEl(page, nid.source(BIG_SOURCE)).getByRole("button", { name: `Expand ${BIG_SOURCE_NAME}`, exact: true }).click();
      await expect(nodeEl(page, cid)).toBeVisible();
      await cameraStill(page);
      await nodeEl(page, cid).getByRole("button", { name: `Expand ${group}`, exact: true }).click();
      await expect(pointNodes(page)).toHaveCount(PAGE_SIZE);
      await cameraStill(page);

      await focusQuietly(nodeEl(page, cid));
      const zoom = await zoomOf(page);
      const pan = await panOf(page);
      const pane = await boxOf(page.locator(".react-flow__pane"), "the pane");

      await test.step("ArrowRight, then ArrowDown 20 times: every node reached is in the canvas, the zoom never changes", async () => {
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => focusedNodeId(page)).toBe(pointAt(1));
        for (let n = 2; n <= 21; n++) {
          await page.keyboard.press("ArrowDown");
          await expect.poll(() => focusedNodeId(page), { message: `ArrowDown ${n - 1} lands on point ${n}` }).toBe(pointAt(n));
          await expectFocusKept(page, `at point ${n}`);
          await expect.poll(async () => inside(await boxOf(nodeEl(page, pointAt(n)), `point ${n}`), pane), { message: `point ${n} was brought into the canvas` }).toBe(true);
          expect(Math.abs((await zoomOf(page)) - zoom), `the zoom at point ${n}`).toBeLessThan(0.001);
        }
        await cameraStill(page);
        const now = await panOf(page);
        expect(Math.abs(now.y - pan.y), "the camera panned down the list").toBeGreaterThan(50);
        expect(Math.abs((await zoomOf(page)) - zoom), "and the zoom is what it was").toBeLessThan(0.001);
      });

      await test.step("ArrowDown from the last point of the page reaches the Show more button; Enter draws the next page and the focus moves to a point", async () => {
        await focusQuietly(nodeEl(page, pointAt(PAGE_SIZE)));
        await page.keyboard.press("ArrowDown");
        await expect.poll(() => focusedNodeId(page), { message: "ArrowDown from the last point reaches the Show more node" }).toBe(moreId(cid));
        const focus = await page.evaluate(() => ({ tag: document.activeElement?.tagName ?? "", label: document.activeElement?.getAttribute("aria-label") ?? "" }));
        expect(focus.tag, "it is the button inside the node that has the focus").toBe("BUTTON");
        expect(focus.label).toBe(`Show ${PAGE_SIZE} more points of ${group}, 70 left`);
        await page.keyboard.press("Enter");
        await expect(pointNodes(page)).toHaveCount(2 * PAGE_SIZE);
        await expect.poll(async () => (await focusOf(page)).nodeId?.startsWith("point:"), { message: "the focus is on a point of the new page" }).toBe(true);
      });
    });

    // -------------------------------------------------------------------------------------------------------------------------
    test("8 a toggle in a 2,022-node graph stays quick (measured in the page)", async ({ page }) => {
      test.setTimeout(420_000);
      await arrive(page, bigModel(DRAG_SHAPES), { ...size, fit: false });
      await openEverything(page, 2022);
      const group = GROUP_OF(1);
      const gid = nid.cluster(BIG_SOURCE, group);
      const first = nid.point(bigPointId(DRAG_SHAPES, 1, 1, 1));
      const button = (verb: "Collapse" | "Expand") => `${nodeSel(gid)} button[aria-label="${verb} ${group}"]`;

      /** Collapse the first group (49 points go), then open it again (they come back): the time of each. */
      const pair = async (): Promise<number[]> => {
        const collapse = await timedClick(page, { button: button("Collapse"), gone: nodeSel(first) });
        await page.waitForTimeout(500);
        const expand = await timedClick(page, { button: button("Expand"), done: nodeSel(first) });
        await page.waitForTimeout(500);
        return [collapse, expand];
      };
      const [collapse, expand] = await judged(
        `toggle of one group, ${at}, 2,022 nodes: [collapse, expand] (ms)`,
        ([c, e]) => c < LIMIT.collapse && e < LIMIT.expand,
        pair,
        async () => { await page.waitForTimeout(1_000); },
      );
      expect(collapse, `collapsing a group took ${round(collapse)} ms, the limit is ${LIMIT.collapse}`).toBeLessThan(LIMIT.collapse);
      expect(expand, `opening it took ${round(expand)} ms, the limit is ${LIMIT.expand}`).toBeLessThan(LIMIT.expand);
      await expect(page.locator(".react-flow__node"), "the graph is whole again").toHaveCount(2022);
    });

    // -------------------------------------------------------------------------------------------------------------------------
    test("9 hovering a point in a 2,022-node graph lights its path quickly (measured in the page)", async ({ page }) => {
      test.setTimeout(420_000);
      await arrive(page, bigModel(DRAG_SHAPES), { ...size, fit: false });
      await openEverything(page, 2022);
      await fitViewNow(page);
      for (let i = 0; i < 12 && (await zoomOf(page)) < 0.55; i++) {
        await page.getByRole("button", { name: "zoom in" }).click();
        await cameraStill(page);
      }
      await page.evaluate(() => {
        const w = window as unknown as { __w12bHover?: { enter: number; lit: number } };
        if (w.__w12bHover) return;
        const probe = { enter: 0, lit: 0 };
        w.__w12bHover = probe;
        document.addEventListener("mouseover", (e) => { if ((e.target as Element | null)?.closest?.(".react-flow__node")) probe.enter = performance.now(); }, true);
        const watch = document.querySelector(".react-flow__viewport")!;
        new MutationObserver((records) => {
          for (const r of records) {
            if (probe.lit === 0 && r.target instanceof Element && r.target.classList.contains("lit")) probe.lit = performance.now();
          }
        }).observe(watch, { attributes: true, attributeFilter: ["class"], subtree: true });
      });

      /** Four points in the middle of the canvas, the pointer on each in turn: the median time from the pointer arriving to the `lit` class, less the dwell. */
      const hover = async (): Promise<number> => {
        const away = await emptySpot(page);
        await page.mouse.move(away.x, away.y);
        await page.waitForTimeout(400);
        const points = await visiblePoints(page, 4);
        expect(points.length, "point nodes lie in the middle of the canvas").toBeGreaterThanOrEqual(3);
        const samples: number[] = [];
        for (const p of points) {
          await page.evaluate(() => { const probe = (window as unknown as { __w12bHover: { enter: number; lit: number } }).__w12bHover; probe.enter = 0; probe.lit = 0; });
          await page.mouse.move(p.box.x + 40, p.box.y + 12);
          await page.waitForTimeout(700);
          const read = await page.evaluate(() => (window as unknown as { __w12bHover: { enter: number; lit: number } }).__w12bHover);
          if (read.enter > 0 && read.lit > 0) samples.push(read.lit - read.enter - DWELL_MS);
          await page.mouse.move(away.x, away.y);
          await page.waitForTimeout(400);
        }
        expect(samples.length, "the path was lit for at least three of the four points").toBeGreaterThanOrEqual(3);
        return median(samples);
      };
      const afterDwell = await judged(
        `hover on a point, ${at}, 2,022 nodes: the class after the dwell (ms)`,
        (ms) => ms < LIMIT.hoverAfterDwell,
        hover,
        async () => { await page.waitForTimeout(1_000); },
      );
      expect(afterDwell, `the path was lit ${round(afterDwell)} ms after the ${DWELL_MS} ms dwell, the limit is ${LIMIT.hoverAfterDwell}`).toBeLessThan(LIMIT.hoverAfterDwell);
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Helpers of the big-graph cases

/** Repeated Expand all (one press opens at most 600 new nodes) until the bar says everything is open, then until the graph has `expected` nodes. */
async function openEverything(page: Page, expected: number): Promise<void> {
  const expand = barButton(page, "Expand all");
  for (let pass = 0; pass < 14; pass++) {
    if ((await expand.getAttribute("aria-disabled")) === "true") break;
    await expand.click();
    await nodesSettled(page);
  }
  await expect(page.locator(".react-flow__node"), "everything is drawn").toHaveCount(expected, { timeout: 60_000 });
}
/** The node count has held still for three reads 250 ms apart. */
async function nodesSettled(page: Page): Promise<void> {
  let last = -1;
  let same = 0;
  await expect
    .poll(async () => {
      const now = await page.locator(".react-flow__node").count();
      same = now === last ? same + 1 : 0;
      last = now;
      return same >= 3;
    }, { intervals: [250], timeout: 120_000, message: "the number of nodes never settled" })
    .toBe(true);
}

/** Up to `count` point nodes nearest the middle of the canvas that are really on screen: the point under the node's title belongs to the node (no tool, minimap or panel covers it). */
async function visiblePoints(page: Page, count: number): Promise<{ id: string; box: Box }[]> {
  return page.evaluate((n) => {
    const pane = document.querySelector(".react-flow__pane")!.getBoundingClientRect();
    const middle = { x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 };
    const found: { id: string; box: { x: number; y: number; width: number; height: number }; d: number }[] = [];
    for (const el of Array.from(document.querySelectorAll('.react-flow__node[data-id^="point:"]'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.left < pane.left || r.right > pane.right || r.top < pane.top || r.bottom > pane.bottom) continue;
      const under = document.elementFromPoint(r.left + 40, r.top + 12);
      if (!under || under.closest(".react-flow__node") !== el) continue;
      found.push({ id: el.getAttribute("data-id") ?? "", box: { x: r.left, y: r.top, width: r.width, height: r.height }, d: Math.hypot(r.left + r.width / 2 - middle.x, r.top + r.height / 2 - middle.y) });
    }
    return found.sort((a, b) => a.d - b.d).slice(0, n).map(({ id, box }) => ({ id, box }));
  }, count);
}
