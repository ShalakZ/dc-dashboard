import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  bigGroup, bigModel, bigPointId, bigSourceId, DRAG_SHAPES, LIVE_SHAPES, node as nid, PERF_SHAPES, SMALL, SMALL_GROUPS, SMALL_NAMES, smallModel,
  type ApiGraphModel, type XY,
} from "./graphModel";

// W7u (the premium Discovery canvas: a camera that glides, a snap grid with alignment guides, the path highlight, flowing edges on live sources, a status dot, a
// protocol badge and a progress strip on the nodes, a minimap, Shift-drag box select, right-click and Shift+F10 menus, and Find on Ctrl+K). Admin `admin` /
// `correct-horse`, the account the earlier projects use.
//
// THIS SPEC WRITES NOTHING. Every case answers GET /api/discovery/graph from a generated model (e2e/graphModel.ts, synthetic ids from 9,000,000 up) and the layout's
// PUT and DELETE through `page.route`, so the shared stack's sources, saved places and the earlier projects' leftovers do not matter. Any OTHER write the app tries
// (a POST, PATCH or DELETE under /api, the sign-in aside) is refused with a 500 and written down, and afterEach fails the case that made one. No case clicks Remove,
// Create mappings or a confirmation. The project may therefore stand anywhere in the order; it follows w7t, whose Tidy layout empties the REAL layout, which this spec never reads.
//
// The cases (each its own test; one failing does not stop the next):
//   nodes       the status dot (class, aria-hidden, title), the protocol badge (a plain rectangle), the facts words, the mapped strip of a group, and a source node no taller than SOURCE_H.
//   highlight   hovering a point lights exactly its path (the nodes and edges the DOM edges say) after a short rest, dims the rest to about .35, clears when the pointer
//               leaves, shows nothing during a drag, and a sweep across the pane between two lit nodes never clears (a MutationObserver on the wrapper's class watches it).
//   live edges  only the online source's source-to-group edges and the mapped links under it flow (a mapped link keeps a mostly solid `8 2` dash), never a group-to-point or an asset-to-asset edge;
//               under reduced motion nothing flows and the status dot stops pulsing.
//   minimap     named `Overview of the whole graph`, drawn when the canvas is 700 px wide or more, not over the attribution link.
//   snap        the toggle (aria-pressed, remembered over a reload) and the dragged place: a multiple of 8 on, free off.
//   box select  Shift-drag selects the nodes inside, the selection moves together and is saved, a right-click on it opens the canvas menu, Escape closes the menu and
//               then clears the selection; Ctrl or Cmd-click adds a node.
//   menus       right-click a source / group / point / asset, the keyboard (Shift+F10, the ContextMenu key), the canvas menu and what its items do; the menu opens at the pointer,
//               takes the focus in, and gives it back to the node on Escape.
//   find        Ctrl+K on the canvas opens Find (and not the top bar's quick find), the jump opens the parents and focuses the node, Escape gives the focus back, Ctrl+K from the
//               page body is still the quick find; at 6,000 points the list is capped at 50, a point deep in a paged group widens the page, and one too far down for the node
//               budget is honest about it (W12b).
//   hint        the short line and the tip that lists the keys, also while the graph loads.
//   placement   at 1440 x 900, 1024 x 640 and 800 x 600 with the offer shown AND the source panel open: the offer, the tools and the Find card do not overlap and stay in the canvas.
//   perf        (about 2,000 nodes, W12b: DRAG_SHAPES opened by repeated Expand all) the frames of a 3 s drag with guides, without the minimap and with snap off; hover to the lit path and the frames during the opacity
//               transition; the keystroke-to-results time of Find at 6,000 points; the idle cost of 100 flowing edges against the same graph without motion. The numbers go to
//               .superpowers/sdd/2026-10-15-w7u-discovery-premium/measure.json and into each case's `measure` annotation (a test title is fixed before the run, so it cannot hold them);
//               the assertions are generous on purpose, the controller reads the numbers.
//
// Locators. Playwright matches a name by case-insensitive SUBSTRING: every lookup of a new control is `exact: true` (the top bar's field is `Quick find`, a substring of
// `Find`). The Find field is the combobox `Search the graph`; the tools are measured through `.graph-tools-bar` and `.graph-find` (the panel `.graph-tools` itself spans the
// canvas and lets clicks through). Positions are read in FLOW coordinates from a node's transform, never from a screen box. A case that presses a node or reads a box waits for
// the camera to come to rest first (`cameraStill`): a source's own + now pans for 300 ms and Fit View glides. Screenshots go to .superpowers/sdd/overnight-w7/gallery/W7u/
// when W7U_GALLERY=1.

const ADMIN = { username: "admin", password: "correct-horse" };
/** lib/graph.ts: a source's block (SOURCE_H). A source node must be no taller than the room it is given. */
const SOURCE_H = 136;
/** lib/graphPrefs.ts: the snap grid, in flow pixels, and the key that remembers the toggle. */
const GRID = 8;
const SNAP_KEY = "dcdash.discovery.snap";
/** components/graph/GraphMiniMap.tsx: under this canvas width the minimap is not drawn. */
const MINIMAP_MIN_WIDTH = 700;
const DOT = "·"; // the middle dot of a source node's facts line
const ELLIPSIS = "…";

interface Box { x: number; y: number; width: number; height: number }

// ---------------------------------------------------------------------------------------------------------------------------------
// The stub: the generated graph, and the refusal of every other write

interface Stub {
  /** The places the layout holds now (the model's, then what the page PUT; DELETE empties it). */
  layout: Record<string, XY>;
  /** The nodes of each layout PUT, in order. */
  puts: { node_id: string; x: number; y: number }[][];
  deletes: number;
  /** How many times the page read the graph: 0 would mean the generated graph never reached it. */
  reads: number;
  /** Writes the stub does not know. The page gets a 500 and afterEach fails the case. */
  stray: string[];
}
let current: Stub | null = null;

test.afterEach(() => {
  const stub = current;
  current = null;
  expect(stub?.stray ?? [], "the spec writes nothing: these requests were refused").toEqual([]);
});

