import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { latestBody, node as nid, SMALL, SMALL_GROUPS, SMALL_NAMES, smallModel, type ApiGraphModel, type ApiLatest, type XY } from "./graphModel";

// W12c (the Discovery visual polish: one regrouped toolbar with chips, View, Canvas and Page controls and an overflow menu; a shortcuts bubble; a clearer source card with a short title,
// protocol and address, status word and "N of M mapped"; an icon on every node and in Find; a page icon and a one-line hint; and the last value of a mapped point on a hover).
// Admin `admin` / `correct-horse`, the account the earlier projects use.
//
// MOST OF THIS SPEC WRITES NOTHING, like w7u and w12b. Every case answers GET /api/discovery/graph from a generated model (e2e/graphModel.ts, synthetic ids from 9,000,000 up; its assets now carry
// `icon` and `kind_icon`) and the layout's PUT and DELETE through `page.route`, and GET /api/mappings/{id}/latest (the value card's read) with a body the case chooses (fresh, stale, bad
// quality, no reading, a failure). Any OTHER write the app tries is refused with a 500 and written down, and afterEach fails the case that made one. A role-limited case answers /api/me with a short
// permission list (the page decides what to draw from it); the dark cases answer it with the account's mode set to dark. The ONE case that writes is the last: it makes a role and an account whose names
// start `w12c-` to see the real route answer 403, and removes both again (afterAll sweeps what a failed run left).
//
// The width tiers of the bar are the stylesheet's business and change as it is tuned, so NO pixel threshold of a tier is pinned. What is checked holds at any threshold: at 1440, 1024 and 800 px wide with
// the sidebar minimized and expanded the bar is 36 px high, nothing sticks out of it, nothing wraps, chips are drawn whole or not at all, every control keeps its accessible name, the three narrow
// controls (Unmapped only, Tidy layout, Snap to grid) are in exactly one place (in the bar, or an item of the overflow menu), the page does not scroll sideways, and a narrower bar never shows MORE
// words than a wider one.
//
// The cases:
//   page      the page icon is the sidebar's Discovery icon, in the loading branch and loaded, with the one-sentence hint.
//   bar       the properties above, sidebar minimized and expanded; the same for a role with discovery.view only (the overflow button exists only while it holds something: at 1440 a reader has none);
//             an administrator's overflow menu holds Clear unmapped (N).
//   bubble    the keyboard button opens a dialog with six titled groups; Escape and Tab close it and give the focus back to the opener (the button; the canvas when `?` opened it), never <body>;
//             `?` typed into the Find field is a letter; it fits the window at 1440 x 900, 1024 x 640 and 800 x 600.
//   find      the Find card (it stays in the canvas) does not cover the Source details panel's Close button at 1440, 1024 and 800 px.
//   card      a source card: the short title on up to TWO lines (w14: a clamp; the full name in `title` and in every name), protocol and address, status word and origin, "N of M mapped", Details, and the `Source actions
//             for <name>` menu, whose items equal the right-click menu's; a role with discovery.view only has no such button and no Remove or Create assets in the right-click menu.
//   icons     a `gicon` of the right drawing on every node kind; an asset with a chosen icon shows that one; Find's options carry an icon.
//   value     the card for a mapped point (mocked answers): after the dwell, the words, the age counting, stale / bad reading / no reading / a failed read, none for an unmapped point, one read per hover, the
//             node's aria-describedby restored, Escape and a pan hide it, keyboard focus shows it; a role without assets.view asks for nothing. A row with a time and no value (the collector's failed
//             read, quality 1) says "No value, N s ago, bad reading", not "No reading yet"; a right-click on the point with the card showing takes the card away, and one Escape closes the menu only.
//   look      light and dark: text contrast of the new parts, no sideways scroll.
//   route     the real stack: GET /api/mappings/{id}/latest is 200 for the administrator, 404 for an unknown mapping, 401 signed out and 403 for a role without assets.view; the graph's assets carry icon and kind_icon.
//
// Locators. Playwright matches a name by case-insensitive SUBSTRING and `getByRole` leaves out what is `display: none`: lookups of buttons are `exact: true`; the bubble and its button share the name
// `Keyboard shortcuts and controls`, so each is looked up by ROLE (dialog, button). A narrow control that left the bar is not found by role in the bar, and is an item of the overflow menu.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";

interface Box { x: number; y: number; width: number; height: number }
interface Size { width: number; height: number }

/** The bar's height (px): the rule `.graph-bar, .graph-bar-space` in discovery-tidy.css, so the canvas does not drop when the graph arrives. */
const BAR_H = 36;
/** hooks/useValueTip.ts VALUE_DWELL_MS: how long a node must be hovered or focused before the card shows. */
const DWELL_MS = 350;
/** lib/graph.ts SOURCE_H. */
const SOURCE_H = 136;

// ---------------------------------------------------------------------------------------------------------------------------------
// The stub: the generated graph, the value card's read, and the refusal of every other write

interface Stub {
  model: ApiGraphModel;
  /** The places the layout holds now (the model's, then what the page PUT; DELETE empties it). */
  layout: Record<string, XY>;
  /** How many times the page read the graph: 0 would mean the generated graph never reached it. */
  reads: number;
  /** Writes the stub does not know. The page gets a 500 and afterEach fails the case. */
  stray: string[];
  /** Console errors and uncaught exceptions of the page. */
  errors: string[];
  /** The reads of GET /api/mappings/{id}/latest, with the time each arrived (ms, this process's clock). */
  latest: { id: number; at: number }[];
  /** What the route answers. A case replaces it. */
  answer: (id: number) => { status: number; body: unknown };
  /** A case that makes the read fail on purpose: the browser's console error for it is expected. */
  failing: boolean;
}
let current: Stub | null = null;

test.afterEach(() => {
  const stub = current;
  current = null;
  expect(stub?.stray ?? [], "the spec writes nothing to the stack: these requests were refused").toEqual([]);
  const errors = (stub?.errors ?? []).filter((e) => !(stub?.failing && /\/api\/mappings\/\d+\/latest/.test(e)));
  expect(errors, "the page logged no error").toEqual([]);
});

