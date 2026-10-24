import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  FAMILY, FAMILY_NAMES, familyGroup, familyModel, familyPdu, familyPduName, familyRack, latestBody, node as nid, summaryId, UNGROUPED,
  type ApiGraphModel, type XY,
} from "./graphModel";

// W37 (Discovery with hundreds of mapped assets: a parent with more than 50 sub-assets is drawn as ONE summary node that shows them 50 at a time). Admin `admin` / `correct-horse`, the account the earlier
// projects use.
//
// THIS SPEC WRITES NOTHING TO THE STACK, like w7u and w12b. Every case answers GET /api/discovery/graph from `familyModel()` (e2e/graphModel.ts, the owner's shape, synthetic ids from 9,000,000 up), the layout's PUT
// and DELETE and GET /api/mappings/{id}/latest through `page.route`, so the stack's own sources and assets do not matter. Any OTHER write the app tries (the sign-in aside) is refused with a 500 and written down, and
// afterEach fails the case that made one. Each case runs in a fresh browser context, so the browser-side settings (the folded assets, the sidebar) start from nothing.
//
// The shape: one root `MV2`; under it `Room 1`, `Room 2` and `Room 3`; five racks under each of the first two; 400 PDUs under `Room 3` (`PDUA001` ... `PDUA200`, `PDUB001` ... `PDUB200`, in the server's order: the 377th is
// `PDUB177`). Two sources: `W37 Small` (the 60-point simulator: ten groups of six points, `MTR01` to `MTR09` mapped onto racks 1 to 9, `MTR10` not mapped) and `W37 Large` (the graph says `large` and sends only
// its 400 mapped points, in the Ungrouped bag, one energy counter on each PDU).
//
// The cases (each its own test, 1440 x 900 unless said; one failing does not stop the next):
//   1  AT REST       exactly one summary node, `400 sub-assets`, `400 mapped`, the button `Show 50`; at most 25 nodes; no PDU drawn; one mapped edge into the summary, labelled `400 mapped`.
//   2  SHOW 50       twice: 100 PDUs, the summary says `300 more sub-assets`; after each press the focus is on the first child that press drew (child 51 after the second); ArrowDown from the last child
//                    reaches the summary's button and ArrowLeft goes to `Room 3`.
//   3  FIND          `PDUB177` (Ctrl+K, type, choose the asset): the page extends to 400, the summary is gone, the node is flashed and holds the focus.
//   4  DROPS         with Show 50 done, `MTR10` dropped on a drawn PDU opens the Review (the asset is a PDU; Cancel closes it, the focus is on a node, nothing is saved); the PDU's right-click menu has its
//                    items; after a fold and an unfold, `MTR10` dropped on the summary is a plain move (no Review; the offer bar; the move is saved, the summary never is).
//   5  FOLD          `Room 3` folded after a Show 50: no summary, no PDU, the badge `400 mapped`, 16 nodes; unfolded: the summary is back with nothing shown.
//   6  FRAMES        a 3 s pan on an empty spot at rest, and in the stress view (the large source open, its 400 points and then all 400 PDUs shown: more than 800 nodes). The numbers go to the case's `measure`
//                    annotations and to the console; the limits are generous on purpose, the controller reads the numbers.
//   7  LOOK          1024 x 768, sidebar minimised and expanded: the summary is drawn, its button lies inside the canvas and nothing lies over it, and the page does not scroll sideways.
//
// Locators. Playwright matches a name by case-insensitive SUBSTRING: the summary's button is found by the words `sub-assets under` (its name is `Show 50 of the sub-assets under Room 3, 400 left`; the group's own button says
// `Show 50 more points of ...`, and the "+" of an asset says `Add a sub-asset under ...`), every other lookup of a button is `exact: true`. The summary's own words are read from its classes (`gma-title`, `gma-mapped`,
// `gma-button`), the visible text of the button (`Show 50`) being different from its accessible name.

const ADMIN = { username: "admin", password: "correct-horse" };

/** lib/graph.ts: a parent with more sub-assets than this is summarised, and the summary's button draws this many more. */
const ASSET_PAGE = 50;
const ROOM3 = nid.asset(FAMILY.room3);
const SUMMARY = summaryId(FAMILY.room3);
const SMALL_SRC = nid.source(FAMILY.small);
const LARGE_SRC = nid.source(FAMILY.large);
const UNGROUPED_GROUP = nid.cluster(FAMILY.large, UNGROUPED);
const MTR10 = nid.cluster(FAMILY.small, familyGroup(10));
/** The generous limits of the frame case (w7u: worst under 3 s); p95 is the number the controller compares with R11. */
const LIMIT = { worstMs: 3000, p95Ms: 200 } as const;