async function stubGraph(page: Page, model: ApiGraphModel, delayMs = 0): Promise<Stub> {
  const stub: Stub = { layout: { ...model.layout }, puts: [], deletes: 0, reads: 0, stray: [] };
  // Registered FIRST, so it is asked last: a request that is not a read and not the sign-in is refused and written down.
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    if (method === "GET" || method === "HEAD" || path === "/api/login") return route.continue();
    stub.stray.push(`${method} ${path}`);
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "w7u: this spec writes nothing" }) });
  });
  await page.route(/\/api\/discovery\/graph(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    stub.reads++;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...model, layout: stub.layout }) });
  });
  await page.route(/\/api\/discovery\/layout(\?.*)?$/, async (route) => {
    const method = route.request().method();
    if (method === "PUT") {
      const body = route.request().postDataJSON() as { nodes: { node_id: string; x: number; y: number }[] };
      stub.puts.push(body.nodes);
      for (const n of body.nodes) stub.layout[n.node_id] = { x: n.x, y: n.y };
      return route.fulfill({ status: 204 });
    }
    if (method === "DELETE") {
      stub.deletes++;
      stub.layout = {};
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
  current = stub;
  return stub;
}

async function signIn(page: Page): Promise<void> {
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in as ${ADMIN.username}: ${login.status()} ${await login.text()}`).toBe(true);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Locators and small readings

const GALLERY = fileURLToPath(new URL("../../.superpowers/sdd/overnight-w7/gallery/W7u/", import.meta.url));
async function shot(page: Page, name: string): Promise<void> {
  if (process.env.W7U_GALLERY !== "1") return;
  mkdirSync(GALLERY, { recursive: true });
  await page.screenshot({ path: `${GALLERY}${name}.png` });
}

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const nodeEl = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const titleOf = (page: Page, id: string) => nodeEl(page, id).locator(".node-title");
const canvasEl = (page: Page) => page.locator(".graph-canvas");
const bar = (page: Page) => page.locator(".graph-bar");
const barButton = (page: Page, name: string) => bar(page).getByRole("button", { name, exact: true });
const findButton = (page: Page) => page.getByRole("button", { name: "Find", exact: true });
const snapButton = (page: Page) => page.getByRole("button", { name: "Snap to grid", exact: true });
const findField = (page: Page) => page.getByRole("combobox", { name: "Search the graph", exact: true });
/** The options of the Find card's list (scoped: other lists on the page have options of their own). */
const findOptions = (page: Page) => page.locator(".graph-find").getByRole("option");
const quickFind = (page: Page) => page.getByRole("combobox", { name: "Quick find" });
const minimap = (page: Page) => page.getByRole("img", { name: "Overview of the whole graph", exact: true });
const menuEl = (page: Page) => page.locator('.graph-menu[role="menu"]');
const toast = (page: Page, text: string | RegExp) => page.locator(".toast-stack .toast").filter({ hasText: text });
const tipButton = (page: Page) => page.getByRole("button", { name: "What can I do on the canvas?", exact: true });
const clusters = (page: Page) => page.locator('.react-flow__node[data-id^="cluster:"]');
const pointNodes = (page: Page) => page.locator('.react-flow__node[data-id^="point:"]');

async function boxOf(target: Locator, what: string): Promise<Box> {
  const box = await target.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  return box!;
}
const centreOf = (box: Box): XY => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const overlap = (a: Box, b: Box) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
const inside = (box: Box, frame: Box) => box.x >= frame.x - 1 && box.y >= frame.y - 1 && box.x + box.width <= frame.x + frame.width + 1 && box.y + box.height <= frame.y + frame.height + 1;
const near = (a: XY, b: XY) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const plus = (a: XY, b: XY): XY => ({ x: a.x + b.x, y: a.y + b.y });
const minus = (a: XY, b: XY): XY => ({ x: a.x - b.x, y: a.y - b.y });
const median = (values: number[]) => (values.length === 0 ? 0 : [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]);
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
/** How far `value` is from the nearest multiple of the snap grid. */
const offGrid = (value: number) => {
  const m = ((value % GRID) + GRID) % GRID;
  return Math.min(m, GRID - m);
};

/** A node's place in FLOW coordinates, from the transform of its wrapper: the zoom and the pan do not enter. */
const flowPos = (target: Locator): Promise<XY> =>
  target.evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return { x: m.m41, y: m.m42 };
  });
const zoomOf = (page: Page) => page.locator(".react-flow__viewport").evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
const overflowOf = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const focusedNodeId = (page: Page) => page.evaluate(() => document.activeElement?.closest(".react-flow__node")?.getAttribute("data-id") ?? null);
const selectedIds = (page: Page) => page.locator(".react-flow__node.selected").evaluateAll((els) => els.map((el) => el.getAttribute("data-id") ?? "").sort());
const litNodeIds = (page: Page) => page.locator(".react-flow__node.lit").evaluateAll((els) => els.map((el) => el.getAttribute("data-id") ?? "").sort());
const canvasHolds = (page: Page) => page.evaluate(() => !!document.activeElement && !!document.querySelector(".graph-canvas")?.contains(document.activeElement));

interface EdgeFact { id: string; from: string; to: string; animated: boolean; lit: boolean; dash: string; animation: string }
/** Every edge the canvas draws: the ends from the library's own aria-label (`Edge from <source> to <target>`), the flow and the dash from the DOM. */
const edgesOf = async (page: Page): Promise<EdgeFact[]> => {
  const raw = await page.locator(".react-flow__edge").evaluateAll((els) =>
    els.map((el) => {
      const ends = /^Edge from (.+) to (.+)$/.exec(el.getAttribute("aria-label") ?? "");
      const path = el.querySelector(".react-flow__edge-path");
      const style = path ? getComputedStyle(path) : null;
      return {
        id: el.getAttribute("data-id") ?? "", from: ends?.[1] ?? "", to: ends?.[2] ?? "", animated: el.classList.contains("animated"), lit: el.classList.contains("lit"),
        dash: style?.strokeDasharray ?? "", animation: style?.animationName ?? "",
      };
    }));
  // "8px, 2px" -> "8 2"
  return raw.map((e) => ({ ...e, dash: e.dash.replace(/px/g, "").split(/[\s,]+/).filter(Boolean).join(" ") }));
};

/** The node, everything it is built from (edges walked backwards) and everything built on it (edges walked forwards): what the highlight must light. */
function pathIds(edges: readonly EdgeFact[], id: string): string[] {
  const found = new Set<string>([id]);
  const reach = (start: (e: EdgeFact) => string, end: (e: EdgeFact) => string) => {
    const queue = [id];
    for (let i = 0; i < queue.length; i++) {
      for (const e of edges) {
        if (start(e) !== queue[i] || found.has(end(e))) continue;
        found.add(end(e));
        queue.push(end(e));
      }
    }
  };
  reach((e) => e.to, (e) => e.from);
  reach((e) => e.from, (e) => e.to);
  return [...found].sort();
}

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

interface Opening { width?: number; height?: number; delayMs?: number }
/** Signs in, installs the stub for `model` and sets the window; the page is not opened yet. */
async function prepare(page: Page, model: ApiGraphModel, { width = 1440, height = 900, delayMs = 0 }: Opening = {}): Promise<Stub> {
  await signIn(page);
  const stub = await stubGraph(page, model, delayMs);
  await page.setViewportSize({ width, height });
  return stub;
}
/** Opens Discovery and waits for the first node and for the camera to rest. */
async function visit(page: Page, stub: Stub): Promise<void> {
  await page.goto("/discovery");
  await expect(heading1(page, "Discovery")).toBeVisible();
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 60_000 });
  expect(stub.reads, "the page read the generated graph, not the stack's").toBeGreaterThan(0);
  await cameraStill(page);
}
/** prepare + visit + Fit View (the window opens on the first sources; Fit View shows the whole graph). */
async function arrive(page: Page, model: ApiGraphModel, opening: Opening & { fit?: boolean } = {}): Promise<Stub> {
  const stub = await prepare(page, model, opening);
  await visit(page, stub);
  if (opening.fit !== false) await fitViewNow(page);
  return stub;
}

/** Expand all, then wait until the small model's five groups and fifteen points are drawn, and fit the view. */
async function expandSmall(page: Page): Promise<void> {
  await barButton(page, "Expand all").click();
  await expect(clusters(page)).toHaveCount(5);
  await expect(pointNodes(page)).toHaveCount(15);
  await fitViewNow(page);
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

/** The d3-drag path: real intermediate moves (locator.dragTo is not enough). */
async function dragPath(page: Page, from: XY, to: XY): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 6, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 25 });
  await page.mouse.up();
}
async function dragBy(page: Page, handle: Locator, by: XY): Promise<void> {
  const from = centreOf(await boxOf(handle, "the drag handle"));
  await dragPath(page, from, plus(from, by));
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

// ---------------------------------------------------------------------------------------------------------------------------------
// nodes

test.describe("W7u: the nodes", () => {
  test("a source node has a status dot, a protocol badge and its facts; a group has a progress strip of its mapped share; no source node is taller than SOURCE_H", async ({ page }) => {
    test.setTimeout(120_000);
    await arrive(page, smallModel());
    await expandSmall(page);
    const zoom = await zoomOf(page);

    const cases = [
      { id: SMALL.alpha, key: "online", title: "online", proto: "OPC UA", facts: `discovered ${DOT} online ${DOT} 9 points` },
      { id: SMALL.bravo, key: "offline", title: "offline", proto: "Modbus", facts: `discovered ${DOT} offline ${DOT} 2 points` },
      { id: SMALL.charlie, key: "credentials", title: "needs credentials", proto: "OPC UA", facts: `discovered ${DOT} unknown ${DOT} 2 points` },
      { id: SMALL.delta, key: "idle", title: "disabled", proto: "Simulator", facts: `manual ${DOT} unknown ${DOT} 2 points` },
    ];
    for (const c of cases) {
      await test.step(`${c.key}: ${c.proto}`, async () => {
        const src = nodeEl(page, nid.source(c.id));
        const dot = src.locator(".gdot");
        await expect(dot, "one status dot").toHaveCount(1);
        await expect(dot).toHaveClass(new RegExp(`gdot-${c.key}`));
        await expect(dot, "decoration: the status word is in the text").toHaveAttribute("aria-hidden", "true");
        await expect(dot).toHaveAttribute("title", c.title);
        const dotBox = await boxOf(dot, "the dot");
        expect.soft(dotBox.width / zoom, "the dot is 8 px").toBeGreaterThan(7);
        expect.soft(dotBox.width / zoom).toBeLessThan(9);
        await expect(src.locator(".gproto"), "the protocol badge").toHaveText(c.proto);
        const radius = await src.locator(".gproto").evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
        expect.soft(radius, "a plain rectangle, never a pill").toBeLessThanOrEqual(6);
        await expect(src.locator(".gnode-facts"), "the words stay in the node's text").toContainText(c.facts);
        const height = (await boxOf(src.locator(".gnode"), "the source node")).height / zoom;
        expect.soft(height, `the node is ${height.toFixed(1)} px high, the block gives it ${SOURCE_H}`).toBeLessThanOrEqual(SOURCE_H + 1);
      });
    }
    await expect(nodeEl(page, nid.source(SMALL.charlie)).locator(".badge")).toHaveText("needs credentials");
    for (const id of [SMALL.alpha, SMALL.bravo, SMALL.delta]) await expect(nodeEl(page, nid.source(id)).locator(".badge")).toHaveCount(0);

    await test.step("a group's strip is the share of its points that are mapped", async () => {
      for (const [source, key, width, title] of [
        [SMALL.alpha, SMALL_GROUPS.lvp02, "50%", "3 of 6 mapped"],
        [SMALL.alpha, SMALL_GROUPS.lvp01, "33%", "1 of 3 mapped"],
        [SMALL.bravo, SMALL_GROUPS.rackB, "0%", "0 of 2 mapped"],
      ] as const) {
        const group = nodeEl(page, nid.cluster(source, key));
        const strip = group.locator(".gprogress");
        await expect(strip, `${key}: one strip`).toHaveCount(1);
        await expect(strip).toHaveAttribute("aria-hidden", "true");
        await expect(strip).toHaveAttribute("title", title);
        expect(await strip.evaluate((el) => (el as HTMLElement).style.width), `${key}: the strip is ${width} wide`).toBe(width);
        await expect(strip).toHaveCSS("position", "absolute");
        await expect(strip).toHaveCSS("height", "3px");
      }
      await expect(nodeEl(page, nid.cluster(SMALL.alpha, SMALL_GROUPS.lvp02)), "the words stay").toContainText("3 mapped");
    });
    await shot(page, "nodes-1440");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// highlight

test.describe("W7u: the path highlight", () => {
  test("hovering a point lights exactly its path after a short rest, dims everything else, clears when the pointer leaves, and shows nothing during a drag", async ({ page }) => {
    test.setTimeout(120_000);
    await arrive(page, smallModel());
    await expandSmall(page);
    expect(await page.evaluate(() => window.matchMedia("(hover: hover)").matches), "this browser can hover, so the highlight is on").toBe(true);
    const canvas = canvasEl(page);
    const mapped = nid.point(SMALL.alphaMapped);
    const away = await emptySpot(page);
    await page.mouse.move(away.x, away.y);
    await expect(canvas).not.toHaveClass(/has-focus/);

    await test.step("the path of the mapped point: its group, its source and the asset it feeds, and nothing else", async () => {
      await titleOf(page, mapped).hover();
      await expect(canvas, "has-focus after the 120 ms dwell").toHaveClass(/has-focus/);
      const edges = await edgesOf(page);
      const want = pathIds(edges, mapped);
      expect(want, "the model's path is the source, the group, the point and the rack (the hall is only the rack's parent)").toEqual(
        [nid.source(SMALL.alpha), nid.cluster(SMALL.alpha, SMALL_GROUPS.lvp01), mapped, nid.asset(SMALL.rack)].sort());
      await expect.poll(() => litNodeIds(page), { message: "exactly the path's nodes are lit" }).toEqual(want);
      const litEdges = edges.filter((e) => want.includes(e.from) && want.includes(e.to)).map((e) => e.id).sort();
      await expect.poll(async () => (await edgesOf(page)).filter((e) => e.lit).map((e) => e.id).sort(), { message: "and the edges between them" }).toEqual(litEdges);
      await shot(page, "highlight-1440");
    });

    await test.step("everything off the path dims to about .35, the path stays at full strength", async () => {
      const bravo = nodeEl(page, nid.source(SMALL.bravo));
      await expect.poll(() => bravo.evaluate((el) => parseFloat(getComputedStyle(el).opacity)), { message: "an unrelated source" }).toBeCloseTo(0.35, 1);
      expect(await nodeEl(page, mapped).evaluate((el) => parseFloat(getComputedStyle(el).opacity))).toBeGreaterThan(0.95);
    });

    await test.step("leaving clears it", async () => {
      await page.mouse.move(away.x, away.y);
      await expect(canvas).not.toHaveClass(/has-focus/);
      await expect(page.locator(".react-flow__node.lit")).toHaveCount(0);
    });

    await test.step("no highlight while a node is being dragged", async () => {
      await titleOf(page, mapped).hover();
      await expect(canvas).toHaveClass(/has-focus/);
      const at = centreOf(await boxOf(titleOf(page, mapped), "the point's title"));
      await page.mouse.down();
      await page.mouse.move(at.x + 40, at.y + 30, { steps: 6 });
      await expect(canvas, "the highlight goes when the drag starts").not.toHaveClass(/has-focus/);
      await page.waitForTimeout(400);
      await expect(canvas, "and stays away for as long as the drag runs").not.toHaveClass(/has-focus/);
      await page.mouse.up();
    });
  });

  test("sweeping the pointer from one lit node to another across the pane never clears the highlight", async ({ page }) => {
    test.setTimeout(120_000);
    await arrive(page, smallModel()); // all closed: the source maps straight onto its assets
    const canvas = canvasEl(page);
    const [alpha, hall] = [nid.source(SMALL.alpha), nid.asset(SMALL.hall)];
    await titleOf(page, alpha).hover();
    await expect(canvas).toHaveClass(/has-focus/);
    const want = pathIds(await edgesOf(page), alpha);
    expect(want, "the source lights the two assets it feeds").toEqual([alpha, nid.asset(SMALL.rack), hall].sort());
    await expect.poll(() => litNodeIds(page)).toEqual(want);

    // A MutationObserver sees a clear that a poll would miss: any moment without has-focus counts.
    await page.evaluate(() => {
      const w = window as unknown as { __w7uCleared?: boolean };
      const el = document.querySelector(".graph-canvas")!;
      w.__w7uCleared = false;
      new MutationObserver(() => { if (!el.classList.contains("has-focus")) w.__w7uCleared = true; }).observe(el, { attributes: true, attributeFilter: ["class"] });
    });
    // Every point is worked out BEFORE the first move: the two moves must follow each other well inside the 80 ms grace.
    const [from, to] = [await boxOf(nodeEl(page, alpha), "the source"), await boxOf(nodeEl(page, hall), "the hall")];
    const gap: XY = { x: (from.x + from.width + to.x) / 2, y: centreOf(from).y };
    const landing = centreOf(await boxOf(titleOf(page, hall), "the hall's title"));
    expect(gap.x > from.x + from.width && gap.x < to.x, "the point between the two nodes is clear of both").toBe(true);
    await page.mouse.move(gap.x, gap.y); // out of the source: the clear is only scheduled (80 ms)
    await page.mouse.move(landing.x, landing.y); // into the next node
    await page.waitForTimeout(400); // longer than the dwell and the grace together
    expect(await page.evaluate(() => (window as unknown as { __w7uCleared?: boolean }).__w7uCleared), "has-focus was never taken off during the sweep").toBe(false);
    await expect(canvas).toHaveClass(/has-focus/);
    await expect.poll(() => litNodeIds(page), { message: "and the path is the hall's, which is the same three nodes" }).toEqual(want);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// live edges

test.describe("W7u: the flowing edges", () => {
  /** The source a node of the small model belongs to (the edges of a source are told by the owner of their start). */
  const ownerOf = (() => {
    const owners = new Map<number, number>();
    for (const s of smallModel().sources) for (const p of [...s.ungrouped, ...s.clusters.flatMap((c) => c.points)]) owners.set(p.id, s.id);
    return (from: string): number => {
      if (from.startsWith("src:")) return Number(from.slice("src:".length));
      if (from.startsWith("cluster:")) return Number(from.split(":")[1]);
      return owners.get(Number(from.slice("point:".length))) ?? -1;
    };
  })();

  test("only the online source's source-to-group edges and the mapped links under it flow; a group-to-point edge stays dashed and still, a mapped link keeps a mostly solid dash and an asset-to-asset edge never moves", async ({ page }) => {
    test.setTimeout(120_000);
    await arrive(page, smallModel());
    await expandSmall(page);
    const edges = await edgesOf(page);
    expect(edges.filter((e) => e.id.startsWith("e:")).length, "the discovered edges: 5 groups and 15 points").toBe(20);
    expect(edges.filter((e) => e.id.startsWith("m:")).length, "the mapped links: 4 mapped points").toBe(4);
    expect(edges.filter((e) => e.id.startsWith("a:")).length, "the asset-to-asset edge").toBe(1);

    const mustFlow = edges.filter((e) => !e.id.startsWith("a:") && !e.id.startsWith("e:cluster:") && ownerOf(e.from) === SMALL.alpha).map((e) => e.id).sort();
    expect(mustFlow.length, "the online source owns 2 source-to-group edges (9 group-to-point edges never flow) and 4 mapped links").toBe(6);
    expect(edges.filter((e) => e.animated).map((e) => e.id).sort(), "exactly the online source's source-to-group edges and mapped links flow").toEqual(mustFlow);
    for (const e of edges) {
      const flows = mustFlow.includes(e.id);
      if (e.id.startsWith("e:")) expect(e.dash, `${e.id} stays dashed`).toBe("6 4");
      if (e.id.startsWith("m:")) expect(e.dash, `${e.id}: ${flows ? "mostly solid, with a small gap that flows" : "solid"}`).toBe(flows ? "8 2" : "none");
      if (e.id.startsWith("a:")) expect(e.dash, `${e.id} stays solid`).toBe("none");
      if (flows) expect(e.animation, `${e.id} is animated`).not.toBe("none");
      else expect(e.animation, `${e.id} stands still`).toBe("none");
    }
    // The dot pulses (its animation is named); the node is not tied to the edges, so look at it here too.
    expect(await nodeEl(page, nid.source(SMALL.alpha)).locator(".gdot").evaluate((el) => getComputedStyle(el).animationName), "the online dot pulses").not.toBe("none");
    expect(await nodeEl(page, nid.source(SMALL.bravo)).locator(".gdot").evaluate((el) => getComputedStyle(el).animationName), "the offline dot is still").toBe("none");
  });

  test("with reduced motion nothing flows and the online dot does not pulse", async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await arrive(page, smallModel());
    await expandSmall(page);
    await expect(page.locator(".react-flow__edge.animated"), "no edge is animated").toHaveCount(0);
    const edges = await edgesOf(page);
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(e.animation, `${e.id}: no dash animation`).toBe("none");
      if (e.id.startsWith("e:")) expect(e.dash, `${e.id} keeps its dashes`).toBe("6 4");
      else expect(e.dash, `${e.id} is solid`).toBe("none");
    }
    expect(await nodeEl(page, nid.source(SMALL.alpha)).locator(".gdot").evaluate((el) => getComputedStyle(el).animationName), "the online dot is still").toBe("none");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// minimap

test.describe("W7u: the minimap", () => {
  test("it is named, drawn from 700 px of canvas, and clear of the attribution link", async ({ page }) => {
    test.setTimeout(150_000);
    const stub = await prepare(page, smallModel());
    for (const [width, height] of [[1440, 900], [800, 600], [640, 500]] as const) {
      await test.step(`${width} x ${height}`, async () => {
        await page.setViewportSize({ width, height });
        await visit(page, stub);
        const pane = await boxOf(page.locator(".react-flow__pane"), "the pane");
        const want = pane.width >= MINIMAP_MIN_WIDTH;
        test.info().annotations.push({ type: "measure", description: `${width} x ${height}: the canvas is ${pane.width.toFixed(0)} px wide, the minimap ${want ? "drawn" : "hidden"}` });
        if (Math.abs(pane.width - MINIMAP_MIN_WIDTH) < 6) return; // too close to the line to say which side the pixel rounding falls on
        if (width === 1440) expect(want, "at 1440 the canvas is wide enough").toBe(true);
        if (width === 640) expect(want, "at 640 it is not").toBe(false);
        await expect(minimap(page), want ? "drawn" : "hidden").toHaveCount(want ? 1 : 0);
        if (want) {
          const map = await boxOf(page.locator(".react-flow__minimap"), "the minimap");
          const attribution = await boxOf(page.locator(".react-flow__attribution"), "the attribution");
          expect(inside(map, await boxOf(canvasEl(page), "the canvas")), "the minimap lies inside the canvas").toBe(true);
          expect(overlap(map, attribution), "and does not cover the attribution link").toBe(false);
          await shot(page, "minimap-1440");
        }
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// snap

test.describe("W7u: snap to grid", () => {
  test("the toggle is pressed by default, remembered over a reload, and written to localStorage", async ({ page }) => {
    test.setTimeout(120_000);
    await arrive(page, smallModel());
    const snap = snapButton(page);
    await expect(snap).toHaveAttribute("aria-pressed", "true");
    await snap.click();
    await expect(snap).toHaveAttribute("aria-pressed", "false");
    expect(await page.evaluate((key) => window.localStorage.getItem(key), SNAP_KEY)).toBe("off");
    await page.reload();
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
    await expect(snapButton(page), "still off after a reload").toHaveAttribute("aria-pressed", "false");
    await snapButton(page).click();
    await expect(snapButton(page)).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate((key) => window.localStorage.getItem(key), SNAP_KEY)).toBe("on");
    await page.reload();
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
    await expect(snapButton(page), "and on again").toHaveAttribute("aria-pressed", "true");
  });

  test("a dragged node stands on a multiple of 8 with snap on, and anywhere with snap off", async ({ page }) => {
    test.setTimeout(150_000);
    await arrive(page, smallModel());
    await expandSmall(page);
    const [first, second] = [nid.point(SMALL.bravoPower), nid.point(SMALL.deltaEnergy)]; // far from each other: the first one lands on its neighbour after a drag of 23 px
    const start = await flowPos(nodeEl(page, first));
    expect([offGrid(start.x), offGrid(start.y)], "the default places are on the grid").toEqual([0, 0]);

    await test.step("snap on", async () => {
      await expect(snapButton(page)).toHaveAttribute("aria-pressed", "true");
      await dragBy(page, titleOf(page, first), { x: 37, y: 23 });
      await expect.poll(async () => near(await flowPos(nodeEl(page, first)), start), { message: "the point moved" }).toBeGreaterThan(8);
      await page.waitForTimeout(250); // React Flow settles the last position after the mouse is up
      const at = await flowPos(nodeEl(page, first));
      expect(offGrid(at.x), `x ${at.x}`).toBeLessThan(0.01);
      expect(offGrid(at.y), `y ${at.y}`).toBeLessThan(0.01);
    });

    await test.step("snap off", async () => {
      await snapButton(page).click();
      await expect(snapButton(page)).toHaveAttribute("aria-pressed", "false");
      const before = await flowPos(nodeEl(page, second));
      await dragBy(page, titleOf(page, second), { x: 37, y: 23 });
      await expect.poll(async () => near(await flowPos(nodeEl(page, second)), before), { message: "the second point moved" }).toBeGreaterThan(8);
      await page.waitForTimeout(250);
      const at = await flowPos(nodeEl(page, second));
      expect(Math.max(offGrid(at.x), offGrid(at.y)), `(${at.x.toFixed(2)}, ${at.y.toFixed(2)}) is not on the grid`).toBeGreaterThan(0.01);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// box select

test.describe("W7u: box select", () => {
  test("Shift-drag selects the nodes inside, the selection moves together and is saved, a right-click on it opens the canvas menu, and Escape closes the menu and then clears the selection", async ({ page }) => {
    test.setTimeout(150_000);
    const stub = await arrive(page, smallModel());
    const [alpha, bravo] = [nid.source(SMALL.alpha), nid.source(SMALL.bravo)];
    await boxSelect(page, [alpha, bravo]);
    const canvas = canvasEl(page);
    const rect = page.locator(".react-flow__nodesselection-rect");

    await test.step("the selection lights the union of the paths", async () => {
      await expect(rect, "the library draws a rectangle over the selected nodes").toBeVisible();
      await expect(canvas).toHaveClass(/has-focus/);
      await expect.poll(() => litNodeIds(page)).toEqual([alpha, bravo, nid.asset(SMALL.hall), nid.asset(SMALL.rack)].sort());
      await shot(page, "boxselect-1440");
    });

    await test.step("dragging the selection moves both nodes by the same amount, and both are saved", async () => {
      const before = { a: await flowPos(nodeEl(page, alpha)), b: await flowPos(nodeEl(page, bravo)) };
      const at = centreOf(await boxOf(rect, "the selection rectangle"));
      await dragPath(page, at, plus(at, { x: 70, y: 50 }));
      await expect.poll(async () => near(await flowPos(nodeEl(page, alpha)), before.a), { message: "the selection moved" }).toBeGreaterThan(10);
      await page.waitForTimeout(250);
      const moved = { a: minus(await flowPos(nodeEl(page, alpha)), before.a), b: minus(await flowPos(nodeEl(page, bravo)), before.b) };
      expect(near(moved.a, moved.b), `both moved by (${moved.a.x}, ${moved.a.y}) and (${moved.b.x}, ${moved.b.y})`).toBeLessThanOrEqual(1);
      await expect.poll(() => new Set(stub.puts.flat().map((n) => n.node_id)).has(alpha) && new Set(stub.puts.flat().map((n) => n.node_id)).has(bravo), { message: "the layout PUT names both" }).toBe(true);
      expect(await selectedIds(page), "and they are still selected").toEqual([alpha, bravo].sort());
    });

    await test.step("a right-click on the selection opens the canvas menu, not a node's", async () => {
      await rect.click({ button: "right" });
      const menu = menuEl(page);
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: /^Expand all/ })).toHaveCount(1);
      await expect(menu.getByRole("menuitem", { name: /^Tidy layout/ })).toHaveCount(1);
      await expect(menu.getByRole("menuitem", { name: /^Details/ }), "a source menu would have Details").toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(menu, "the first Escape closes the menu").toBeHidden();
      expect(await selectedIds(page), "and leaves the selection").toEqual([alpha, bravo].sort());
    });

    await test.step("the next Escape clears the selection", async () => {
      expect(await canvasHolds(page), "the focus is back inside the canvas").toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => selectedIds(page), { message: "no node is selected" }).toEqual([]);
      await expect(canvas).not.toHaveClass(/has-focus/);
    });
  });

  test("Ctrl or Cmd-click adds a node to the selection", async ({ page }) => {
    test.setTimeout(120_000);
    await arrive(page, smallModel());
    const [alpha, bravo, charlie] = [nid.source(SMALL.alpha), nid.source(SMALL.bravo), nid.source(SMALL.charlie)];
    await boxSelect(page, [alpha, bravo]);
    await titleOf(page, charlie).click({ modifiers: ["ControlOrMeta"] }); // outside the rectangle; it also opens the source's panel, which is the page's own click rule
    await expect.poll(() => selectedIds(page), { message: "the third source joined the other two" }).toEqual([alpha, bravo, charlie].sort());
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// menus

// W12b: `expand` and `collapse` are EXACT (a node's menu also holds "Expand this branch" and "Collapse this branch", which a prefix would count too).
const ITEM = {
  details: /^Details/, expand: /^Expand$/, collapse: /^Collapse$/, create: /^Create assets/, remove: /^Remove/, map: /^Map/, newAsset: /^New asset/,
  expandAll: /^Expand all/, collapseAll: /^Collapse all/, tidy: /^Tidy layout/, fit: /^Fit view/,
};
const itemCount = (menu: Locator, name: RegExp) => menu.getByRole("menuitem", { name }).count();
const exactCount = (menu: Locator, name: string) => menu.getByRole("menuitem", { name, exact: true }).count();

test.describe("W7u: the menus", () => {
  test("a right-click opens the menu of what is under it, at the pointer, with the focus in it; Escape closes it and gives the focus back to the node", async ({ page }) => {
    test.setTimeout(180_000);
    await arrive(page, smallModel());
    await expandSmall(page);
    const menu = menuEl(page);

    const open = async (id: string): Promise<XY> => {
      const at = centreOf(await boxOf(titleOf(page, id), `the title of ${id}`));
      await page.mouse.click(at.x, at.y, { button: "right" });
      await expect(menu, `the menu of ${id}`).toBeVisible();
      return at;
    };
    const close = async (id: string) => {
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect.poll(() => focusedNodeId(page), { message: `the focus is back on ${id}` }).toBe(id);
    };

    await test.step("a source that can be removed: Details, Collapse, Create assets, Remove", async () => {
      const id = nid.source(SMALL.bravo);
      const at = await open(id);
      for (const [what, name] of [["Details", ITEM.details], ["Collapse", ITEM.collapse], ["Create assets", ITEM.create], ["Remove", ITEM.remove]] as const) {
        expect(await itemCount(menu, name), what).toBe(1);
      }
      expect(await itemCount(menu, ITEM.expand), "it is open, so no Expand").toBe(0);
      const box = await boxOf(menu, "the menu");
      expect.soft(near({ x: box.x, y: box.y }, at), `the menu opens at the pointer (${at.x.toFixed(0)}, ${at.y.toFixed(0)})`).toBeLessThanOrEqual(3);
      await expect(menu.getByRole("menuitem").first(), "the focus is in the menu").toBeFocused();
      await shot(page, "menu-source-1440");
      await close(id);
    });

    await test.step("a source with something mapped cannot be removed", async () => {
      const id = nid.source(SMALL.alpha);
      await open(id);
      expect(await itemCount(menu, ITEM.details)).toBe(1);
      expect(await itemCount(menu, ITEM.remove), "Alpha has mapped points").toBe(0);
      await close(id);
    });

    await test.step("a group with points left to map: Collapse, Map, New asset", async () => {
      const id = nid.cluster(SMALL.bravo, SMALL_GROUPS.rackB);
      await open(id);
      expect(await itemCount(menu, ITEM.collapse)).toBe(1);
      expect(await itemCount(menu, ITEM.map)).toBe(1);
      expect(await itemCount(menu, ITEM.newAsset)).toBe(1);
      await close(id);
    });

    // W12a: the admin of this spec holds assets.edit, so a point, a group and an asset have their mapping items in the menu (the node has a button for some of them, the menu
    // has them all). A role without assets.edit keeps the shorter lists and, for an asset, the canvas menu (w12a.spec.ts case 5 checks that with a reader).
    await test.step("an unmapped point: Map… and New asset… (the menu only: the node has no button for it), not the canvas menu", async () => {
      const id = nid.point(SMALL.bravoPower);
      await open(id);
      expect(await itemCount(menu, ITEM.map)).toBe(1);
      expect(await itemCount(menu, ITEM.newAsset), "an admin makes the asset with the form").toBe(1);
      expect(await exactCount(menu, "Unmap…"), "nothing is mapped on it").toBe(0);
      expect(await itemCount(menu, ITEM.expandAll), "it is not the canvas menu").toBe(0);
      await close(id);
    });

    await test.step("a mapped point: Unmap… and Move to another asset…, nothing to map, not the canvas menu", async () => {
      const id = nid.point(SMALL.alphaMapped);
      await open(id);
      expect(await exactCount(menu, "Unmap…"), "Unmap…").toBe(1);
      expect(await exactCount(menu, "Move to another asset…"), "Move to another asset…").toBe(1);
      expect(await itemCount(menu, ITEM.map), "a mapped point is not mapped again").toBe(0);
      expect(await itemCount(menu, ITEM.expandAll), "it is not the canvas menu").toBe(0);
      await close(id);
    });

    await test.step("an asset: New sub-asset… and Unmap everything from <source>… for the source that has points on it, not the canvas menu", async () => {
      const id = nid.asset(SMALL.hall);
      await open(id);
      expect(await exactCount(menu, "New sub-asset…"), "New sub-asset…").toBe(1);
      expect(await exactCount(menu, `Unmap everything from ${SMALL_NAMES.alpha}…`), "the source with three points on the hall").toBe(1);
      expect(await itemCount(menu, ITEM.expandAll), "it is not the canvas menu").toBe(0);
      await close(id);
    });

    await test.step("the empty canvas: the canvas actions, and New asset… for an admin", async () => {
      const at = await emptySpot(page);
      await page.mouse.click(at.x, at.y, { button: "right" });
      await expect(menu).toBeVisible();
      for (const [what, name] of [["Expand all", ITEM.expandAll], ["Collapse all", ITEM.collapseAll], ["Tidy layout", ITEM.tidy], ["Fit view", ITEM.fit]] as const) {
        expect(await itemCount(menu, name), what).toBe(1);
      }
      expect(await exactCount(menu, "New asset…"), "the pane can make an asset at the top level").toBe(1);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    });
  });

  test("Shift+F10 and the ContextMenu key open the focused node's menu, the arrows move through it, and Escape returns the focus to the node", async ({ page }) => {
    test.setTimeout(120_000);
    await arrive(page, smallModel());
    const id = nid.source(SMALL.bravo);
    const menu = menuEl(page);
    for (const key of ["Shift+F10", "ContextMenu"]) {
      await test.step(key, async () => {
        await nodeEl(page, id).focus();
        await page.keyboard.press(key);
        await expect(menu).toBeVisible();
        const items = menu.getByRole("menuitem");
        expect(await itemCount(menu, ITEM.details), "the source's menu").toBe(1);
        await expect(items.first()).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(items.nth(1)).toBeFocused();
        await page.keyboard.press("End");
        await expect(items.last()).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(items.first(), "the arrows wrap").toBeFocused();
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
        await expect.poll(() => focusedNodeId(page)).toBe(id);
      });
    }
  });

  test("the canvas menu: Expand all and Collapse all do what the bar's buttons do", async ({ page }) => {
    test.setTimeout(120_000);
    await arrive(page, smallModel());
    const menu = menuEl(page);
    const pick = async (name: RegExp) => {
      const at = await emptySpot(page);
      await page.mouse.click(at.x, at.y, { button: "right" });
      await expect(menu).toBeVisible();
      await menu.getByRole("menuitem", { name }).click();
      await expect(menu).toBeHidden();
    };
    await pick(ITEM.expandAll);
    await expect(clusters(page), "Expand all opened the groups").toHaveCount(5);
    await pick(ITEM.collapseAll);
    await expect(clusters(page), "Collapse all closed them").toHaveCount(0);
    expect(await canvasHolds(page), "the focus stays in the canvas, not on the body").toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// find

test.describe("W7u: Find", () => {
  test("Ctrl+K on the canvas opens Find (not the quick find); choosing a point in a closed group opens its parents, glides to it and focuses it; Escape gives the focus back", async ({ page }) => {
    test.setTimeout(150_000);
    await arrive(page, smallModel());
    const target = nid.point(SMALL.bravoVoltage);
    await expect(nodeEl(page, target), "the point is not drawn yet: its source and group are closed").toHaveCount(0);

    const spot = await emptySpot(page);
    await page.mouse.click(spot.x, spot.y);
    expect(await canvasHolds(page), "a click on the empty canvas puts the focus in the canvas").toBe(true);
    await page.keyboard.press("Control+K");
    const field = findField(page);
    await expect(field, "Find opens").toBeVisible();
    await expect(field).toBeFocused();
    await expect(quickFind(page), "and the top bar's quick find does not take the key").not.toBeFocused();

    await field.pressSequentially("rack-b volt");
    await expect(findOptions(page)).toHaveCount(1);
    await expect(page.locator(".graph-find-note")).toHaveText("1 result");
    await shot(page, "find-1440");
    await page.keyboard.press("Enter");

    await test.step("the parents are open, the camera ends on the point and the point holds the focus", async () => {
      await expect(nodeEl(page, nid.source(SMALL.bravo))).toBeVisible();
      await expect(nodeEl(page, nid.cluster(SMALL.bravo, SMALL_GROUPS.rackB))).toBeVisible();
      await expect(nodeEl(page, target)).toBeVisible();
      await expect(nodeEl(page, target), "the found node pulses").toHaveClass(/flash/);
      await expect.poll(() => focusedNodeId(page), { message: "the focus moves to the found node, after the camera has arrived" }).toBe(target);
      await cameraStill(page);
      expect(inside(await boxOf(nodeEl(page, target), "the point"), await boxOf(page.locator(".react-flow__pane"), "the pane")), "it ends inside the canvas").toBe(true);
      await expect(findField(page), "the card has closed").toHaveCount(0);
    });

    await test.step("Escape closes an open Find and the focus is back in the canvas", async () => {
      await page.keyboard.press("Control+K");
      await expect(findField(page)).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(findField(page)).toHaveCount(0);
      expect(await canvasHolds(page), "the focus went back into the canvas").toBe(true);
      expect(await page.evaluate(() => document.activeElement === document.body), "and not to the body").toBe(false);
    });
  });

  test("Ctrl+K from the page body is still the top bar's quick find", async ({ page }) => {
    test.setTimeout(90_000);
    await arrive(page, smallModel());
    await heading1(page, "Discovery").click(); // plain text: the focus is on the body
    expect(await page.evaluate(() => document.activeElement === document.body || document.activeElement?.tagName === "MAIN"), "the focus is outside the canvas").toBe(true);
    await page.keyboard.press("Control+K");
    await expect(quickFind(page)).toBeFocused();
    await expect(findField(page), "Find stays shut").toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// hint

test.describe("W7u: the hint", () => {
  test("the line is short, the tip lists the keys, and both are there while the graph loads", async ({ page }) => {
    test.setTimeout(120_000);
    const stub = await prepare(page, smallModel(), { delayMs: 1500 });
    await page.goto("/discovery");
    await test.step("while loading", async () => {
      await expect(page.locator(".graph-bar-space"), "the loading branch").toBeVisible({ timeout: 30_000 });
      await expect(page.locator(".page-head .sub")).toContainText("Dashed: discovered. Solid: assets.");
      await expect(tipButton(page), "the tip is in the loading branch too").toBeVisible();
    });
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
    expect(stub.reads).toBeGreaterThan(0);

    await test.step("once loaded", async () => {
      const hint = ((await page.locator(".page-head .sub").textContent()) ?? "").trim();
      expect(hint).toContain("Dashed: discovered. Solid: assets.");
      expect(hint).toContain(`Drag a group onto an asset or press New asset${ELLIPSIS}`);
      expect(hint.length, `the line is ${hint.length} characters`).toBeLessThanOrEqual(100);
      await expect(tipButton(page)).toHaveCount(1);
      await tipButton(page).click();
      const bubble = page.getByRole("note");
      await expect(bubble).toBeVisible();
      const text = (await bubble.innerText()).replace(/\s+/g, " ");
      for (const [what, pattern] of [
        ["Alt or Option moves a node alone", /Alt or Option/i],
        ["Shift-drag selects", /Shift/i],
        ["Ctrl or Cmd adds", /Ctrl or Cmd/i],
        ["Ctrl+K finds", /Ctrl\+K/i],
        ["right-click opens the actions", /right-click/i],
        ["Shift+F10 does too", /Shift\+F10/],
        ["hovering lights the path", /hover/i],
        ["Escape clears a selection", /Escape/i],
        ["W12b: the arrow keys move between nodes and Enter opens or closes one", /Arrow keys move between nodes\. Enter opens or closes one\./],
      ] as const) expect(text, what).toMatch(pattern);
      await page.keyboard.press("Escape");
      await expect(bubble).toHaveCount(0);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// placement

test.describe("W7u: placement", () => {
  for (const [width, height] of [[1440, 900], [1024, 640], [800, 600]] as const) {
    test(`at ${width} x ${height} with the offer shown and the source panel open, the offer, the tools and the Find card do not overlap and stay in the canvas`, async ({ page }) => {
      test.setTimeout(180_000);
      await arrive(page, smallModel(), { width, height });
      const alpha = nid.source(SMALL.alpha);
      const group = nid.cluster(SMALL.alpha, SMALL_GROUPS.lvp01);

      await test.step("open the source and drag its group onto empty canvas: the offer", async () => {
        await nodeEl(page, alpha).getByRole("button", { name: `Expand ${SMALL_NAMES.alpha}`, exact: true }).click();
        await expect(nodeEl(page, group)).toBeVisible();
        await cameraStill(page);
        await fitViewNow(page);
        await dragBy(page, titleOf(page, group), { x: 30, y: 20 });
        await expect(page.locator(".offer-bar"), "the offer is shown").toBeVisible();
        await expect(page.locator(".offer-bar")).toContainText(`Create asset "${SMALL_GROUPS.lvp01}" from this cluster?`);
      });
      await test.step("open the source panel and the Find card", async () => {
        await nodeEl(page, nid.source(SMALL.bravo)).getByRole("button", { name: `Details for ${SMALL_NAMES.bravo}`, exact: true }).click();
        await expect(page.getByRole("complementary", { name: "Source details" })).toBeVisible();
        await findButton(page).click();
        await findField(page).pressSequentially("rack-b power");
        await expect(findOptions(page)).toHaveCount(1);
      });

      const canvas = await boxOf(canvasEl(page), "the canvas");
      const parts: [string, Box][] = [
        ["the offer", await boxOf(page.locator(".offer-bar"), "the offer")],
        ["Find", await boxOf(findButton(page), "the Find button")],
        ["Snap to grid", await boxOf(snapButton(page), "the Snap to grid button")],
        ["the Find card", await boxOf(page.locator(".graph-find"), "the Find card")],
      ];
      test.info().annotations.push({ type: "measure", description: `${width} x ${height}: canvas ${canvas.width.toFixed(0)} x ${canvas.height.toFixed(0)}; ${parts.map(([n, b]) => `${n} ${b.width.toFixed(0)} x ${b.height.toFixed(0)} at (${(b.x - canvas.x).toFixed(0)}, ${(b.y - canvas.y).toFixed(0)})`).join("; ")}` });
      for (const [what, box] of parts) expect.soft(inside(box, canvas), `${what} lies inside the canvas`).toBe(true);
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) expect.soft(overlap(parts[i][1], parts[j][1]), `${parts[i][0]} and ${parts[j][0]} do not overlap`).toBe(false);
      }
      expect.soft(await overflowOf(page), "no sideways overflow").toBeLessThanOrEqual(1);
      await shot(page, `placement-${width}`);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// find, at 6,000 points

/** Where the measurements go: one object, each case adds its keys (a case that fails half way still leaves what it had). */
const MEASURE = fileURLToPath(new URL("../../.superpowers/sdd/2026-10-15-w7u-discovery-premium/measure.json", import.meta.url));
function record(key: string, value: unknown): void {
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(readFileSync(MEASURE, "utf8")) as Record<string, unknown>;
  } catch {
    /* the first value */
  }
  all[key] = value;
  mkdirSync(dirname(MEASURE), { recursive: true });
  writeFileSync(MEASURE, `${JSON.stringify(all, null, 2)}\n`);
}
const measured = (what: string, value: unknown) => {
  test.info().annotations.push({ type: "measure", description: `${what}: ${JSON.stringify(value)}` });
};

interface KeyProbe { keys: number[]; muts: number[] }

test.describe("W7u: Find at 6,000 points", () => {
  test("the list is capped at 50 and says how many more, a keystroke reaches the results quickly, and a point in a group over the node budget shows the group and says why", async ({ page }) => {
    test.setTimeout(240_000);
    await arrive(page, bigModel(PERF_SHAPES), { fit: false });
    const sourceId = bigSourceId(1);
    const groupId = nid.cluster(sourceId, bigGroup(1, 1));
    // W12b: a group over 50 points shows a page of 50 and Show 50 more. Point 500 is reached by widening the page (500 + the group is within the 600-node budget); the last
    // point (1,000) is not, so it is the one that still gets the group instead.
    const pointId = nid.point(bigPointId(PERF_SHAPES, 1, 1, 1000));
    const midId = nid.point(bigPointId(PERF_SHAPES, 1, 1, 500));

    const spot = await emptySpot(page);
    await page.mouse.click(spot.x, spot.y);
    await page.keyboard.press("Control+K");
    const field = findField(page);
    await expect(field).toBeFocused();
    await page.evaluate(() => {
      const w = window as unknown as { __w7uKeys?: KeyProbe };
      const probe: KeyProbe = { keys: [], muts: [] };
      w.__w7uKeys = probe;
      document.addEventListener("keydown", () => probe.keys.push(performance.now()), true);
      const note = document.querySelector(".graph-find-note")!;
      new MutationObserver(() => probe.muts.push(performance.now())).observe(note, { childList: true, characterData: true, subtree: true });
    });
    await field.pressSequentially("pt-1-1", { delay: 250 });

    await test.step("fifty results and the number that were left out", async () => {
      await expect(findOptions(page)).toHaveCount(50);
      await expect(page.locator(".graph-find-note")).toHaveText(/^50 results, \d+ more not shown$/);
      const more = Number(/(\d+) more/.exec((await page.locator(".graph-find-note").textContent()) ?? "")?.[1] ?? "0");
      expect(more, "1,000 points match pt-1-1: 50 are listed").toBe(950);
    });

    await test.step("keystroke to results", async () => {
      const probe = await page.evaluate(() => (window as unknown as { __w7uKeys: KeyProbe }).__w7uKeys);
      const latencies: number[] = [];
      probe.keys.forEach((at, i) => {
        const next = probe.keys[i + 1] ?? Infinity;
        const result = probe.muts.find((m) => m >= at && m < next);
        if (result !== undefined) latencies.push(result - at);
      });
      const stats = { samples: latencies.length, medianMs: round(median(latencies)), worstMs: round(Math.max(0, ...latencies)) };
      record("findLatency", stats);
      measured("Find, keystroke to results at 6,000 points", stats);
      expect(stats.samples, "at least three keystrokes changed the list").toBeGreaterThanOrEqual(3);
      expect(stats.worstMs, "generous: the controller reads the number").toBeLessThan(1500);
    });

    await test.step("the last point of a group of 1,000 (too far down for the 600-node budget): the group is shown on its first page, and the person is told", async () => {
      await field.fill("pt-1-1-1000");
      await expect(findOptions(page)).toHaveCount(1);
      await page.keyboard.press("Enter");
      await expect(toast(page, /GRP-1-1 has 1,000 points; the one you chose is too far down to draw at once\. Showing the group: use Show 50 more to go on\./)).toBeVisible();
      await expect(nodeEl(page, groupId), "the group is drawn").toBeVisible();
      await expect(nodeEl(page, pointId), "the point itself is not").toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Show 50 more points of GRP-1-1,/ }), "the way to go on is there").toHaveCount(1);
      await expect.poll(() => focusedNodeId(page), { message: "the group takes the focus" }).toBe(groupId);
    });

    await test.step("point 500 of the same group: the page widens to reach it, and the point takes the focus", async () => {
      await expect(field, "the card has closed").toHaveCount(0);
      await cameraStill(page);
      await page.keyboard.press("Control+K");
      await expect(field).toBeFocused();
      await field.fill("pt-1-1-0500");
      await expect(findOptions(page)).toHaveCount(1);
      await page.keyboard.press("Enter");
      await expect(nodeEl(page, midId), "point 500 is drawn").toBeVisible();
      await expect.poll(() => focusedNodeId(page), { message: "the point takes the focus" }).toBe(midId);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// perf

interface FrameLog { at: number[]; gap: number[]; long: number[]; stop: boolean }
interface FrameStats { frames: number; medianMs: number; p95Ms: number; worstMs: number; over50: number; longTasks: number; longTaskMs: number }

const startFrames = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __w7uFrames?: FrameLog };
    const log: FrameLog = { at: [], gap: [], long: [], stop: false };
    w.__w7uFrames = log;
    let last = performance.now();
    const tick = (now: number) => {
      log.at.push(now);
      log.gap.push(now - last);
      last = now;
      if (!log.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) log.long.push(e.duration); }).observe({ entryTypes: ["longtask"] });
    } catch {
      /* a browser without long-task entries: the frame gaps still count */
    }
  });
const stopFrames = (page: Page) =>
  page.evaluate(() => {
    const log = (window as unknown as { __w7uFrames: FrameLog }).__w7uFrames;
    log.stop = true;
    return { at: log.at, gap: log.gap, long: log.long };
  });

function frameStats(gaps: number[], long: number[]): FrameStats {
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (q: number) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
  return {
    frames: gaps.length, medianMs: round(at(0.5)), p95Ms: round(at(0.95)), worstMs: round(sorted[sorted.length - 1] ?? 0),
    over50: gaps.filter((g) => g > 50).length, longTasks: long.length, longTaskMs: round(long.reduce((sum, d) => sum + d, 0)),
  };
}

/**
 * W12b: Expand all opens what the 600-node budget allows and stops, so a graph larger than that opens with several presses. Press until the button waits (it is
 * `aria-disabled` once everything is open; Playwright would wait for an enabled button, so the state is read first), and after each press wait for the nodes it drew.
 */
async function expandEverything(page: Page): Promise<void> {
  const expand = barButton(page, "Expand all");
  for (let press = 1; press <= 12; press++) {
    if ((await expand.getAttribute("aria-disabled")) === "true") return;
    const before = await page.locator(".react-flow__node").count();
    await expand.click();
    await expect.poll(() => page.locator(".react-flow__node").count(), { timeout: 60_000, message: `Expand all, press ${press}, drew more nodes` }).toBeGreaterThan(before);
  }
  throw new Error("Expand all was still ready after 12 presses");
}

/**
 * About 2,000 nodes: DRAG_SHAPES (ten sources of four groups of 49 points, so no group is paged) opened with repeated Expand all presses (each opens at most 600 new
 * nodes). Returns the node count. The camera is then fitted and zoomed in to a readable size.
 */
async function openBig(page: Page): Promise<number> {
  await arrive(page, bigModel(DRAG_SHAPES), { fit: false });
  await expandEverything(page);
  await expect.poll(() => page.locator(".react-flow__node").count(), { timeout: 120_000, message: "about 2,000 nodes are drawn" }).toBeGreaterThanOrEqual(2000);
  const count = await page.locator(".react-flow__node").count();
  await fitViewNow(page);
  for (let i = 0; i < 12 && (await zoomOf(page)) < 0.55; i++) {
    await page.getByRole("button", { name: "zoom in" }).click();
    await cameraStill(page);
  }
  return count;
}

/** The point node nearest to the middle of the canvas that no tool, control or minimap covers. */
async function visiblePoint(page: Page): Promise<{ id: string; box: Box }> {
  const found = await page.evaluate(() => {
    const pane = document.querySelector(".react-flow__pane")!.getBoundingClientRect();
    const middle = { x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 };
    let best: { id: string; box: { x: number; y: number; width: number; height: number }; d: number } | null = null;
    for (const el of Array.from(document.querySelectorAll('.react-flow__node[data-id^="point:"]'))) {
      const r = el.getBoundingClientRect();
      if (r.left < pane.left + 160 || r.right > pane.right - 220 || r.top < pane.top + 110 || r.bottom > pane.bottom - 150) continue;
      const d = Math.hypot(r.left + r.width / 2 - middle.x, r.top + r.height / 2 - middle.y);
      if (!best || d < best.d) best = { id: el.getAttribute("data-id") ?? "", box: { x: r.left, y: r.top, width: r.width, height: r.height }, d };
    }
    return best;
  });
  if (!found) throw new Error("no point node lies in the middle of the canvas");
  return { id: found.id, box: found.box };
}

/**
 * A drag of `seconds`: the pointer takes a node by its top-left corner and swings up and down 100 px along the column, so the node keeps the x of its neighbours
 * (with snap on, that is the case for the guides); `dx` puts it off the column. The frames are timed inside the page. The number of guide lines is read once a second.
 */
async function measureDrag(page: Page, dx: number, seconds: number): Promise<{ id: string; stats: FrameStats; guideLines: number }> {
  const { id, box } = await visiblePoint(page);
  const grab = { x: box.x + 8, y: box.y + 4 };
  let guideLines = 0;
  await startFrames(page);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + dx + 3, grab.y + 3, { steps: 3 }); // past the drag threshold
  const t0 = Date.now();
  let probed = 0;
  while (Date.now() - t0 < seconds * 1000) {
    const t = (Date.now() - t0) / 1000;
    await page.mouse.move(grab.x + dx, grab.y + Math.sin(t * Math.PI * 1.6) * 100);
    if (t >= probed + 1) {
      probed = Math.floor(t);
      guideLines = Math.max(guideLines, await page.locator(".graph-guides line").count());
    }
  }
  await page.mouse.move(grab.x + dx, grab.y, { steps: 3 });
  await page.mouse.up();
  const frames = await stopFrames(page);
  return { id, stats: frameStats(frames.gap.slice(1), frames.long), guideLines };
}

/**
 * Gallery runs only: a point is taken and held mid-drag (the mouse stays down) until a guide line shows, then the screenshot is taken, so the picture proves
 * the guides really draw (the measurements below only count their lines). The mouse is released afterwards.
 */
async function guidesShot(page: Page): Promise<void> {
  const { box } = await visiblePoint(page);
  const grab = { x: box.x + 8, y: box.y + 4 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  try {
    await page.mouse.move(grab.x + 3, grab.y + 3, { steps: 3 }); // past the drag threshold
    await page.mouse.move(grab.x, grab.y + 40, { steps: 4 }); // along the column, so the node lines up with its neighbours
    await expect.poll(() => page.locator(".graph-guides line").count(), { message: "a guide line shows while the node is held" }).toBeGreaterThan(0);
    await shot(page, "guides-1440");
  } finally {
    await page.mouse.up();
  }
}

test.describe("W7u: measurements (about 2,000 nodes)", () => {
  test("a 3 s drag: the frames with the guides on (as shipped), without the minimap, and with snap off", async ({ page }) => {
    test.setTimeout(300_000);
    const nodes = await openBig(page);
    record("nodes", nodes);
    measured("nodes drawn", nodes);
    expect(await page.locator(".graph-minimap, .react-flow__minimap").count(), "the minimap is drawn at this size").toBeGreaterThan(0);

    await measureDrag(page, 0, 1); // a warm-up that is thrown away: the first drag pays for the JIT and for the first render of every node
    const shipped = await measureDrag(page, 0, 3);
    record("drag.guidesOn", { ...shipped.stats, guideLines: shipped.guideLines });
    measured("drag, guides on (snap on, minimap on)", { ...shipped.stats, guideLines: shipped.guideLines });
    expect(shipped.stats.frames, "the frame sampler ran").toBeGreaterThan(10);
    expect(shipped.guideLines, "the guides were drawn during the drag").toBeGreaterThan(0);
    expect(shipped.stats.worstMs, "generous: the controller reads the numbers").toBeLessThan(3000);
    if (process.env.W7U_GALLERY === "1") await guidesShot(page); // after the measured drag: a screenshot costs a long frame

    const hideMap = await page.addStyleTag({ content: ".react-flow__minimap { display: none !important; }" });
    const noMap = await measureDrag(page, 0, 3);
    record("drag.noMinimap", { ...noMap.stats, guideLines: noMap.guideLines });
    measured("drag, minimap hidden (the difference is the minimap's redraw)", { ...noMap.stats, guideLines: noMap.guideLines });
    await hideMap.evaluate((el) => (el as Element).remove());

    const again = await measureDrag(page, 0, 3); // the first variant once more: how far two identical runs differ on this machine
    record("drag.guidesOnAgain", { ...again.stats, guideLines: again.guideLines });
    measured("drag, guides on again (the noise between two identical runs)", { ...again.stats, guideLines: again.guideLines });

    await snapButton(page).click();
    await expect(snapButton(page)).toHaveAttribute("aria-pressed", "false");
    const free = await measureDrag(page, 5, 3);
    record("drag.snapOff", { ...free.stats, guideLines: free.guideLines });
    measured("drag, snap off and 5 px off the column (guides have almost nothing to match)", { ...free.stats, guideLines: free.guideLines });
    expect(free.stats.frames).toBeGreaterThan(10);
  });

  test("hovering a point: the time to the lit path and to the next painted frame, and the worst frame while the other nodes fade", async ({ page }) => {
    test.setTimeout(300_000);
    await openBig(page);
    const away = await emptySpot(page);
    await page.mouse.move(away.x, away.y);
    await expect(canvasEl(page)).not.toHaveClass(/has-focus/);
    const { id, box } = await visiblePoint(page);

    await page.evaluate(() => {
      const w = window as unknown as { __w7uHover?: { enter: number; cls: number; paint: number } };
      const probe = { enter: 0, cls: 0, paint: 0 };
      w.__w7uHover = probe;
      document.addEventListener("mouseover", (e) => { if (!probe.enter && (e.target as Element | null)?.closest?.(".react-flow__node")) probe.enter = performance.now(); }, true);
      const canvas = document.querySelector(".graph-canvas")!;
      new MutationObserver(() => {
        if (probe.cls || !canvas.classList.contains("has-focus")) return;
        probe.cls = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => { probe.paint = performance.now(); }));
      }).observe(canvas, { attributes: true, attributeFilter: ["class"] });
    });
    await startFrames(page);
    await page.mouse.move(box.x + 8, box.y + 4);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __w7uHover: { paint: number } }).__w7uHover.paint), { timeout: 20_000, message: "the path was lit and painted" }).toBeGreaterThan(0);
    await page.waitForTimeout(400); // the class change and the frames after it (the dimming has no transition any more)
    const frames = await stopFrames(page);
    const probe = await page.evaluate(() => (window as unknown as { __w7uHover: { enter: number; cls: number; paint: number } }).__w7uHover);

    expect(await litNodeIds(page).then((ids) => ids.length), "the point, its group and its source are lit: three nodes").toBe(3);
    expect(await litNodeIds(page)).toContain(id);
    const window_ = frames.at.map((at, i) => ({ at, gap: frames.gap[i] })).filter((f) => f.at >= probe.enter && f.at <= probe.paint + 300);
    const stats = {
      mouseenterToClassMs: round(probe.cls - probe.enter), classToNextPaintMs: round(probe.paint - probe.cls),
      framesInWindow: window_.length, worstFrameInWindowMs: round(Math.max(0, ...window_.map((f) => f.gap))),
    };
    record("hover", stats);
    measured("hover on a point at about 2,000 nodes (the dwell is 120 ms by design)", stats);
    expect(stats.mouseenterToClassMs, "the 120 ms dwell, then the render").toBeGreaterThanOrEqual(100);
    expect(stats.mouseenterToClassMs, "generous: the controller reads the number").toBeLessThan(5000);
  });

  test("idle: 100 flowing edges cost the main thread how much more than the same graph without motion", async ({ page }) => {
    test.setTimeout(300_000);
    /** The main thread's busy share over `seconds` of doing nothing, from the browser's own task time, and the frames and long tasks in the same time. */
    const idle = async (seconds: number) => {
      const away = await emptySpot(page);
      await page.mouse.move(away.x, away.y);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Performance.enable");
      const metric = async (name: string) => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === name)?.value ?? 0;
      await startFrames(page);
      const [task0, script0, time0] = [await metric("TaskDuration"), await metric("ScriptDuration"), await metric("Timestamp")];
      await page.waitForTimeout(seconds * 1000);
      const [task1, script1, time1] = [await metric("TaskDuration"), await metric("ScriptDuration"), await metric("Timestamp")];
      const frames = await stopFrames(page);
      await cdp.detach();
      const wall = Math.max(0.001, time1 - time0);
      return { busyShare: round((task1 - task0) / wall, 3), scriptShare: round((script1 - script0) / wall, 3), ...frameStats(frames.gap.slice(1), frames.long) };
    };
    const open = async () => {
      await barButton(page, "Expand all").click();
      await expect(page.locator(".react-flow__node")).toHaveCount(301); // the source, 100 groups, 200 points
      await fitViewNow(page);
    };

    await arrive(page, bigModel(LIVE_SHAPES, 0), { fit: false });
    await open();
    await expect(page.locator(".react-flow__edge.animated"), "100 source to group edges flow (the group to point ones never do): exactly the page's limit").toHaveCount(100);
    const live = await idle(5);
    record("idle.live100", live);
    measured("5 s idle, 100 flowing edges", live);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
    await cameraStill(page);
    await open();
    await expect(page.locator(".react-flow__edge.animated"), "reduced motion: nothing flows").toHaveCount(0);
    const still = await idle(5);
    record("idle.still", still);
    measured("5 s idle, the same graph without motion", still);
    record("idle.difference", { busyShare: round(live.busyShare - still.busyShare, 3), over50: live.over50 - still.over50 });

    expect(live.busyShare, "the page does not spin the main thread").toBeLessThan(0.9);
    expect(live.frames, "the sampler ran").toBeGreaterThan(10);
  });
});