async function stubGraph(page: Page, model: ApiGraphModel, delayMs = 0): Promise<Stub> {
  const stub: Stub = {
    model, layout: { ...model.layout }, reads: 0, stray: [], errors: [], latest: [], answer: (id) => ({ status: 200, body: latestBody(id) }), failing: false,
  };
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
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "w12c: this spec writes nothing" }) });
  });
  await page.route(/\/api\/discovery\/graph(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    stub.reads++;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
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
  await page.route(/\/api\/mappings\/\d+\/latest(\?.*)?$/, async (route) => {
    const id = Number(/\/mappings\/(\d+)\/latest/.exec(route.request().url())![1]);
    stub.latest.push({ id, at: Date.now() });
    const { status, body } = stub.answer(id);
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  current = stub;
  return stub;
}

interface Me { permissions?: readonly string[]; mode?: "light" | "dark" }
/** The signed-in account keeps its session, but the page is told it holds only these permissions and/or this appearance mode (the page decides what to draw from /api/me). */
async function meAs(page: Page, over: Me): Promise<void> {
  await page.route((url) => url.pathname === "/api/me", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const real = await route.fetch();
    const me = (await real.json()) as Record<string, unknown>;
    const body = {
      ...me,
      ...(over.permissions ? { role: "w12c-reader", permissions: over.permissions } : {}),
      ...(over.mode ? { preferences: { ...(me.preferences as Record<string, unknown> | undefined), mode: over.mode } } : {}),
    };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

async function signIn(page: Page): Promise<void> {
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in as ${ADMIN.username}: ${login.status()} ${await login.text()}`).toBe(true);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Locators and small readings

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const nodeEl = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const titleOf = (page: Page, id: string) => nodeEl(page, id).locator(".node-title");
const bar = (page: Page) => page.locator(".graph-bar");
const barButton = (page: Page, name: string) => bar(page).getByRole("button", { name, exact: true });
const overflowButton = (page: Page) => barButton(page, "More Discovery actions");
const overflowMenu = (page: Page) => page.getByRole("menu", { name: "Discovery actions", exact: true });
const shortcutsButton = (page: Page) => bar(page).getByRole("button", { name: "Keyboard shortcuts and controls", exact: true });
const shortcutsBubble = (page: Page) => page.getByRole("dialog", { name: "Keyboard shortcuts and controls", exact: true });
const findField = (page: Page) => page.getByRole("combobox", { name: "Search the graph", exact: true });
const findOptions = (page: Page) => page.locator(".graph-find").getByRole("option");
const tooltip = (page: Page) => page.getByRole("tooltip");
const sourceActions = (page: Page, name: string) => page.getByRole("button", { name: `Source actions for ${name}`, exact: true });

async function boxOf(target: Locator, what: string): Promise<Box> {
  const box = await target.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  return box!;
}
const centreOf = (box: Box): XY => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const inside = (box: Box, frame: Box) => box.x >= frame.x - 1 && box.y >= frame.y - 1 && box.x + box.width <= frame.x + frame.width + 1 && box.y + box.height <= frame.y + frame.height + 1;
const overlap = (a: Box, b: Box) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
const measured = (what: string, value: unknown) => {
  test.info().annotations.push({ type: "measure", description: `${what}: ${JSON.stringify(value)}` });
};
/** Two animation frames: a layout the page has just changed (a resize, a container query) is in. */
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
/** The sentence a menu item says: its label, without the reason of a blocked item that stands in a second line inside it. */
const labelsOf = (menu: Locator): Promise<string[]> =>
  menu.getByRole("menuitem").evaluateAll((items) => items.map((item) => (item.querySelector(":scope > .graph-menu-text > span:first-child") ?? item).textContent?.trim() ?? ""));

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
const focusedNodeId = (page: Page) => page.evaluate(() => document.activeElement?.closest(".react-flow__node")?.getAttribute("data-id") ?? null);
/** Puts the focus on an element without scrolling anything (the canvas is overflow hidden). */
const focusQuietly = (target: Locator) => target.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));

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

interface Opening extends Partial<Size>, Me { delayMs?: number; fit?: boolean }
/** Signs in, installs the stub for `model` and sets the window; the page is not opened yet. */
async function prepare(page: Page, model: ApiGraphModel, { width = 1440, height = 900, delayMs = 0, permissions, mode }: Opening = {}): Promise<Stub> {
  await signIn(page);
  const stub = await stubGraph(page, model, delayMs);
  if (permissions || mode) await meAs(page, { permissions, mode });
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
/** prepare + visit + Fit View. */
async function arrive(page: Page, model: ApiGraphModel, opening: Opening = {}): Promise<Stub> {
  const stub = await prepare(page, model, opening);
  await visit(page, stub);
  if (opening.fit !== false) await fitViewNow(page);
  return stub;
}

/** The sidebar starts minimized in a window under 1180 px and expanded above it; a click on its toggle changes it (and is remembered). */
async function setSidebar(page: Page, state: "minimized" | "expanded"): Promise<void> {
  const shell = page.locator(".shell");
  if ((await shell.getAttribute("data-sidebar")) !== state) await page.getByRole("button", { name: state === "expanded" ? "Expand sidebar" : "Minimize sidebar", exact: true }).click();
  await expect(shell).toHaveAttribute("data-sidebar", state);
  await settled(page);
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

/** Opens alpha and its first group LVP01 (the mapped point "LVP01 kW" and an unmapped one are then nodes), and fits the view. */
async function openAlpha(page: Page): Promise<void> {
  await nodeEl(page, nid.source(SMALL.alpha)).getByRole("button", { name: `Expand ${SMALL_NAMES.alpha}`, exact: true }).click();
  await expect(nodeEl(page, nid.cluster(SMALL.alpha, SMALL_GROUPS.lvp01))).toBeVisible();
  await nodeEl(page, nid.cluster(SMALL.alpha, SMALL_GROUPS.lvp01)).getByRole("button", { name: `Expand ${SMALL_GROUPS.lvp01}`, exact: true }).click();
  await expect(nodeEl(page, nid.point(SMALL.alphaMapped))).toBeVisible();
  await cameraStill(page);
  await fitViewNow(page);
}

/** Moves the pointer to a spot on the empty canvas (every node's pointer-leave runs). */
async function away(page: Page): Promise<void> {
  const spot = await emptySpot(page);
  await page.mouse.move(spot.x, spot.y, { steps: 4 });
}
/** Moves the pointer from the empty canvas onto the centre of a node's title (not onto a button of it) and returns when the last move began (ms, this process's clock). */
async function hover(page: Page, id: string): Promise<number> {
  await away(page);
  const at = centreOf(await boxOf(titleOf(page, id), `the title of ${id}`));
  const began = Date.now();
  await page.mouse.move(at.x, at.y, { steps: 8 });
  return began;
}
const describedBy = (page: Page, id: string) => nodeEl(page, id).getAttribute("aria-describedby");

// ---------------------------------------------------------------------------------------------------------------------------------
// The bar, measured in the page

interface Control { name: string; box: Box; lines: number; chars: number }
interface BarReading {
  bar: Box;
  /** bar.scrollWidth - bar.clientWidth. */
  barScroll: number;
  /**
   * How far the Discovery page's own content (header, bar, canvas row) reaches past the window's right edge. The document's own sideways scroll (`documentScroll`) is written down but not asserted:
   * at 800 px with the sidebar expanded the shell's TOP bar (the profile button, `.navbar`) used to end at 818 px on EVERY page (Assets, Sources and Scans too), which is not this page's content; w14 (P6) fixed
   * that and its spec asserts a document that does not scroll sideways at all, so this stays a note here.
   */
  contentOverflow: number;
  documentScroll: number;
  controls: Control[];
  dividers: Box[];
  chips: { text: string; whole: boolean; partial: boolean }[];
  /** The visible characters in the bar's controls and drawn chips: a word that a narrow bar takes away (visually hidden, or not drawn) is not counted. */
  letters: number;
}
const readBar = (page: Page): Promise<BarReading> =>
  page.evaluate(() => {
    const barEl = document.querySelector<HTMLElement>(".graph-bar")!;
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const drawn = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== "hidden";
    };
    /** The lines and the visible characters of the text inside `root`. A text node counts when its box is more than 2 px wide (the visually hidden pattern is 1 px) and, with a `clip`, inside it. */
    const textOf = (root: Element, clip?: DOMRect) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const tops = new Set<number>();
      let chars = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        if (!text.data.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        const boxes = Array.from(range.getClientRects()).filter((r) => r.width > 2 && r.height > 2);
        if (boxes.length === 0) continue;
        if (clip && !boxes.every((r) => r.top >= clip.top - 1 && r.bottom <= clip.bottom + 1 && r.right <= clip.right + 1)) continue;
        for (const r of boxes) tops.add(Math.round(r.top / 4));
        chars += text.data.trim().length;
      }
      return { lines: tops.size, chars };
    };
    const controls = Array.from(barEl.querySelectorAll<HTMLElement>("button, label.graph-bar-switch"))
      .filter(drawn)
      .map((el) => ({ name: el.getAttribute("aria-label") ?? (el.textContent ?? "").trim(), box: rect(el), ...textOf(el) }));
    const group = barEl.querySelector<HTMLElement>(".gbar-chips");
    const groupBox = group?.getBoundingClientRect();
    const chips = Array.from(barEl.querySelectorAll<HTMLElement>(".gbar-chip")).map((el) => {
      const r = el.getBoundingClientRect();
      const within = !!groupBox && r.top >= groupBox.top - 1 && r.bottom <= groupBox.bottom + 1 && r.right <= groupBox.right + 1 && r.left >= groupBox.left - 1;
      const touches = !!groupBox && r.bottom > groupBox.top && r.top < groupBox.bottom && r.right > groupBox.left && r.left < groupBox.right;
      return { text: (el.getAttribute("title") ?? "").trim(), whole: within, partial: touches && !within, chars: within && groupBox ? textOf(el, groupBox).chars : 0 };
    });
    const letters = controls.reduce((n, c) => n + c.chars, 0) + chips.reduce((n, c) => n + c.chars, 0);
    return {
      bar: rect(barEl),
      barScroll: barEl.scrollWidth - barEl.clientWidth,
      contentOverflow: Math.max(0, ...[".page-head", ".graph-bar", ".graph-layout"].map((selector) => (document.querySelector(selector)?.getBoundingClientRect().right ?? 0) - document.documentElement.clientWidth)),
      documentScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      controls,
      dividers: Array.from(barEl.querySelectorAll(".gbar-divider")).filter(drawn).map(rect),
      chips: chips.map(({ text, whole, partial }) => ({ text, whole, partial })),
      letters,
    };
  });

/** What must hold at any width: 36 px, nothing out of the bar, one row, no wrapped text, no overlap (a split button's chevron overlaps its button by a border), chips whole or not drawn, no sideways scroll. */
function expectSound(reading: BarReading, where: string): void {
  const { bar: box } = reading;
  expect.soft(box.height, `${where}: the bar is ${BAR_H} px high`).toBeGreaterThanOrEqual(BAR_H - 0.5);
  expect.soft(box.height, `${where}: the bar is ${BAR_H} px high`).toBeLessThanOrEqual(BAR_H + 0.5);
  expect.soft(reading.barScroll, `${where}: the bar does not scroll sideways`).toBeLessThanOrEqual(1);
  expect.soft(reading.contentOverflow, `${where}: the header, the bar and the canvas row stay inside the window`).toBeLessThanOrEqual(1);
  if (reading.documentScroll > 1) measured(`${where}: the document scrolls sideways by`, reading.documentScroll);
  const centres = reading.controls.map((c) => c.box.y + c.box.height / 2);
  expect.soft(Math.max(...centres) - Math.min(...centres), `${where}: the controls share one row`).toBeLessThanOrEqual(2);
  for (const c of reading.controls) {
    expect.soft(inside(c.box, box), `${where}: ${c.name} lies inside the bar`).toBe(true);
    expect.soft(c.lines, `${where}: ${c.name} is on one line`).toBeLessThanOrEqual(1);
    expect.soft(c.box.height, `${where}: ${c.name} is no taller than the bar`).toBeLessThanOrEqual(BAR_H);
  }
  for (const d of reading.dividers) expect.soft(inside(d, box), `${where}: a divider lies inside the bar`).toBe(true);
  const row = [...reading.controls].sort((a, b) => a.box.x - b.box.x);
  for (let i = 1; i < row.length; i++) {
    expect.soft(row[i].box.x, `${where}: ${row[i - 1].name} and ${row[i].name} do not overlap`).toBeGreaterThanOrEqual(row[i - 1].box.x + row[i - 1].box.width - 1.5);
  }
  for (const chip of reading.chips) expect.soft(chip.partial, `${where}: the chip "${chip.text}" is drawn whole or not at all`).toBe(false);
}

// What the bar offers. The three narrow controls may leave the bar for the overflow menu; every other control stays, whatever the width.
type Role = "button" | "switch";
const NARROW: { name: string; role: Role; item: RegExp }[] = [
  { name: "Unmapped only", role: "switch", item: /^Turn (on|off) Unmapped only$/ },
  { name: "Tidy layout", role: "button", item: /^Tidy layout$/ },
  { name: "Snap to grid", role: "button", item: /^Turn (on|off) Snap to grid$/ },
];
const STAY = ["Collapse all", "More ways to collapse", "Expand all", "More ways to expand", "Find", "Refresh", "Keyboard shortcuts and controls"];
/** The groups of the bar. */
const GROUPS = ["View controls", "Canvas controls", "Page controls"];
/** The removable sources of smallModel(): the discovered ones with nothing mapped (Bravo and Charlie). */
const CLEARABLE = 2;

/**
 * Where each control of the bar is, for the account: STAY ones are drawn once; each narrow one is drawn in the bar XOR is an item of the overflow menu ("Turn on/off Unmapped only", "Tidy layout",
 * "Turn on/off Snap to grid"); an administrator's overflow button is always drawn and its menu holds Clear unmapped (N); a reader's overflow button is drawn exactly while it holds something (a
 * narrow control is away) and never holds Clear unmapped. Opens and closes the menu (Escape puts the focus back on the button).
 */
async function expectPlaces(page: Page, who: "admin" | "reader", where: string): Promise<{ inline: string[]; away: string[]; items: string[] }> {
  for (const name of GROUPS) await expect(bar(page).getByRole("group", { name, exact: true }), `${where}: the group ${name}`).toHaveCount(1);
  for (const name of STAY) await expect(barButton(page, name), `${where}: ${name} is drawn in the bar`).toHaveCount(1);
  const inline: string[] = [];
  for (const n of NARROW) if ((await bar(page).getByRole(n.role, { name: n.name, exact: true }).count()) === 1) inline.push(n.name);
  const away = NARROW.map((n) => n.name).filter((name) => !inline.includes(name));
  const more = overflowButton(page);
  const shown = (await more.count()) === 1;
  if (who === "admin") expect(shown, `${where}: an administrator's overflow button is always drawn (it holds Clear unmapped)`).toBe(true);
  else expect(shown, `${where}: a reader's overflow button is drawn exactly while a narrow control is away (${away.length} away)`).toBe(away.length > 0);
  let items: string[] = [];
  if (shown) {
    await more.click();
    const menu = overflowMenu(page);
    await expect(menu).toBeVisible();
    items = await labelsOf(menu);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(more, `${where}: Escape gives the focus back to the overflow button`).toBeFocused();
  }
  for (const n of NARROW) {
    const here = (inline.includes(n.name) ? 1 : 0) + items.filter((label) => n.item.test(label)).length;
    expect.soft(here, `${where}: ${n.name} is in exactly one place (${inline.includes(n.name) ? "in the bar" : "in the menu"})`).toBe(1);
  }
  if (who === "admin") expect.soft(items, `${where}: the overflow menu holds Clear unmapped`).toContain(`Clear unmapped (${CLEARABLE})`);
  else expect.soft(items.filter((label) => /^Clear unmapped/.test(label)), `${where}: a reader's menu has no Clear unmapped`).toEqual([]);
  measured(where, { inline, away, items });
  return { inline, away, items };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The models

/** smallModel() with the names a scan gives (a short title and an address after "at"), one name too long for a card, an unidentified service, and the Rack's chosen icon. */
const LONG_NAME = "W12c a source name that somebody typed and that is far too long to fit on one line of a card two hundred and twenty pixels wide";
function cardModel(): ApiGraphModel {
  const model = smallModel();
  const [alpha, bravo, charlie] = model.sources;
  alpha.name = "OPC UA server at 10.20.0.11:4840";
  bravo.name = "Modbus device at 10.20.0.12:502";
  charlie.name = LONG_NAME;
  model.unidentified = [{ host: "10.20.0.99", port: 502, scan_id: 7 }];
  return model;
}

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W12c: the page", () => {
  test("the page icon is the sidebar's Discovery icon, in the loading branch and loaded, with the one-sentence hint", async ({ page }) => {
    test.setTimeout(120_000);
    const stub = await prepare(page, smallModel(), { delayMs: 1500 });
    await page.goto("/discovery");
    const tile = page.locator(".page-head .page-tile svg");
    const sidebarIcon = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Discovery", exact: true }).locator("svg");
    const HINT = "Dashed means discovered, solid means assets. Drag a group onto an asset to map it.";
    await test.step("while the graph loads", async () => {
      await expect(page.locator(".graph-bar-space"), "the loading branch").toBeVisible({ timeout: 30_000 });
      await expect(tile, "the icon is there").toHaveCount(1);
      await expect(page.locator(".page-head .sub")).toHaveText(HINT);
      expect(await tile.innerHTML(), "and is the sidebar's Discovery drawing").toBe(await sidebarIcon.innerHTML());
      await expect(page.locator(".page-head .actions"), "no actions in the header: they moved into the bar").toHaveCount(0);
    });
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
    expect(stub.reads).toBeGreaterThan(0);
    await test.step("once loaded", async () => {
      await expect(tile).toHaveCount(1);
      await expect(page.locator(".page-head .sub")).toHaveText(HINT);
      await expect(page.locator(".page-head .actions")).toHaveCount(0);
      await expect(heading1(page, "Discovery"), "the heading is still just the title").toHaveText("Discovery");
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W12c: the bar", () => {
  for (const sidebar of ["minimized", "expanded"] as const) {
    test(`at 1440, 1024 and 800 px wide with the sidebar ${sidebar}: 36 px, nothing out of the bar, every name kept, the narrow controls in one place, never more words in a narrower bar`, async ({ page }) => {
      test.setTimeout(180_000);
      await arrive(page, smallModel(), { width: 1440, height: 900 });
      await setSidebar(page, sidebar);
      let wider: { width: number; letters: number } | null = null;
      for (const width of [1440, 1024, 800]) {
        await test.step(`${width} px`, async () => {
          await page.setViewportSize({ width, height: 800 });
          await settled(page);
          await cameraStill(page);
          const where = `${width} px, sidebar ${sidebar}`;
          const reading = await readBar(page);
          expectSound(reading, where);
          await expectPlaces(page, "admin", where);
          measured(`${where} words`, { letters: reading.letters, controls: reading.controls.length, chips: reading.chips.filter((c) => c.whole).length });
          if (wider) expect.soft(reading.letters, `${where}: no more words than at ${wider.width} px (${reading.letters} against ${wider.letters} characters)`).toBeLessThanOrEqual(wider.letters);
          wider = { width, letters: reading.letters };
        });
      }
    });
  }

  test("a role with discovery.view only: the same bar, an overflow button only while it holds something (none at 1440 with the sidebar minimized), and no Clear unmapped", async ({ page }) => {
    test.setTimeout(180_000);
    await arrive(page, smallModel(), { width: 1440, height: 900, permissions: ["discovery.view"] });
    for (const sidebar of ["minimized", "expanded"] as const) {
      await setSidebar(page, sidebar);
      for (const width of [1440, 1024, 800]) {
        await test.step(`${width} px, sidebar ${sidebar}`, async () => {
          await page.setViewportSize({ width, height: 800 });
          await settled(page);
          await cameraStill(page);
          const where = `reader, ${width} px, sidebar ${sidebar}`;
          expectSound(await readBar(page), where);
          const places = await expectPlaces(page, "reader", where);
          if (width === 1440 && sidebar === "minimized") {
            expect(places.away, "at 1440 with the sidebar minimized every control is drawn").toEqual([]);
            await expect(overflowButton(page), "so a reader sees no button that opens nothing").toHaveCount(0);
          }
        });
      }
    }
  });

  test("Clear unmapped is in the overflow menu with its count, and the item waits (aria-disabled, with the reason) when nothing is removable", async ({ page }) => {
    test.setTimeout(120_000);
    const empty = smallModel(); // every discovered source mapped: nothing to clear
    for (const source of empty.sources) for (const p of [...source.ungrouped, ...source.clusters.flatMap((c) => c.points)]) if (p.mapping_id === null) { p.mapping_id = 9_700_000 + p.id % 100000; p.asset_id = SMALL.hall; p.mapped_metric = p.suggestion.metric; }
    await arrive(page, empty, { width: 1440, height: 900 });
    await overflowButton(page).click();
    const item = overflowMenu(page).getByRole("menuitem", { name: /^Clear unmapped \(0\)/ });
    await expect(item, "the count is in the item's name").toBeVisible();
    await expect(item).toHaveAttribute("aria-disabled", "true");
    await expect(item, "and says why").toContainText("Nothing to clear");
    await page.keyboard.press("Escape");
    await expect(overflowButton(page)).toBeFocused();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W12c: the shortcuts bubble", () => {
  const GROUP_TITLES = ["Move and select", "Camera", "Find", "Menus", "Mapping", "Navigation"];

  test("the button opens it, six titled groups, Escape and Tab close it and give the focus back to the button, a second press closes it", async ({ page }) => {
    test.setTimeout(120_000);
    await arrive(page, smallModel(), { width: 1440, height: 900 });
    const button = shortcutsButton(page);
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(shortcutsBubble(page), "closed: not in the page").toHaveCount(0);

    await test.step("opens by the button, focus inside, six groups with keys as caps", async () => {
      await button.click();
      const bubble = shortcutsBubble(page);
      await expect(bubble).toBeVisible();
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await expect(bubble, "the focus moved into the bubble").toBeFocused();
      expect(await bubble.getByRole("heading", { level: 3 }).allTextContents(), "six titled groups").toEqual(GROUP_TITLES);
      expect(await bubble.locator("kbd").count(), "keys are caps").toBeGreaterThan(8);
    });
    await test.step("Escape closes it and the focus is on the button", async () => {
      await page.keyboard.press("Escape");
      await expect(shortcutsBubble(page)).toHaveCount(0);
      await expect(button).toBeFocused();
      await expect(button).toHaveAttribute("aria-expanded", "false");
    });
    await test.step("Tab closes it and the focus lands on the button, never on <body>", async () => {
      await button.click();
      await expect(shortcutsBubble(page)).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(shortcutsBubble(page)).toHaveCount(0);
      expect((await focusOf(page)).body, "the focus is not on <body>").toBe(false);
      await expect(button).toBeFocused();
    });
    await test.step("a second press on the button closes it", async () => {
      await button.click();
      await expect(shortcutsBubble(page)).toBeVisible();
      await button.click();
      await expect(shortcutsBubble(page)).toHaveCount(0);
    });
    await test.step("a press outside closes it", async () => {
      await button.click();
      await expect(shortcutsBubble(page)).toBeVisible();
      const spot = await emptySpot(page);
      await page.mouse.click(spot.x, spot.y);
      await expect(shortcutsBubble(page)).toHaveCount(0);
    });
  });

  test("? on the canvas opens it and Escape gives the focus back to the canvas; typed in the Find field it is a letter", async ({ page }) => {
    test.setTimeout(120_000);
    await arrive(page, smallModel(), { width: 1440, height: 900 });
    const spot = await emptySpot(page);
    await page.mouse.click(spot.x, spot.y); // the canvas group takes the focus
    expect((await focusOf(page)).canvas, "the canvas holds the focus").toBe(true);
    await page.keyboard.press("?");
    const bubble = shortcutsBubble(page);
    await expect(bubble).toBeVisible();
    await expect(shortcutsButton(page)).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(bubble).toHaveCount(0);
    expect((await focusOf(page)).canvas, "the focus went back to the canvas, where ? was pressed").toBe(true);

    await test.step("in the Find field a ? is just a character", async () => {
      await page.keyboard.press("Control+K");
      await expect(findField(page)).toBeFocused();
      await page.keyboard.type("?");
      await expect(findField(page)).toHaveValue("?");
      await expect(shortcutsBubble(page), "no bubble").toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(findField(page)).toHaveCount(0);
    });
  });

  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 640 }, { width: 800, height: 600 }]) {
    test(`at ${size.width} x ${size.height} it lies inside the window and scrolls inside itself when it is taller than the room`, async ({ page }) => {
      test.setTimeout(120_000);
      await arrive(page, smallModel(), size);
      await shortcutsButton(page).click();
      const bubble = shortcutsBubble(page);
      await expect(bubble).toBeVisible();
      await expect(bubble).toBeFocused(); // measured after it has been placed
      const box = await boxOf(bubble, "the bubble");
      expect(inside(box, { x: 0, y: 0, width: size.width, height: size.height }), `the bubble ${JSON.stringify(box)} lies inside the window`).toBe(true);
      const room = await bubble.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, overflowY: getComputedStyle(el).overflowY }));
      measured(`${size.width} x ${size.height} bubble`, { ...box, ...room });
      if (room.scroll > room.client + 1) expect(["auto", "scroll"], "taller than its room, so it scrolls inside itself").toContain(room.overflowY);
      expect((await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)), "no sideways scroll").toBeLessThanOrEqual(1);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W12c: the Find card and the Source details panel", () => {
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 640 }, { width: 800, height: 600 }]) {
    test(`at ${size.width} x ${size.height} the Find card stays in the canvas and does not cover the panel's Close button`, async ({ page }) => {
      test.setTimeout(120_000);
      await arrive(page, smallModel(), size);
      await nodeEl(page, nid.source(SMALL.bravo)).getByRole("button", { name: `Details for ${SMALL_NAMES.bravo}`, exact: true }).click();
      const panel = page.getByRole("complementary", { name: "Source details" });
      await expect(panel).toBeVisible();
      const find = bar(page).getByRole("button", { name: "Find", exact: true });
      await find.click();
      await expect(find).toHaveAttribute("aria-expanded", "true");
      await findField(page).pressSequentially("rack-b power");
      await expect(findOptions(page)).toHaveCount(1);
      const canvas = await boxOf(page.locator(".graph-canvas"), "the canvas");
      const card = await boxOf(page.locator(".graph-find"), "the Find card");
      const close = await boxOf(panel.getByRole("button", { name: "Close", exact: true }), "the panel's Close button");
      expect(inside(card, canvas), "the card lies inside the canvas").toBe(true);
      expect(overlap(card, close), "the card does not cover Close").toBe(false);
      const topmost = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("aside")?.getAttribute("aria-label") ?? null, centreOf(close));
      expect(topmost, "the topmost element at Close's centre belongs to the panel").toBe("Source details");
      await page.keyboard.press("Escape");
      await expect(findField(page)).toHaveCount(0);
      await expect(find, "Escape gives the focus back to the Find button").toBeFocused();
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W12c: the source card", () => {
  // The cases of cardModel(): the title is the name without " at host:port", on up to TWO lines (w14: a clamp of two 18px lines, the rest cut); the next line is the protocol and where it listens.
  const CARDS = [
    { id: SMALL.alpha, full: "OPC UA server at 10.20.0.11:4840", title: "OPC UA server", sub: "OPC UA · 10.20.0.11:4840", status: "online · discovered", mapped: "4 of 9 mapped", create: "Create assets for 2 groups…", remove: false },
    { id: SMALL.bravo, full: "Modbus device at 10.20.0.12:502", title: "Modbus device", sub: "Modbus · 10.20.0.12:502", status: "offline · discovered", mapped: "0 of 2 mapped", create: "Create assets for 1 group…", remove: true },
    { id: SMALL.charlie, full: LONG_NAME, title: LONG_NAME, sub: "OPC UA · 10.20.0.13:4840", status: "needs credentials · discovered", mapped: "0 of 2 mapped", create: null, remove: true },
    { id: SMALL.delta, full: SMALL_NAMES.delta, title: SMALL_NAMES.delta, sub: "Simulator · w7u", status: "disabled · manual", mapped: "0 of 2 mapped", create: "Create assets for 1 group…", remove: false },
  ] as const;

  test("the card says: the short title on up to two lines, the protocol and address, the status word, N of M mapped, Details and the Source actions menu; its menu is the right-click menu", async ({ page }) => {
    test.setTimeout(180_000);
    await arrive(page, cardModel(), { width: 1440, height: 900 });
    const zoom = await page.locator(".react-flow__viewport").evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
    for (const c of CARDS) {
      await test.step(c.full.slice(0, 40), async () => {
        const card = nodeEl(page, nid.source(c.id));
        const title = card.locator(".gsrc-title");
        await expect(title, "the short title").toHaveText(c.title);
        await expect(title, "and the full name in its title attribute").toHaveAttribute("title", c.full);
        // w14: the title is a clamp of TWO 18px lines (-webkit-line-clamp: 2), cut VERTICALLY: its box (clientHeight, CSS px) is at most two lines tall, and a name that needs more has a taller content
        // (Chromium reports the whole text as the scrollHeight of a clamped box). It is no longer one nowrap line cut by width.
        const lines = await title.evaluate((el) => ({ box: el.clientHeight, clamp: getComputedStyle(el).getPropertyValue("-webkit-line-clamp"), overflow: getComputedStyle(el).overflow, cut: el.scrollHeight > el.clientHeight }));
        expect.soft(lines.box, "at most TWO lines").toBeLessThanOrEqual(2 * 18 + 1);
        expect.soft(lines.clamp).toBe("2");
        expect.soft(lines.overflow).toBe("hidden");
        if (c.full === LONG_NAME) expect.soft(lines.cut, "a name too long for the card is cut after its second line").toBe(true);
        else expect.soft(lines.cut, "a name that fits two lines is whole").toBe(false);
        await expect(card.locator(".gsrc-sub"), "protocol and address").toHaveText(c.sub);
        await expect(card.locator(".gsrc-status"), "status word and origin").toHaveText(c.status);
        await expect(card.locator(".gsrc-words"), "the mapped share in words").toHaveText(c.mapped);
        await expect(card.getByRole("button", { name: `Details for ${c.full}`, exact: true }), "Details keeps the full name").toBeVisible();
        await expect(card.getByRole("button", { name: `Expand ${c.full}`, exact: true }), "so does the fold").toBeVisible();
        const high = (await boxOf(card.locator(".gnode"), "the card")).height / zoom;
        expect.soft(high, `the card is ${high.toFixed(1)} px high, the block gives it ${SOURCE_H}`).toBeLessThanOrEqual(SOURCE_H + 1);
        await expect(card.getByRole("button", { name: /^(Remove|Create assets)/ }), "Remove and Create assets are not buttons of the card").toHaveCount(0);
      });
    }

    for (const c of CARDS) {
      await test.step(`the menu of ${c.title.slice(0, 30)}`, async () => {
        const want = ["Details", "Expand", ...(c.create ? [c.create] : []), ...(c.remove ? ["Remove from Discovery…"] : []), "Expand this branch", "Collapse this branch"];
        const button = sourceActions(page, c.full);
        await button.click();
        const menu = page.getByRole("menu", { name: `Actions for ${c.full}`, exact: true });
        await expect(menu).toBeVisible();
        expect(await labelsOf(menu), "the Source actions menu").toEqual(want);
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
        await expect(button, "Escape gives the focus back to the button").toBeFocused();
        await card_rightClick(page, c.id);
        const second = page.getByRole("menu", { name: `Actions for ${c.full}`, exact: true });
        await expect(second).toBeVisible();
        expect(await labelsOf(second), "the right-click menu lists the same").toEqual(want);
        await page.keyboard.press("Escape");
        await expect(second).toBeHidden();
      });
    }
  });

  test("a role with discovery.view only: Details and the fold, no Source actions button, and no Remove or Create assets in the right-click menu", async ({ page }) => {
    test.setTimeout(120_000);
    await arrive(page, cardModel(), { width: 1440, height: 900, permissions: ["discovery.view"] });
    for (const c of CARDS) {
      await expect(nodeEl(page, nid.source(c.id)).getByRole("button", { name: `Details for ${c.full}`, exact: true }), `${c.title.slice(0, 20)}: Details is there to be absent next to`).toBeVisible();
      await expect(sourceActions(page, c.full), `${c.title.slice(0, 20)}: no Source actions button`).toHaveCount(0);
    }
    const c = CARDS[1];
    await card_rightClick(page, c.id);
    const menu = page.getByRole("menu", { name: `Actions for ${c.full}`, exact: true });
    await expect(menu).toBeVisible();
    expect(await labelsOf(menu), "only what a reader may do").toEqual(["Details", "Expand", "Expand this branch", "Collapse this branch"]);
    await page.keyboard.press("Escape");
  });
});

/** A right-click on the title of a source node, which opens the same menu as its Source actions button. */
async function card_rightClick(page: Page, sourceId: number): Promise<void> {
  await nodeEl(page, nid.source(sourceId)).locator(".gsrc-title").click({ button: "right" });
}

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W12c: the icons", () => {
  test("every node draws its icon: a protocol for a source, layers for a group, a metric for a point, the asset's own for an asset (a chosen one wins), the generic service for an unidentified one; Find's options carry one", async ({ page }) => {
    test.setTimeout(150_000);
    const model = cardModel();
    await arrive(page, model, { width: 1440, height: 900 });
    await page.getByRole("button", { name: "Expand all", exact: true }).click();
    await expect(page.locator('.react-flow__node[data-id^="point:"]')).toHaveCount(15);
    const icons = await page.locator(".react-flow__node").evaluateAll((els) =>
      els.map((el) => ({ id: el.getAttribute("data-id") ?? "", icons: Array.from(el.querySelectorAll(".gicon")).map((g) => ({ name: g.getAttribute("data-icon"), drawn: g.querySelectorAll("svg path, svg rect, svg circle").length > 0, hidden: g.getAttribute("aria-hidden") })) })));
    const byId = new Map(icons.map((n) => [n.id, n.icons]));
    const one = (id: string) => {
      const found = byId.get(id);
      expect(found, `${id} is drawn`).toBeDefined();
      expect(found, `${id} has ONE icon`).toHaveLength(1);
      expect(found![0].drawn, `${id}'s icon is drawn`).toBe(true);
      expect(found![0].hidden, `${id}'s icon is decoration`).toBe("true");
      return found![0].name;
    };
    expect.soft(one(nid.source(SMALL.alpha)), "OPC UA").toBe("protoOpcua");
    expect.soft(one(nid.source(SMALL.bravo)), "Modbus").toBe("protoModbus");
    expect.soft(one(nid.source(SMALL.charlie)), "OPC UA").toBe("protoOpcua");
    expect.soft(one(nid.source(SMALL.delta)), "Simulator").toBe("protoSimulator");
    expect.soft(one(nid.asset(SMALL.hall)), "no chosen icon: the kind's (generic)").toBe("kindGeneric");
    expect.soft(one(nid.asset(SMALL.rack)), "the chosen Rack icon wins over the kind's").toBe("kindRack");
    expect.soft(one("unid:10.20.0.99:502"), "an unidentified service").toBe("sources");
    for (const [source, key] of [[SMALL.alpha, SMALL_GROUPS.lvp01], [SMALL.alpha, SMALL_GROUPS.lvp02], [SMALL.bravo, SMALL_GROUPS.rackB], [SMALL.delta, SMALL_GROUPS.simD]] as const) {
      expect.soft(one(nid.cluster(source, key)), `group ${key}`).toBe("layers");
    }
    const METRIC: Record<string, string> = {
      active_power_kw: "rate", reactive_power_kvar: "rate", apparent_power_kva: "rate", energy_kwh: "energy", voltage_v: "metricVoltage", current_a: "metricCurrent",
    };
    const points = model.sources.flatMap((s) => [...s.ungrouped, ...s.clusters.flatMap((c) => c.points)]);
    expect(points.length).toBe(15);
    const seen = new Set<string>();
    for (const p of points) {
      const want = METRIC[p.mapped_metric ?? p.suggestion.metric] ?? "metricOther";
      seen.add(want);
      expect.soft(one(nid.point(p.id)), `point ${p.name} (${p.mapped_metric ?? p.suggestion.metric})`).toBe(want);
    }
    expect(seen.size, "the points use several different drawings").toBeGreaterThanOrEqual(4);

    await test.step("Find's options carry an icon too (the same drawing as the node)", async () => {
      await bar(page).getByRole("button", { name: "Find", exact: true }).click();
      await findField(page).pressSequentially("rack");
      const options = findOptions(page);
      await expect(options.first()).toBeVisible();
      const counts = await options.evaluateAll((els) => els.map((el) => ({ text: (el.textContent ?? "").trim(), svgs: el.querySelectorAll("svg").length })));
      expect(counts.length, "Find has results for rack").toBeGreaterThan(0);
      for (const c of counts) expect.soft(c.svgs, `"${c.text}" has an icon`).toBeGreaterThanOrEqual(1);
      const rackPaths = await nodeEl(page, nid.asset(SMALL.rack)).locator(".gicon svg").innerHTML();
      const optionPaths = await options.filter({ hasText: SMALL_NAMES.rack }).first().locator("svg").first().innerHTML();
      expect(optionPaths, "the Rack's option draws the Rack's icon").toBe(rackPaths);
      await page.keyboard.press("Escape");
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W12c: the last value of a mapped point", () => {
  const MAPPED = nid.point(SMALL.alphaMapped);
  const PLAIN = nid.point(SMALL.alphaPlain);
  const MAPPING = 9_000_501; // the mapping id graphModel.ts gives LVP01 kW

  test("after the dwell the card says '12.40 kW, 3 s ago' and the age keeps counting; one read per hover, the node's aria-describedby is restored, and the card goes when the pointer leaves", async ({ page }) => {
    test.setTimeout(150_000);
    const stub = await arrive(page, smallModel(), { width: 1440, height: 900 });
    await openAlpha(page);
    const before = await describedBy(page, MAPPED);
    expect(before, "React Flow describes the node itself").toBeTruthy();
    const moved = await hover(page, MAPPED);
    const tip = tooltip(page);
    await expect(tip).toBeVisible();
    await expect(tip).toHaveText(/^12\.40 kW, 3 s ago$/);
    expect(stub.latest.length, "one read").toBe(1);
    expect(stub.latest[0].id, "of the point's mapping").toBe(MAPPING);
    expect(stub.latest[0].at - moved, `the read waited for the ${DWELL_MS} ms dwell`).toBeGreaterThanOrEqual(DWELL_MS - 60);
    const tipId = await tip.getAttribute("id");
    expect(tipId).toBeTruthy();
    const during = await describedBy(page, MAPPED);
    expect(during, "the node keeps its own description and gains the card's").toContain(before!);
    expect(during).toContain(tipId!);

    await test.step("the age keeps counting without a new read", async () => {
      await expect(tip).toHaveText(/^12\.40 kW, ([4-9]|[1-9]\d) s ago$/, { timeout: 8_000 });
      expect(stub.latest.length, "still one read").toBe(1);
    });
    await test.step("the card lies next to the node, inside the window, not over it", async () => {
      const [t, n] = [await boxOf(tip, "the card"), await boxOf(nodeEl(page, MAPPED), "the node")];
      expect(inside(t, { x: 0, y: 0, width: 1440, height: 900 }), "inside the window").toBe(true);
      expect(overlap(t, n), "and not on the node").toBe(false);
    });
    await test.step("the pointer leaving takes it away and gives the description back", async () => {
      await away(page);
      await expect(tooltip(page)).toHaveCount(0);
      expect(await describedBy(page, MAPPED), "aria-describedby is what it was before").toBe(before);
    });
  });

  for (const [what, over, text] of [
    ["stale", { stale: true, age_seconds: 190 }, /^12\.40 kW, 3 min ago, stale$/],
    ["a bad quality", { quality: 1 }, /^12\.40 kW, 3 s ago, bad reading$/],
    ["no reading yet", { value: null, ts: null, quality: null, age_seconds: null }, /^No reading yet$/],
  ] as [string, Partial<ApiLatest>, RegExp][]) {
    test(`a reading that is ${what} says so in words`, async ({ page }) => {
      test.setTimeout(120_000);
      const stub = await arrive(page, smallModel(), { width: 1440, height: 900 });
      stub.answer = (id) => ({ status: 200, body: latestBody(id, over) });
      await openAlpha(page);
      await hover(page, MAPPED);
      await expect(tooltip(page)).toHaveText(text);
    });
  }

  // The collector writes a failed read as a row WITH a time, value NULL and quality 1: it must not read as a point that was never polled.
  test("a failed read (a row with a time and no value, quality 1) says No value and bad reading, never No reading yet", async ({ page }) => {
    test.setTimeout(120_000);
    const stub = await arrive(page, smallModel(), { width: 1440, height: 900 });
    stub.answer = (id) => ({ status: 200, body: latestBody(id, { value: null, quality: 1, age_seconds: 4 }) });
    await openAlpha(page);
    await hover(page, MAPPED);
    await expect(tooltip(page)).toHaveText(/^No value, \d+ s ago, bad reading$/);
    await expect(tooltip(page)).not.toContainText("No reading yet");
    await expect(tooltip(page), "the bad tone").toHaveClass(/gtip-bad/);
    expect(stub.latest.length, "one read").toBe(1);
  });

  test("a right-click on the point with the card showing takes the card away, and ONE Escape closes the menu only", async ({ page }) => {
    test.setTimeout(150_000);
    await arrive(page, smallModel(), { width: 1440, height: 900 });
    await openAlpha(page);
    const before = await describedBy(page, MAPPED);
    await hover(page, MAPPED);
    await expect(tooltip(page)).toBeVisible();
    await titleOf(page, MAPPED).click({ button: "right" });
    const menu = page.getByRole("menu", { name: /^Actions for / });
    await expect(menu, "the point's menu opens").toBeVisible();
    await expect(tooltip(page), "the card steps aside: it would cover the menu").toHaveCount(0);
    expect(await describedBy(page, MAPPED), "and its id is off the node again").toBe(before);
    await page.keyboard.press("Escape");
    await expect(menu, "one Escape closes the menu").toHaveCount(0);
    expect(await focusedNodeId(page), "and the focus is back on the node").toBe(MAPPED);
  });

  test("a read that fails says so once and does not retry; the next hover tries again", async ({ page }) => {
    test.setTimeout(120_000);
    const stub = await arrive(page, smallModel(), { width: 1440, height: 900 });
    stub.failing = true;
    stub.answer = () => ({ status: 500, body: { detail: "boom" } });
    await openAlpha(page);
    await hover(page, MAPPED);
    await expect(tooltip(page)).toHaveText("Could not read the value");
    await page.waitForTimeout(1_500);
    expect(stub.latest.length, "no retry").toBe(1);
    await away(page);
    await expect(tooltip(page)).toHaveCount(0);
    stub.answer = (id) => ({ status: 200, body: latestBody(id) }); // (`failing` stays set: the first read's console error is expected)
    await hover(page, MAPPED);
    await expect(tooltip(page)).toHaveText(/^12\.40 kW, \d+ s ago$/);
    expect(stub.latest.length, "the next hover asked again").toBe(2);
  });

  test("an unmapped point shows no card and asks for nothing", async ({ page }) => {
    test.setTimeout(120_000);
    const stub = await arrive(page, smallModel(), { width: 1440, height: 900 });
    await openAlpha(page);
    await hover(page, PLAIN);
    await page.waitForTimeout(DWELL_MS + 700);
    await expect(tooltip(page)).toHaveCount(0);
    expect(stub.latest, "no read").toEqual([]);
  });

  test("Escape hides the card, a wheel zoom hides it, and a short pass over the node shows nothing", async ({ page }) => {
    test.setTimeout(150_000);
    const stub = await arrive(page, smallModel(), { width: 1440, height: 900 });
    await openAlpha(page);
    await test.step("Escape", async () => {
      await hover(page, MAPPED);
      await expect(tooltip(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(tooltip(page)).toHaveCount(0);
      await away(page);
    });
    await test.step("a wheel zoom (no scroll event comes with it)", async () => {
      await hover(page, MAPPED);
      await expect(tooltip(page)).toBeVisible();
      await page.mouse.wheel(0, -120);
      await expect(tooltip(page)).toHaveCount(0);
      await away(page);
      await cameraStill(page);
    });
    await test.step("a pass shorter than the dwell shows nothing and asks nothing", async () => {
      const asked = stub.latest.length;
      await hover(page, MAPPED);
      await away(page);
      await page.waitForTimeout(DWELL_MS + 400);
      await expect(tooltip(page)).toHaveCount(0);
      expect(stub.latest.length, "no read for a pass").toBe(asked);
    });
  });

  test("the keyboard focus shows it too (arrow keys to the mapped point) and it goes when the focus leaves", async ({ page }) => {
    test.setTimeout(150_000);
    const stub = await arrive(page, smallModel(), { width: 1440, height: 900 });
    const [alpha, lvp01] = [nid.source(SMALL.alpha), nid.cluster(SMALL.alpha, SMALL_GROUPS.lvp01)];
    const spot = await emptySpot(page);
    await page.mouse.click(spot.x, spot.y);
    await page.keyboard.press("Tab");
    if ((await focusedNodeId(page)) !== alpha) await focusQuietly(nodeEl(page, alpha));
    await page.keyboard.press("Enter"); // opens the source
    await expect(nodeEl(page, lvp01)).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => focusedNodeId(page)).toBe(lvp01);
    await page.keyboard.press("Enter"); // opens the group
    await expect(nodeEl(page, MAPPED)).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => focusedNodeId(page), { message: "the arrow lands on the mapped point" }).toBe(MAPPED);
    await expect(tooltip(page), "the focus shows the card after the dwell").toHaveText(/^12\.40 kW, \d+ s ago$/);
    expect(stub.latest.length, "one read").toBe(1);
    expect(await describedBy(page, MAPPED)).toContain((await tooltip(page).getAttribute("id"))!);
    await page.keyboard.press("ArrowLeft"); // back to the group
    await expect.poll(() => focusedNodeId(page)).toBe(lvp01);
    await expect(tooltip(page), "the focus moved to a node with no value").toHaveCount(0);
  });

  test("a role without assets.view asks for nothing and shows no card (the graph, the bar and the hover highlight still work)", async ({ page }) => {
    test.setTimeout(120_000);
    const stub = await arrive(page, smallModel(), { width: 1440, height: 900, permissions: ["discovery.view"] });
    await openAlpha(page);
    await hover(page, MAPPED);
    await page.waitForTimeout(DWELL_MS + 800);
    await expect(tooltip(page)).toHaveCount(0);
    expect(stub.latest, "no read at all").toEqual([]);
    await expect(nodeEl(page, MAPPED), "the path highlight still lights the hovered node").toHaveClass(/lit/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W12c: light and dark", () => {
  /** The contrast ratio of an element's text against what it stands on (the nearest opaque backgrounds, blended), measured in the page. */
  const contrastOf = (target: Locator): Promise<number> =>
    target.evaluate((el) => {
      const parse = (css: string): [number, number, number, number] => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = css;
        context.fillRect(0, 0, 1, 1);
        const d = context.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
      };
      const over = (top: [number, number, number, number], under: [number, number, number, number]): [number, number, number, number] => {
        const a = top[3] + under[3] * (1 - top[3]);
        if (a === 0) return [0, 0, 0, 0];
        return [0, 1, 2].map((i) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a) as [number, number, number, number];
      };
      let opacity = 1;
      const layers: [number, number, number, number][] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const style = getComputedStyle(e);
        opacity *= Number(style.opacity);
        const bg = parse(style.backgroundColor);
        if (bg[3] > 0) layers.push(bg);
        if (bg[3] >= 1) break;
      }
      let background: [number, number, number, number] = [255, 255, 255, 1];
      for (const layer of layers.reverse()) background = over(layer, background);
      const own = parse(getComputedStyle(el).color);
      const text = over([own[0], own[1], own[2], own[3] * opacity], background);
      const lum = (c: number[]) => [0, 1, 2].map((i) => { const v = c[i] / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
      const [l1, l2] = [lum(text), lum(background)].sort((a, b) => b - a);
      return (l1 + 0.05) / (l2 + 0.05);
    });

  for (const mode of ["light", "dark"] as const) {
    test(`${mode}: the bar, the source card, the bubble and the value card read well (4.5:1) and nothing scrolls sideways`, async ({ page }) => {
      test.setTimeout(150_000);
      const stub = await arrive(page, smallModel(), { width: 1024, height: 700, mode });
      await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
      stub.answer = (id) => ({ status: 200, body: latestBody(id) });
      const checks: [string, Locator][] = [
        ["a chip's number", bar(page).locator(".gbar-chip-num").first()],
        ["Find", barButton(page, "Find").locator(".gbar-lbl, svg").first()],
        ["the card's title", nodeEl(page, nid.source(SMALL.alpha)).locator(".gsrc-title")],
        ["the card's protocol line", nodeEl(page, nid.source(SMALL.alpha)).locator(".gsrc-sub")],
        ["the card's status line", nodeEl(page, nid.source(SMALL.alpha)).locator(".gsrc-status")],
        ["the card's mapped words", nodeEl(page, nid.source(SMALL.alpha)).locator(".gsrc-words")],
        ["the card's Details button", nodeEl(page, nid.source(SMALL.alpha)).getByRole("button", { name: `Details for ${SMALL_NAMES.alpha}`, exact: true })],
        ["the card's last-seen line", nodeEl(page, nid.source(SMALL.alpha)).locator(".gsrc-seen")],
      ];
      for (const [what, loc] of checks) {
        const ratio = await contrastOf(loc);
        measured(`${mode}: ${what}`, Math.round(ratio * 10) / 10);
        expect.soft(ratio, `${mode}: ${what} has a contrast of ${ratio.toFixed(1)}`).toBeGreaterThanOrEqual(4.5);
      }
      await shortcutsButton(page).click();
      const bubble = shortcutsBubble(page);
      await expect(bubble).toBeVisible();
      for (const [what, loc] of [["the bubble's titles", bubble.locator(".gkeys-title").first()], ["its words", bubble.locator(".gkeys-what").first()], ["a key cap", bubble.locator(".gkeys-key").first()]] as [string, Locator][]) {
        const ratio = await contrastOf(loc);
        measured(`${mode}: ${what}`, Math.round(ratio * 10) / 10);
        expect.soft(ratio, `${mode}: ${what} has a contrast of ${ratio.toFixed(1)}`).toBeGreaterThanOrEqual(4.5);
      }
      await page.keyboard.press("Escape");

      await openAlpha(page);
      const tones: [string, Partial<ApiLatest>][] = [["fresh", {}], ["stale", { stale: true }], ["bad", { quality: 1 }]];
      for (const [tone, over] of tones) {
        stub.answer = (id) => ({ status: 200, body: latestBody(id, over) });
        await hover(page, nid.point(SMALL.alphaMapped));
        await expect(tooltip(page)).toBeVisible();
        const ratio = await contrastOf(tooltip(page).locator(".gtip-text"));
        measured(`${mode}: the value card (${tone})`, Math.round(ratio * 10) / 10);
        expect.soft(ratio, `${mode}: the ${tone} value card has a contrast of ${ratio.toFixed(1)}`).toBeGreaterThanOrEqual(4.5);
        await away(page);
        await expect(tooltip(page)).toHaveCount(0);
      }
      expectSound(await readBar(page), `${mode} at 1024`);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The real stack: the one case that writes (a role and an account, removed again)

interface ApiRole { id: number; name: string; builtin: boolean }
interface ApiUser { id: number; username: string }
const READER_ROLE = "w12c-reader-role"; // discovery.view only: no assets.view
const READER = { username: "w12c-reader", password: "w12c-reader-pass", role: READER_ROLE };

async function as<T>(browser: Browser, who: { username: string; password: string } | null, use: (request: APIRequestContext) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    if (who) {
      const login = await context.request.post("/api/login", { data: { username: who.username, password: who.password } });
      expect(login.ok(), `${who.username} signs in: ${login.status()} ${await login.text()}`).toBe(true);
    }
    return await use(context.request);
  } finally {
    await context.close();
  }
}
async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}
/** Every account whose name starts with w12c-, then every custom role that does (a role an account holds cannot be deleted). */
async function removeAccounts(request: APIRequestContext): Promise<void> {
  for (const user of (await json<ApiUser[]>(request, "/api/users")).filter((u) => u.username.startsWith("w12c-"))) {
    const gone = await request.delete(`/api/users/${user.id}`);
    expect([204, 404], `deleting ${user.username}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
  for (const role of (await json<ApiRole[]>(request, "/api/roles")).filter((r) => !r.builtin && r.name.toLowerCase().startsWith("w12c-"))) {
    const gone = await request.delete(`/api/roles/${role.id}`);
    expect([204, 404], `deleting the role ${role.name}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
}

test.describe("W12c: the real route", () => {
  test.beforeAll(async ({ browser }) => {
    await as(browser, ADMIN, removeAccounts); // an earlier run that stopped half way
  });
  test.afterAll(async ({ browser }) => {
    await as(browser, ADMIN, removeAccounts);
  });

  test("GET /api/mappings/{id}/latest is 200 for the administrator, 404 for an unknown mapping, 401 signed out and 403 without assets.view; the graph's assets carry icon and kind_icon", async ({ browser }) => {
    test.setTimeout(120_000);
    interface Graph { assets: { id: number; icon?: unknown; kind_icon?: unknown }[]; sources: { clusters: { points: { mapping_id: number | null }[] }[]; ungrouped: { mapping_id: number | null }[] }[] }
    const graph = await as(browser, ADMIN, (request) => json<Graph>(request, "/api/discovery/graph"));
    const mapped = graph.sources.flatMap((s) => [...s.ungrouped, ...s.clusters.flatMap((c) => c.points)]).find((p) => p.mapping_id !== null);
    expect(mapped, "the stack holds a mapped point (discovery.spec maps the OPC UA simulator's sixty)").toBeDefined();
    const id = mapped!.mapping_id!;

    await test.step("the graph's assets carry icon and kind_icon", async () => {
      expect(graph.assets.length, "the stack has assets").toBeGreaterThan(0);
      for (const asset of graph.assets) {
        expect(Object.keys(asset), `asset ${asset.id} carries both keys`).toEqual(expect.arrayContaining(["icon", "kind_icon"]));
        expect(["string", "object"], `icon is a string or null`).toContain(typeof asset.icon);
        expect(["string", "object"], `kind_icon is a string or null`).toContain(typeof asset.kind_icon);
      }
    });

    await test.step("the administrator reads a mapping's last value", async () => {
      await as(browser, ADMIN, async (request) => {
        const answer = await request.get(`/api/mappings/${id}/latest`);
        expect(answer.status(), await answer.text()).toBe(200);
        const body = (await answer.json()) as ApiLatest;
        expect(Object.keys(body).sort()).toEqual(["age_seconds", "mapping_id", "quality", "stale", "ts", "unit", "value"]);
        expect(body.mapping_id).toBe(id);
        expect(typeof body.stale).toBe("boolean");
        expect(typeof body.unit).toBe("string");
        // No row at all (no time): everything else is null. A row has a time, a quality and an age; its value is null for a failed read (quality 1).
        if (body.ts === null) expect([body.value, body.quality, body.age_seconds], "no reading: the rest is null too").toEqual([null, null, null]);
        else {
          if (body.value !== null) expect(typeof body.value).toBe("number");
          expect(typeof body.quality, "a reading has a quality").toBe("number");
          expect(body.age_seconds, "and an age from the database's clock").toBeGreaterThanOrEqual(0);
          expect(typeof body.ts).toBe("string");
        }
        const unknown = await request.get("/api/mappings/2147483647/latest");
        expect(unknown.status(), "an unknown mapping").toBe(404);
      });
    });
    await test.step("signed out is 401", async () => {
      await as(browser, null, async (request) => {
        expect((await request.get(`/api/mappings/${id}/latest`)).status()).toBe(401);
      });
    });
    await test.step("a role with discovery.view only (no assets.view) is refused with 403", async () => {
      await as(browser, ADMIN, async (request) => {
        await removeAccounts(request);
        const role = await request.post("/api/roles", { data: { name: READER_ROLE, description: "made by w12c.spec.ts", permissions: ["discovery.view"] } });
        expect(role.status(), `creating the role: ${await role.text()}`).toBe(201);
        const user = await request.post("/api/users", { data: { username: READER.username, password: READER.password, role: READER.role } });
        expect(user.status(), `creating the account: ${await user.text()}`).toBe(201);
      });
      try {
        await as(browser, READER, async (request) => {
          expect((await request.get("/api/discovery/graph")).status(), "the reader reads the graph").toBe(200);
          const refused = await request.get(`/api/mappings/${id}/latest`);
          expect(refused.status(), `without assets.view: ${await refused.text()}`).toBe(403);
        });
      } finally {
        await as(browser, ADMIN, removeAccounts);
      }
    });
  });
});