const pduId = (n: number) => nid.asset(familyPdu(n));

interface Box { x: number; y: number; width: number; height: number }

// ---------------------------------------------------------------------------------------------------------------------------------
// The stub: the generated graph, and the refusal of every other write

interface Stub {
  /** The places the layout holds now (the model's, then what the page PUT; DELETE empties it). */
  layout: Record<string, XY>;
  /** The nodes of each layout PUT, in order. */
  puts: { node_id: string; x: number; y: number }[][];
  /** How many times the page read the graph: 0 would mean the generated graph never reached it. */
  reads: number;
  /** Writes the stub does not know. The page gets a 500 and afterEach fails the case. */
  stray: string[];
}
let current: Stub | null = null;

test.afterEach(() => {
  const stub = current;
  current = null;
  expect(stub?.stray ?? [], "the spec writes nothing to the stack: these requests were refused").toEqual([]);
});

async function stubGraph(page: Page, model: ApiGraphModel): Promise<Stub> {
  const stub: Stub = { layout: { ...model.layout }, puts: [], reads: 0, stray: [] };
  // Registered FIRST, so it is asked last: a request that is not a read and not the sign-in is refused and written down.
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    if (method === "GET" || method === "HEAD" || path === "/api/login") return route.continue();
    stub.stray.push(`${method} ${path}`);
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "w37: this spec writes nothing" }) });
  });
  await page.route(/\/api\/discovery\/graph(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    stub.reads++;
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
      stub.layout = {};
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
  // A mapped point that rests under the pointer asks for its last value; the mappings of a generated graph are not on the stack (a real answer would be a 404 and a console error).
  await page.route(/\/api\/mappings\/\d+\/latest(\?.*)?$/, async (route) => {
    const id = Number(/\/mappings\/(\d+)\/latest/.exec(route.request().url())![1]);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(latestBody(id)) });
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

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const nodeSel = (id: string) => `.react-flow__node[data-id="${id}"]`;
const nodeEl = (page: Page, id: string) => page.locator(nodeSel(id));
const titleOf = (page: Page, id: string) => nodeEl(page, id).locator(".node-title");
const findField = (page: Page) => page.getByRole("combobox", { name: "Search the graph", exact: true });
const findOptions = (page: Page) => page.locator(".graph-find").getByRole("option");
const menuEl = (page: Page) => page.locator('.graph-menu[role="menu"]');
const reviewDialog = (page: Page) => page.getByRole("dialog", { name: "Review mappings", exact: true });
const clusters = (page: Page) => page.locator('.react-flow__node[data-id^="cluster:"]');
const pointNodes = (page: Page) => page.locator('.react-flow__node[data-id^="point:"]');
const assetNodes = (page: Page) => page.locator('.react-flow__node[data-id^="asset:"]');
/** The summary nodes of assets (the group's own "Show 50 more" node is `more:cluster:...`). */
const summaries = (page: Page) => page.locator('.react-flow__node[data-id^="more:asset:"]');
/** The PDU nodes drawn (the assets whose title is a PDU name; MV2, the rooms and the racks are not). */
const pduNodes = (page: Page) => assetNodes(page).filter({ has: page.locator(".node-title", { hasText: /^PDU[AB]\d{3}$/ }) });
const summaryEl = (page: Page) => nodeEl(page, SUMMARY);
const summaryButton = (page: Page) => summaryEl(page).getByRole("button", { name: /sub-assets under/ });
const edgeSel = (id: string) => `.react-flow__edge[data-id="${id}"]`;
const edgeEl = (page: Page, id: string) => page.locator(edgeSel(id));
/** The count label of an edge (`400 mapped`): a <text> inside the edge's group. */
const edgeLabel = (page: Page, id: string) => page.locator(`${edgeSel(id)} .react-flow__edge-text`);
/** What the summary says about itself: the title and the muted line, and the button (its visible words; its accessible name is longer). */
const summaryTitle = (page: Page) => summaryEl(page).locator(".gma-title");
const summaryMapped = (page: Page) => summaryEl(page).locator(".gma-mapped");
const summaryWords = (page: Page) => summaryEl(page).locator(".gma-button");

const measured = (what: string, value: unknown) => {
  test.info().annotations.push({ type: "measure", description: `${what}: ${JSON.stringify(value)}` });
  console.log(`w37 ${what}: ${JSON.stringify(value)}`);
};

async function boxOf(target: Locator, what: string): Promise<Box> {
  const box = await target.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  return box!;
}
const centreOf = (box: Box): XY => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const inside = (box: Box, frame: Box) => box.x >= frame.x - 1 && box.y >= frame.y - 1 && box.x + box.width <= frame.x + frame.width + 1 && box.y + box.height <= frame.y + frame.height + 1;
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** The element at the middle of `target` is `target` itself or something inside it: nothing (the minimap, a tool) lies over it. */
const reachable = (target: Locator) =>
  target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!hit && el.contains(hit);
  });
/** A node's place in FLOW coordinates, from the transform of its wrapper: the zoom and the pan do not enter. */
const flowPos = (target: Locator): Promise<XY> =>
  target.evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return { x: m.m41, y: m.m42 };
  });
const focusedNodeId = (page: Page) => page.evaluate(() => document.activeElement?.closest(".react-flow__node")?.getAttribute("data-id") ?? null);
/** Puts the focus on an element without scrolling anything (the canvas is overflow hidden: a plain focus() on a node far off screen would scroll the canvas itself). */
const focusQuietly = (target: Locator) => target.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
const focusOf = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return {
      body: !el || el === document.body || el === document.documentElement,
      nodeId: el?.closest(".react-flow__node")?.getAttribute("data-id") ?? null,
      canvas: !!el?.classList.contains("graph-canvas"),
      tag: el?.tagName ?? "",
      label: el?.getAttribute("aria-label") ?? "",
    };
  });
/** The focus stands on a node or on the canvas, which are named; polled, since the page moves it after a dialog or a fold has finished. */
async function expectFocusNamed(page: Page, message: string): Promise<void> {
  await expect
    .poll(async () => {
      const focus = await focusOf(page);
      return !focus.body && (focus.nodeId !== null || focus.canvas);
    }, { message: `${message}: the focus is on a node or on the canvas, not on <body>` })
    .toBe(true);
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

interface Opening { width?: number; height?: number; fit?: boolean }
/** Signs in, installs the stub for `model` and sets the window; the page is not opened yet. */
async function prepare(page: Page, model: ApiGraphModel, { width = 1440, height = 900 }: Opening = {}): Promise<Stub> {
  await signIn(page);
  const stub = await stubGraph(page, model);
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
async function arrive(page: Page, model: ApiGraphModel, opening: Opening = {}): Promise<Stub> {
  const stub = await prepare(page, model, opening);
  await visit(page, stub);
  if (opening.fit !== false) await fitViewNow(page);
  return stub;
}

type Sidebar = "expanded" | "minimized";
async function sidebar(page: Page, want: Sidebar): Promise<void> {
  const shell = page.locator(".shell");
  if ((await shell.getAttribute("data-sidebar")) !== want) await page.locator(".side-toggle").click();
  await expect(shell).toHaveAttribute("data-sidebar", want);
  await cameraStill(page);
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
/** Drags the middle of `handle` onto the middle of `target`; both must lie inside the canvas (a drag cannot carry a node off screen). */
async function dragOnto(page: Page, handle: Locator, target: Locator): Promise<void> {
  await cameraStill(page);
  const pane = await boxOf(page.locator(".react-flow__pane"), "the pane");
  const [from, to] = [await boxOf(handle, "the drag handle"), await boxOf(target, "the drop target")];
  expect(inside(from, pane), "the drag handle lies inside the canvas").toBe(true);
  expect(inside(to, pane), "the drop target lies inside the canvas").toBe(true);
  await dragPath(page, centreOf(from), centreOf(to));
}

/** A real pointer press when the button is on screen and nothing lies over it; else the click event itself (a node far down a long list lies outside the canvas, and Playwright cannot scroll a canvas). */
async function pressWithMouse(page: Page, button: Locator): Promise<void> {
  const box = await button.boundingBox();
  const pane = await boxOf(page.locator(".react-flow__pane"), "the pane");
  // One press only: a real click that threw after it had acted, followed by the click event, would toggle a source open and shut again.
  const free = box && inside(box, pane) && (await button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top !== null && el.contains(top);
  }));
  if (free) await button.click({ timeout: 10_000 });
  else await button.dispatchEvent("click"); // something lies over it (a tool, the minimap) or it is outside the canvas
}

/** Pans the camera by `by` screen pixels, the way a person does: the empty canvas is taken and dragged. */
async function panBy(page: Page, by: XY): Promise<void> {
  const spot = await emptySpot(page);
  await dragPath(page, spot, { x: spot.x + by.x, y: spot.y + by.y });
  await cameraStill(page);
}

/** The first of the PDUs from number `from` whose node lies whole inside the canvas with its title in reach of the pointer (the minimap lies over the bottom right of the canvas). */
async function pduInView(page: Page, from = 2): Promise<number> {
  const pane = await boxOf(page.locator(".react-flow__pane"), "the pane");
  for (let n = from; n <= ASSET_PAGE; n++) {
    const title = titleOf(page, pduId(n));
    const box = await title.boundingBox();
    if (box && inside(box, pane) && (await reachable(title))) return n;
  }
  throw new Error(`none of the PDUs ${from} to ${ASSET_PAGE} lies inside the canvas with its title in reach`);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The frames of a pan (the sampler of w7u.spec.ts)

interface FrameLog { at: number[]; gap: number[]; long: number[]; stop: boolean }
interface FrameStats { frames: number; medianMs: number; p95Ms: number; worstMs: number; over50: number; longTasks: number; longTaskMs: number }

const startFrames = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __w37Frames?: FrameLog };
    const log: FrameLog = { at: [], gap: [], long: [], stop: false };
    w.__w37Frames = log;
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
    const log = (window as unknown as { __w37Frames: FrameLog }).__w37Frames;
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

/** A pan of `seconds`: the pointer takes the empty canvas and swings it about 120 px sideways and 60 px up and down; the frames are timed inside the page. */
async function panFor(page: Page, seconds: number): Promise<FrameStats> {
  const spot = await emptySpot(page);
  await page.mouse.move(spot.x, spot.y);
  await startFrames(page);
  await page.mouse.down();
  await page.mouse.move(spot.x + 6, spot.y + 6, { steps: 3 }); // past the drag threshold
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    const t = (Date.now() - t0) / 1000;
    await page.mouse.move(spot.x + Math.sin(t * Math.PI * 1.2) * 120, spot.y + Math.sin(t * Math.PI * 0.8) * 60);
  }
  await page.mouse.up();
  const frames = await stopFrames(page);
  return frameStats(frames.gap.slice(1), frames.long);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The cases

test.describe("W37: a parent with hundreds of sub-assets", () => {
  test("1 at rest: ONE summary node under Room 3 says 400 sub-assets, 400 mapped and Show 50; at most 25 nodes; no PDU; one mapped edge into it", async ({ page }) => {
    test.setTimeout(120_000);
    await arrive(page, familyModel());

    await test.step("the summary and its three lines", async () => {
      await expect(summaries(page), "exactly one summary").toHaveCount(1);
      await expect(summaryEl(page)).toBeVisible();
      await expect(summaryTitle(page)).toHaveText("400 sub-assets");
      await expect(summaryMapped(page)).toHaveText("400 mapped");
      await expect(summaryWords(page)).toHaveText("Show 50");
      await expect(summaryButton(page), "named for the parent and for what is left").toHaveAttribute("aria-label", "Show 50 of the sub-assets under Room 3, 400 left");
    });

    await test.step("a graph of next to nothing: at most 25 nodes, and no PDU", async () => {
      const count = await page.locator(".react-flow__node").count();
      measured("nodes drawn at rest", count);
      expect(count, "2 sources, MV2, 3 rooms, 10 racks and the summary make 17").toBeLessThanOrEqual(25);
      await expect(pduNodes(page), "no PDU is drawn").toHaveCount(0);
      await expect(assetNodes(page), "MV2, the three rooms and the ten racks").toHaveCount(14);
      await expect(nodeEl(page, ROOM3)).toBeVisible();
    });

    await test.step("the edges: the hierarchy edge to the summary, and ONE mapped edge into it whose label is `400 mapped`", async () => {
      await expect(edgeEl(page, `a:${FAMILY.room3}>${SUMMARY}`), "Room 3 to its summary").toHaveCount(1);
      const mappedIn = page.locator(`.react-flow__edge[data-id^="m:"][data-id$=">${SUMMARY}"]`);
      await expect(mappedIn, "one mapped edge ends on the summary").toHaveCount(1);
      await expect(mappedIn.locator(".react-flow__edge-text")).toHaveText("400 mapped");
      await expect(edgeEl(page, `m:${LARGE_SRC}>${SUMMARY}`), "and it comes from the large source").toHaveCount(1);
      await expect(page.locator(`.react-flow__edge[data-id$=">${SUMMARY}"]`), "two edges in all end on the summary").toHaveCount(2);
      // The small source is mapped onto nine racks: nine edges of `6 mapped`, drawn as before.
      for (let rack = 1; rack <= 9; rack++) await expect(edgeLabel(page, `m:${SMALL_SRC}>${nid.asset(familyRack(rack))}`), `rack ${rack}`).toHaveText("6 mapped");
    });
  });

  test("2 Show 50 twice draws 100 PDUs, the focus follows the first new one, ArrowDown from the last reaches the summary and ArrowLeft goes to Room 3", async ({ page }) => {
    test.setTimeout(180_000);
    await arrive(page, familyModel());
    await expect(summaryWords(page)).toHaveText("Show 50");

    await test.step("the first press: 50 PDUs, the focus on the first of them, the summary says what is left", async () => {
      await pressWithMouse(page, summaryButton(page));
      await expect(pduNodes(page)).toHaveCount(ASSET_PAGE);
      await expect.poll(() => focusedNodeId(page), { message: "the focus is on the first PDU just drawn", timeout: 15_000 }).toBe(pduId(1));
      await expect(summaryTitle(page)).toHaveText("350 more sub-assets");
      await expect(summaryMapped(page)).toHaveText("350 mapped");
      await expect(summaryWords(page)).toHaveText("Show 50 more");
      await expect(summaryButton(page)).toHaveAttribute("aria-label", "Show 50 more of the sub-assets under Room 3, 350 left");
    });

    await test.step("the second press: 100 PDUs, the focus on child 51", async () => {
      await cameraStill(page);
      await pressWithMouse(page, summaryButton(page));
      await expect(pduNodes(page)).toHaveCount(2 * ASSET_PAGE);
      await expect.poll(() => focusedNodeId(page), { message: "the focus is on child 51, the first of the second page", timeout: 15_000 }).toBe(pduId(51));
      await expect(summaryTitle(page)).toHaveText("300 more sub-assets");
      await expect(summaryMapped(page)).toHaveText("300 mapped");
      await expect(summaryButton(page)).toHaveAttribute("aria-label", "Show 50 more of the sub-assets under Room 3, 300 left");
      await expect(summaries(page), "one summary still").toHaveCount(1);
    });

    await test.step("ArrowDown from the last drawn child puts the focus on the summary's button; ArrowLeft goes to Room 3", async () => {
      await focusQuietly(nodeEl(page, pduId(2 * ASSET_PAGE)));
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => focusedNodeId(page), { message: "ArrowDown from child 100 reaches the summary", timeout: 15_000 }).toBe(SUMMARY);
      const focus = await focusOf(page);
      expect(focus.tag, "it is the button inside the node that holds the focus").toBe("BUTTON");
      expect(focus.label).toBe("Show 50 more of the sub-assets under Room 3, 300 left");
      await page.keyboard.press("ArrowLeft");
      await expect.poll(() => focusedNodeId(page), { message: "ArrowLeft from the summary goes to Room 3", timeout: 15_000 }).toBe(ROOM3);
    });
  });

  test("3 Find PDUB177 extends the page to 400: every PDU is drawn, the summary is gone, the node is flashed and holds the focus", async ({ page }) => {
    test.setTimeout(180_000);
    await arrive(page, familyModel());
    const target = pduId(377);
    expect(familyPduName(377), "the 377th child of Room 3 is PDUB177").toBe("PDUB177");
    await expect(nodeEl(page, target), "it is not drawn: it is behind the summary").toHaveCount(0);

    const spot = await emptySpot(page);
    await page.mouse.click(spot.x, spot.y);
    await page.keyboard.press("Control+K");
    const field = findField(page);
    await expect(field, "Find opens").toBeFocused();
    await field.pressSequentially("PDUB177");
    // The point `PDUB177_PM0_PENRG` of the large source matches too, and the card adds the search of the large source's tags: the option is the ASSET, whose label is exactly the name.
    const option = findOptions(page).filter({ has: page.locator(".graph-find-label", { hasText: /^PDUB177$/ }) });
    await expect(option, "one asset named PDUB177").toHaveCount(1);
    await option.click();

    // The flash lasts 1.5 s from the end of the glide: it is looked for before anything else is counted.
    await expect(nodeEl(page, target), "the found node pulses").toHaveClass(/flash/, { timeout: 30_000 });
    await expect.poll(() => focusedNodeId(page), { message: "and holds the focus", timeout: 15_000 }).toBe(target);
    await expect(pduNodes(page), "the page grew to the next multiple of 50 that holds the 377th: 400").toHaveCount(400);
    await expect(summaries(page), "nothing is left to show: the summary is gone").toHaveCount(0);
    await expect(nodeEl(page, target)).toBeVisible();
  });

  test("4 a group dropped on a drawn PDU opens the Review, a PDU has its menu, and a drop on the summary is a plain move", async ({ page }) => {
    test.setTimeout(240_000);
    const stub = await arrive(page, familyModel());
    const group = nodeEl(page, MTR10);

    await test.step("open the small source and Show 50: the group MTR10 (nothing mapped) and 50 PDUs are on the canvas", async () => {
      await nodeEl(page, SMALL_SRC).getByRole("button", { name: `Expand ${FAMILY_NAMES.small}`, exact: true }).click();
      await expect(clusters(page)).toHaveCount(10);
      await cameraStill(page);
      await fitViewNow(page);
      await pressWithMouse(page, summaryButton(page));
      await expect(pduNodes(page)).toHaveCount(ASSET_PAGE);
      await cameraStill(page);
      await expect(group).toBeVisible();
      // The PDUs stand in the bottom right of the canvas, where the minimap lies: the canvas is taken and moved up, as a person does, until the first of them are clear of it. The group stays in view.
      await panBy(page, { x: 0, y: -250 });
    });

    const before = await flowPos(group);
    const menuPdu = await pduInView(page, 4);

    await test.step("MTR10 dropped on a drawn PDU opens the Review for a PDU; Cancel closes it and the focus is on a node", async () => {
      const n = await pduInView(page, 2);
      await dragOnto(page, titleOf(page, MTR10), nodeEl(page, pduId(n)));
      const dialog = reviewDialog(page);
      await expect(dialog, "the drop is a request to map").toBeVisible();
      const chosen = Number(await dialog.getByRole("combobox", { name: "Asset", exact: true }).inputValue());
      measured("the drop was aimed at PDU / the Review chose asset", { aimed: familyPduName(n), chose: chosen, firstPdu: familyPdu(1), lastPdu: familyPdu(ASSET_PAGE) });
      expect(chosen >= familyPdu(1) && chosen <= familyPdu(ASSET_PAGE), "the asset the Review maps to is one of the PDUs drawn, not a room").toBe(true);
      await expect.poll(async () => (await flowPos(group)).x, { message: "the group is back where it started" }).toBeCloseTo(before.x, 0);
      expect((await flowPos(group)).y).toBeCloseTo(before.y, 0);
      expect(stub.puts, "a drop that maps is not a move: nothing is saved").toHaveLength(0);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expectFocusNamed(page, "after Cancel");
    });

    await test.step("a right-click on a drawn PDU opens its menu: New sub-asset and Unmap everything from the large source; Escape gives the focus back", async () => {
      const menu = menuEl(page);
      const at = centreOf(await boxOf(titleOf(page, pduId(menuPdu)), `the title of ${familyPduName(menuPdu)}`));
      await page.mouse.click(at.x, at.y, { button: "right" });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "New sub-asset…", exact: true })).toHaveCount(1);
      await expect(menu.getByRole("menuitem", { name: `Unmap everything from ${FAMILY_NAMES.large}…`, exact: true }), "the PDU has an energy counter of the large source").toHaveCount(1);
      await expect(menu.getByRole("menuitem", { name: "Expand all", exact: true }), "it is the PDU's menu, not the canvas menu").toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect.poll(() => focusedNodeId(page), { message: "the focus is back on the PDU" }).toBe(pduId(menuPdu));
    });

    await test.step("Room 3 folded and unfolded brings the summary back to the top of its column; MTR10 dropped on it is a plain move", async () => {
      await pressWithMouse(page, nodeEl(page, ROOM3).getByRole("button", { name: "Hide sub-assets of Room 3", exact: true }));
      await expect(summaries(page)).toHaveCount(0);
      await pressWithMouse(page, nodeEl(page, ROOM3).getByRole("button", { name: "Show sub-assets of Room 3", exact: true }));
      await expect(summaryTitle(page)).toHaveText("400 sub-assets");
      await expect(pduNodes(page), "the pages were forgotten").toHaveCount(0);
      await fitViewNow(page);

      await dragOnto(page, titleOf(page, MTR10), summaryEl(page));
      await page.waitForTimeout(600); // a Review would have opened by now
      await expect(reviewDialog(page), "a drop on the summary is no request to map").toHaveCount(0);
      await expect(page.locator(".offer-bar"), "it is the plain move of a group, which offers an asset").toContainText('Create asset "MTR10" from this cluster?');
      await expect.poll(() => stub.puts.length, { message: "the move is saved" }).toBeGreaterThan(0);
      const saved = stub.puts.flat().map((n) => n.node_id);
      expect(saved, "the group's new place is saved").toContain(MTR10);
      expect(saved.filter((id) => id.startsWith("more:asset:")), "the summary has no place of its own").toEqual([]);
      expect((await flowPos(group)).x, "the group stays where it was dropped").toBeGreaterThan(before.x + 500);
      await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    });
  });

  test("5 folding Room 3 takes the summary away and shows 400 mapped; unfolding brings it back with nothing shown", async ({ page }) => {
    test.setTimeout(180_000);
    await arrive(page, familyModel());
    const room = nodeEl(page, ROOM3);
    const hide = room.getByRole("button", { name: "Hide sub-assets of Room 3", exact: true });
    const show = room.getByRole("button", { name: "Show sub-assets of Room 3", exact: true });

    await test.step("Show 50 first, so that the unfold has pages to forget", async () => {
      await pressWithMouse(page, summaryButton(page));
      await expect(pduNodes(page)).toHaveCount(ASSET_PAGE);
    });

    await test.step("fold: no summary, no PDU, 16 nodes, the badge and the one edge say 400 mapped", async () => {
      // As a person folds with the keyboard: the focus goes to Room 3 (ArrowLeft from a child), Enter folds it. (A click event sent from a script leaves the focus on a child that the fold removes: nobody does that.)
      await room.focus();
      await page.keyboard.press("Enter");
      await expect(summaries(page)).toHaveCount(0);
      await expect(pduNodes(page)).toHaveCount(0);
      await expect(page.locator(".react-flow__node"), "2 sources, MV2, 3 rooms and 10 racks").toHaveCount(16);
      await expect(room.locator(".gnode-mapped")).toHaveText("400 mapped");
      await expect(room, "the node says so to a screen reader").toHaveAttribute("aria-label", "Room 3, asset, 400 sub-assets, 400 mapped inside, closed");
      await expect(edgeLabel(page, `m:${LARGE_SRC}>${ROOM3}`), "the mapped points end on the folded room as one edge").toHaveText("400 mapped");
      await expect(show).toHaveCount(1);
      await expectFocusNamed(page, "after the fold");
    });

    await test.step("unfold: the summary is back, 400 sub-assets, nothing shown", async () => {
      await page.keyboard.press("Enter"); // the focus is still on Room 3
      await expect(summaries(page)).toHaveCount(1);
      await expect(summaryTitle(page)).toHaveText("400 sub-assets");
      await expect(summaryMapped(page)).toHaveText("400 mapped");
      await expect(summaryWords(page)).toHaveText("Show 50");
      await expect(pduNodes(page), "the page of 50 was forgotten").toHaveCount(0);
      await expect(page.locator(".react-flow__node")).toHaveCount(17);
      await expect(room.locator(".gnode-mapped"), "no badge while the sub-assets stand under it").toHaveCount(0);
      await expectFocusNamed(page, "after the unfold");
    });
  });

  test("6 the frames of a 3 s pan, at rest and with 817 nodes drawn (logged; the limits are generous)", async ({ page }) => {
    test.setTimeout(420_000);
    await arrive(page, familyModel());

    await test.step("at rest: 17 nodes", async () => {
      await panFor(page, 1); // a warm-up that is thrown away: the first pan pays for the JIT
      const rest = await panFor(page, 3);
      measured("pan 3 s at rest (17 nodes)", rest);
      expect(rest.frames, "the frame sampler ran").toBeGreaterThan(10);
      expect(rest.worstMs, "generous: the controller reads the numbers").toBeLessThan(LIMIT.worstMs);
      expect(rest.p95Ms, "generous: the controller reads the numbers").toBeLessThan(LIMIT.p95Ms);
    });

    await test.step("the stress view: the large source open, its 400 points shown, then all 400 PDUs", async () => {
      // The keyboard opens them (Enter on the focused node), so no press depends on where the camera stands after the pan.
      await nodeEl(page, LARGE_SRC).focus();
      await page.keyboard.press("Enter");
      await expect(nodeEl(page, UNGROUPED_GROUP)).toBeVisible();
      await nodeEl(page, UNGROUPED_GROUP).focus();
      await page.keyboard.press("Enter");
      await expect(pointNodes(page)).toHaveCount(ASSET_PAGE);
      const morePoints = nodeEl(page, `more:${UNGROUPED_GROUP}`).getByRole("button", { name: /more points of Ungrouped/ });
      for (let shown = 2 * ASSET_PAGE; shown <= 400; shown += ASSET_PAGE) {
        await pressWithMouse(page, morePoints);
        await expect(pointNodes(page), `${shown} points are drawn`).toHaveCount(shown);
      }
      for (let shown = ASSET_PAGE; shown <= 400; shown += ASSET_PAGE) {
        await pressWithMouse(page, summaryButton(page));
        await expect(pduNodes(page), `${shown} PDUs are drawn`).toHaveCount(shown);
      }
      await expect(summaries(page), "the summary is gone").toHaveCount(0);
      const nodes = await page.locator(".react-flow__node").count();
      measured("nodes drawn in the stress view", nodes);
      expect(nodes, "more than 800 nodes").toBeGreaterThan(800);
      await fitViewNow(page);
      for (let i = 0; i < 3; i++) {
        await page.getByRole("button", { name: "zoom in" }).click();
        await cameraStill(page);
      }
      await panFor(page, 1);
      const stress = await panFor(page, 3);
      measured(`pan 3 s with ${nodes} nodes`, stress);
      expect(stress.frames, "the frame sampler ran").toBeGreaterThan(10);
      expect(stress.worstMs, "generous: the controller reads the numbers").toBeLessThan(LIMIT.worstMs);
      expect(stress.p95Ms, "generous: the controller reads the numbers").toBeLessThan(LIMIT.p95Ms);
    });
  });

  test("7 at 1024 x 768, sidebar minimised and expanded: the summary is drawn, its button lies inside the canvas with nothing over it, and the page does not scroll sideways", async ({ page }) => {
    test.setTimeout(240_000);
    await arrive(page, familyModel(), { width: 1024, height: 768 });

    for (const want of ["minimized", "expanded"] as const) {
      await test.step(`sidebar ${want}`, async () => {
        await sidebar(page, want);
        await expect(summaries(page)).toHaveCount(1);
        await expect(summaryTitle(page)).toHaveText("400 sub-assets");

        // Fit View puts the deepest column in the bottom right corner, where the minimap lies (told in the annotation): a person brings the node into the middle of the canvas, here with Find.
        await fitViewNow(page);
        measured(`1024 x 768, sidebar ${want}: after Fit View the summary's button is covered by something`, !(await reachable(summaryButton(page))));
        const spot = await emptySpot(page);
        await page.mouse.click(spot.x, spot.y);
        await page.keyboard.press("Control+K");
        await expect(findField(page), "Find opens").toBeFocused();
        await findField(page).pressSequentially("Room 3");
        await findOptions(page).filter({ has: page.locator(".graph-find-label", { hasText: /^Room 3$/ }) }).click();
        await expect.poll(() => focusedNodeId(page), { message: "Find ended on Room 3", timeout: 15_000 }).toBe(ROOM3);
        await cameraStill(page);
        // ArrowRight from a parent with nothing shown reaches its summary, and the page's own camera keeps what it reaches clear of the minimap and the tools.
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => focusedNodeId(page), { message: "ArrowRight from Room 3 reaches the summary", timeout: 15_000 }).toBe(SUMMARY);
        await cameraStill(page);

        const button = summaryButton(page);
        await expect(button).toBeVisible();
        const pane = await boxOf(page.locator(".react-flow__pane"), "the canvas");
        expect(inside(await boxOf(button, "the summary's button"), pane), "the button lies inside the canvas").toBe(true);
        expect(await reachable(button), "nothing lies over the button").toBe(true);
        await button.click({ trial: true }); // the actionability checks of a click (visible, stable, receives the pointer) without pressing
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page does not scroll sideways").toBe(true);
      });
    }
  });
});
