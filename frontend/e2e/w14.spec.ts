import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { answer, defs, type ShowcaseWidget, type WidgetRequest } from "./w13Showcase";
import { node as nid, SMALL, smallModel, type ApiGraphModel } from "./graphModel";
import { markGuideSeen } from "./shell";

test.beforeEach(({ page }) => markGuideSeen(page)); // w27: the dashboard guide is not what this spec looks at

// W14 (six small polish items after w12c and w13): P1 the labels of a bar chart wrap instead of colliding, P2 the Discovery source card shows a long name on two lines, P3 the Discovery bar keeps
// the words of its counts longer and an ON control does not look like the keyboard focus, P4 the Details table reads plainly in a wider drawer, P5 Details offers a link to Tariffs next to "no rate",
// P6 no sideways scroll at 800 px with the sidebar open. Admin `admin` / `correct-horse`, the account the earlier projects use.
//
// IT WRITES NEXT TO NOTHING and needs no readings from the stack. beforeAll saves ONE dashboard through the API (`w14 <run>`, the 15 widgets of e2e/w13Showcase.ts, on the first six real asset ids) and
// the dashboard cases answer `POST /api/widget-data` through `page.route` from that showcase; the Discovery cases answer `GET /api/discovery/graph` (and the layout's PUT and DELETE) from a generated
// model (e2e/graphModel.ts, synthetic ids from 9,000,000 up). Any other write the page tries is refused with a 500 and fails the case (the look's save, the sign-in and the widget query are the only
// ones allowed). The look is the admin's saved preference, set through PUT /api/me/preferences before a page opens; afterAll deletes the dashboard, also after a failed case, and puts the look back
// to Light and Navy and gold. The ONE case that makes anything else is P5's second: a role and an account (names start `w14-`) to see Details for an account without tariffs.view; both are removed
// again (beforeAll and afterAll sweep what a failed run left, users first).
//
// Locators. A dashboard card is the `region` named by its title, matched with `exact: true`; the Details drawer is the `dialog` named `Details: <title>`; a Discovery node is
// `.react-flow__node[data-id=...]`. Playwright matches a name by case-insensitive SUBSTRING, so buttons are looked up with `exact: true`.
//
// The cases:
//   P1  the "Energy per asset" card of the showcase at 1024, 1440 and 1920 px, light and dark: it renders with its text alternative and a canvas, its chart is at least 140 px tall and the page does
//       not scroll sideways. The geometry of the labels is proven by barAxis.ssr.test.ts (the real ECharts, drawn to SVG): a canvas cannot be read here.
//   P2  the source card with a 12-, a 30- and a 70-character name (mocked graph), at 1440 x 900 and 1024 x 640, light and dark: no card is taller than the 136 px that SOURCE_H keeps, no two cards
//       overlap, the 12-character name is whole, the title is at most TWO lines tall (a clamp: the box is 36 px) and the 70-character name is cut there (Chromium reports the whole text as the
//       scrollHeight of a clamped box, so "cut" is scrollHeight > clientHeight), the full name stays in the title attribute; by keyboard the route Tab, Tab, Enter from the card's fold reaches
//       Details and the panel's heading is the FULL name, with the focus on it.
//   P3  the bar's chips and Snap to grid. A set WITHOUT the credentials chip (the normal family) at the 1148 px bar of a 1440 px window with the sidebar open: three chips, drawn whole, with their
//       words. A set WITH it (the wide family): four chips, drawn whole, numbers only, at 1148 and at 744 (a 1024 px window with the sidebar open). Snap to grid: ON and not focused has an inset
//       box-shadow, no outline and the border of an OFF button; ON and focused by keyboard has the outline too; at 1440 and 1024 px, light and dark. No pixel threshold of a width tier is pinned
//       beyond those two bars (the stylesheet's comment table has the rest).
//   P4  Details of "Power by rack" (a metric series), "Energy per hour" (an energy series) and "Cost this month" (a table) at 1440 px, light and dark: the drawer is 560 px wide, the table has the
//       headings of the plain layout, the box around it does not scroll sideways, and the Highest cell ends with "bucket from <time>" (a metric series to the second, an hourly one to the minute).
//   P5  the administrator sees the link "Set a rate in Tariffs" in the Details of "Cost today" (a cost with no rate), its href ends with /tariffs, and Tab, Tab, Tab, Enter lands on Tariffs; an
//       account whose role holds dashboards.view and assets.view but not tariffs.view sees the no-rate sentence and no link.
//   P6  at 800 x 600 and 1024 x 640, sidebar open and minimized, on the Assets Tree, Dashboards, Settings and Discovery (mocked graph): the document does not scroll sideways at all.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";

interface Look { mode: "light" | "dark"; theme: string }
interface Box { x: number; y: number; width: number; height: number }

const LIGHT: Look = { mode: "light", theme: "navy-gold" };
const DARK: Look = { mode: "dark", theme: "desert-gold" };
const LOOKS: readonly Look[] = [LIGHT, DARK];
const RUN = Date.now().toString(36);
const DASHBOARD = `w14 ${RUN}`;
/** What an earlier run that stopped half way may have left behind (the gallery's "W14 showcase" starts with a capital and is not matched). */
const LEFTOVER = /^w14 [0-9a-z]+$/;

/** lib/graph.ts SOURCE_H: the room the layout keeps for a source card. */
const SOURCE_H = 136;
/** The line height of the card's title (graph-source-card.css), and the two lines its clamp allows. */
const TITLE_LINE = 18;

// ---------------------------------------------------------------------------------------------------------------------------------
// The dashboard, the accounts and the mock

let dashboardId = 0;
let widgets: ShowcaseWidget[] = [];

/** Runs `use` with the request context of a fresh browser context in which the admin is signed in. */
async function asAdmin<T>(browser: Browser, use: (request: APIRequestContext) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    const login = await context.request.post("/api/login", { data: ADMIN });
    expect(login.ok(), "the admin signs in").toBe(true);
    return await use(context.request);
  } finally {
    await context.close();
  }
}

interface ApiRole { id: number; name: string; builtin: boolean }
interface ApiUser { id: number; username: string }
const READER_ROLE = "w14-reader-role"; // dashboards.view and assets.view: no tariffs.view
const READER = { username: "w14-reader", password: "w14-reader-pass" };

async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}
/** Every account whose name starts with w14-, then every custom role that does (a role an account holds cannot be deleted). */
async function removeAccounts(request: APIRequestContext): Promise<void> {
  for (const user of (await json<ApiUser[]>(request, "/api/users")).filter((u) => u.username.startsWith("w14-"))) {
    const gone = await request.delete(`/api/users/${user.id}`);
    expect([204, 404], `deleting ${user.username}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
  for (const role of (await json<ApiRole[]>(request, "/api/roles")).filter((r) => !r.builtin && r.name.toLowerCase().startsWith("w14-"))) {
    const gone = await request.delete(`/api/roles/${role.id}`);
    expect([204, 404], `deleting the role ${role.name}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
}

test.beforeAll(async ({ browser }) => {
  await asAdmin(browser, async (request) => {
    const prefs = await request.put("/api/me/preferences", { data: LIGHT });
    expect(prefs.ok(), `starting from the light look: ${prefs.status()} ${await prefs.text()}`).toBe(true);
    await removeAccounts(request); // an earlier run that stopped half way

    const listed = (await (await request.get("/api/dashboards")).json()) as { id: number; name: string }[];
    for (const old of listed.filter((d) => LEFTOVER.test(d.name))) await request.delete(`/api/dashboards/${old.id}`);

    const assets = (await (await request.get("/api/assets")).json()) as { id: number }[];
    const assetIds = assets.map((a) => a.id).sort((a, b) => a - b).slice(0, 6);
    expect(assetIds.length, "the stack has six assets to put the showcase widgets on").toBe(6);
    widgets = defs(assetIds);

    const created = await request.post("/api/dashboards", { data: { name: DASHBOARD, range: "24h" } });
    expect(created.ok(), `creating the dashboard: ${created.status()} ${await created.text()}`).toBe(true);
    const made = (await created.json()) as { id: number; updated_at: string };
    dashboardId = made.id;
    const body = { name: DASHBOARD, range: "24h", updated_at: made.updated_at, widgets: widgets.map(({ title, type, x, y, w, h, config }) => ({ title, type, x, y, w, h, config })) };
    const saved = await request.put(`/api/dashboards/${dashboardId}`, { data: body });
    expect(saved.ok(), `saving the 15 widgets: ${saved.status()} ${await saved.text()}`).toBe(true);
  });
});

test.afterAll(async ({ browser }) => {
  await asAdmin(browser, async (request) => {
    await request.put("/api/me/preferences", { data: LIGHT });
    if (dashboardId) await request.delete(`/api/dashboards/${dashboardId}`);
    await removeAccounts(request);
  });
});

interface Stub {
  /** Console errors and uncaught exceptions of the page. */
  errors: string[];
  /** Writes the spec does not expect; the page got a 500 for each. */
  stray: string[];
  /** Widget queries no showcase widget answers (the real server got them). */
  unmatched: string[];
  /** How many times the page read the generated graph: 0 would mean it never reached it. */
  reads: number;
}
let current: Stub | null = null;

test.afterEach(() => {
  const stub = current;
  current = null;
  expect(stub?.stray ?? [], "the spec writes nothing to the stack: these requests were refused").toEqual([]);
  expect(stub?.errors ?? [], "the page logged no console error and no exception").toEqual([]);
});

interface Opening {
  /** The account that signs in (the administrator by default). */
  who?: { username: string; password: string };
  /** The graph Discovery is shown (its GET and the layout's PUT and DELETE are answered here); with none, those routes are the stack's. */
  graph?: ApiGraphModel;
}

/** Signs in, answers the widget query from the showcase and the graph from the model, refuses every other write, and listens for errors. */
async function prepare(page: Page, { who = ADMIN, graph }: Opening = {}): Promise<Stub> {
  const stub: Stub = { errors: [], stray: [], unmatched: [], reads: 0 };
  current = stub;
  page.on("console", (message) => {
    if (message.type() !== "error" || /net::ERR_ABORTED/.test(message.text())) return;
    const url = message.location().url;
    if (/\/api\/me$/.test(url) && /401/.test(message.text())) return; // the sign-in page asks before anyone is signed in; these cases sign in first
    stub.errors.push(`console: ${message.text()} (${url})`);
  });
  page.on("pageerror", (error) => stub.errors.push(`pageerror: ${error.message}`));
  // Registered FIRST, so it is asked last: a write that is not the sign-in, the look's save or the widget query is refused and written down.
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    if (method === "GET" || method === "HEAD") return route.fallback();
    if (path === "/api/login" || path === "/api/widget-data" || (method === "PUT" && path === "/api/me/preferences")) return route.fallback();
    stub.stray.push(`${method} ${path}`);
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "w14: this spec writes nothing" }) });
  });
  await page.route((url) => url.pathname === "/api/widget-data", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as WidgetRequest;
    const data = answer(widgets, body);
    if (!data) {
      stub.unmatched.push(`${body.type} ${body.config.source} ${body.config.metric ?? ""} ${body.config.aggregation} [${body.config.assets.join(",")}]`);
      return route.fallback();
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });
  if (graph) {
    await page.route(/\/api\/discovery\/graph(\?.*)?$/, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      stub.reads++;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...graph, layout: {} }) });
    });
    await page.route(/\/api\/discovery\/layout(\?.*)?$/, async (route) => {
      const method = route.request().method();
      return method === "PUT" || method === "DELETE" ? route.fulfill({ status: 204 }) : route.fallback();
    });
  }
  const login = await page.request.post("/api/login", { data: who });
  expect(login.ok(), `signing in as ${who.username}: ${login.status()} ${await login.text()}`).toBe(true);
  return stub;
}

async function setLook(page: Page, look: Look): Promise<void> {
  const saved = await page.request.put("/api/me/preferences", { data: look });
  expect(saved.ok(), `storing ${JSON.stringify(look)}: ${saved.status()} ${await saved.text()}`).toBe(true);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Locators and small readings

const html = (page: Page) => page.locator("html");
const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const card = (page: Page, title: string) => page.getByRole("region", { name: title, exact: true });
const detailsButton = (page: Page, title: string) => card(page, title).getByRole("button", { name: `Details for ${title}`, exact: true });
const drawer = (page: Page, title: string) => page.getByRole("dialog", { name: `Details: ${title}`, exact: true });
const nodeEl = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const bar = (page: Page) => page.locator(".graph-bar");
const barButton = (page: Page, name: string) => bar(page).getByRole("button", { name, exact: true });
const isChart = (w: ShowcaseWidget) => w.type === "timeseries" || w.type === "bar";

const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const measured = (what: string, value: unknown) => {
  test.info().annotations.push({ type: "measure", description: `${what}: ${JSON.stringify(value)}` });
};
async function boxOf(target: Locator, what: string): Promise<Box> {
  const box = await target.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  return box!;
}
const overlap = (a: Box, b: Box) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
/** The sideways overflow of the document in px, and the element whose right edge reaches furthest (for the message of a failure). */
const sideways = (page: Page): Promise<{ over: number; widest: string }> =>
  page.evaluate(() => {
    const root = document.documentElement;
    let widest = "";
    let right = 0;
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > right) {
        right = r.right;
        widest = `${el.tagName.toLowerCase()}.${String(el.getAttribute("class") ?? "").slice(0, 40)} ends at ${Math.round(r.right)}`;
      }
    }
    return { over: root.scrollWidth - root.clientWidth, widest };
  });

/** Presses Tab from `from` until `target` has the focus (at most six presses), naming the way when it never does. */
async function tabTo(page: Page, from: Locator, target: Locator, what: string): Promise<void> {
  await from.focus();
  const path: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    path.push(await page.evaluate(() => {
      const el = document.activeElement;
      return el ? `${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 24)}"` : "nothing";
    }));
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  expect(false, `${what}: Tab did not reach it; the focus went ${path.join(" -> ")}`).toBe(true);
}

/** Opens the dashboard in `look` (the signed-in account's own when null) at `width` px and waits until every card has its data (and every chart its canvas). */
async function openDashboard(page: Page, stub: Stub, look: Look | null, width = 1440): Promise<void> {
  if (look) await setLook(page, look);
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`/dashboards/${dashboardId}`);
  if (look) {
    await expect(html(page)).toHaveAttribute("data-mode", look.mode);
    await expect(html(page)).toHaveAttribute("data-theme", look.theme);
  }
  await expect(heading1(page, DASHBOARD)).toBeVisible();
  for (const w of widgets) await expect(card(page, w.title).locator(".widget-body"), `${w.title} has its data`).toBeVisible();
  for (const w of widgets.filter(isChart)) await expect(card(page, w.title).locator("canvas").first(), `${w.title} has drawn its canvas`).toBeVisible();
  await settled(page);
  expect(stub.unmatched, "every widget query of the dashboard has a showcase answer").toEqual([]);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Discovery: the camera, the opening of a page, the sidebar

/** Resolves once the viewport has stopped moving (two reads 120 ms apart agree twice): Fit View glides. */
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
/** Opens Discovery and waits for the first node and for the camera to rest. */
async function openDiscovery(page: Page, stub: Stub): Promise<void> {
  await page.goto("/discovery");
  await expect(heading1(page, "Discovery")).toBeVisible();
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 60_000 });
  expect(stub.reads, "the page read the generated graph, not the stack's").toBeGreaterThan(0);
  await cameraStill(page);
}
/** The sidebar starts minimized in a window under 1180 px and expanded above it; a click on its toggle changes it. */
async function setSidebar(page: Page, state: "minimized" | "expanded"): Promise<void> {
  const shell = page.locator(".shell");
  if ((await shell.getAttribute("data-sidebar")) !== state) await page.getByRole("button", { name: state === "expanded" ? "Expand sidebar" : "Minimize sidebar", exact: true }).click();
  await expect(shell).toHaveAttribute("data-sidebar", state);
  await settled(page);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// P1: the labels of a bar chart

test.describe("P1: bar chart labels", () => {
  for (const look of LOOKS) {
    test(`${look.mode}: Energy per asset renders with its text alternative and a chart of at least 140 px, and the page does not scroll sideways, at 1024, 1440 and 1920 px`, async ({ page }) => {
      test.setTimeout(240_000);
      const stub = await prepare(page);
      for (const width of [1024, 1440, 1920]) {
        await test.step(`${width} px`, async () => {
          await openDashboard(page, stub, look, width);
          const energy = card(page, "Energy per asset");
          const chart = energy.locator('.widget-chart[role="img"]');
          await expect(chart, "the chart has its text alternative").toHaveAttribute("aria-label", /^Bar chart of 6 assets: Rack A01, Rack A02, UPS-1 output and 3 more\. Energy in kWh, Last 24 hours\./);
          await expect(energy.locator("canvas").first(), "and a canvas").toBeVisible();
          const box = await boxOf(chart, "the chart");
          measured(`${look.mode} ${width}px chart`, box);
          expect(box.height, `the chart is ${box.height}px high and needs at least 140px for its bars and its wrapped labels`).toBeGreaterThanOrEqual(140);
          expect(box.width, "the chart lies inside its card").toBeLessThanOrEqual((await boxOf(energy, "the card")).width);
          const spill = await sideways(page);
          expect(spill.over, `the page scrolls sideways by ${spill.over}px (${spill.widest})`).toBeLessThanOrEqual(0);
          await test.info().attach(`energy-per-asset-${look.mode}-${width}`, { body: await energy.screenshot(), contentType: "image/png" });
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// P2: the source card

const NAME_12 = "Plant Hall A";
const NAME_30 = "Modbus gateway north hall roof";
const NAME_70 = "Chiller plant 2 building management system south hall secondary loop A";
if (NAME_12.length !== 12 || NAME_30.length !== 30 || NAME_70.length !== 70) throw new Error("the three source names of P2 must be 12, 30 and 70 characters long");

/** smallModel() with its first three sources renamed to a 12-, a 30- and a 70-character name (none ends in " at host:port", so the card's title is the whole name). */
function namedModel(): ApiGraphModel {
  const model = smallModel();
  const [alpha, bravo, charlie] = model.sources;
  alpha.name = NAME_12;
  bravo.name = NAME_30;
  charlie.name = NAME_70;
  return model;
}

interface CardReading {
  id: string;
  /** offsetHeight: CSS px, whatever the zoom of the canvas. */
  height: number;
  rect: Box;
  text: string;
  titleAttr: string | null;
  /** The title's box (clientHeight) and its content (scrollHeight), in CSS px. */
  box: number;
  content: number;
}
const readCards = (page: Page): Promise<CardReading[]> =>
  page.locator(".gnode-source").evaluateAll((els) =>
    els.map((el) => {
      const title = el.querySelector<HTMLElement>(".gsrc-title");
      if (!title) throw new Error("a source card has no .gsrc-title");
      const r = el.getBoundingClientRect();
      return {
        id: el.closest(".react-flow__node")?.getAttribute("data-id") ?? "",
        height: (el as HTMLElement).offsetHeight,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        text: title.textContent ?? "",
        titleAttr: title.getAttribute("title"),
        box: title.clientHeight,
        content: title.scrollHeight,
      };
    }));

test.describe("P2: the source card", () => {
  const SIZES = [{ width: 1440, height: 900 }, { width: 1024, height: 640 }];
  for (const look of LOOKS) {
    for (const size of SIZES) {
      test(`${look.mode} at ${size.width} x ${size.height}: a 12-, a 30- and a 70-character name fit the card, no card is taller than ${SOURCE_H} px or meets another, and the keyboard reaches the full name`, async ({ page }) => {
        test.setTimeout(150_000);
        const stub = await prepare(page, { graph: namedModel() });
        await setLook(page, look);
        await page.setViewportSize(size);
        await openDiscovery(page, stub);
        await expect(html(page)).toHaveAttribute("data-mode", look.mode);
        await fitViewNow(page);

        const cards = await readCards(page);
        const byId = new Map(cards.map((c) => [c.id, c]));
        const [short, middle, long] = [nid.source(SMALL.alpha), nid.source(SMALL.bravo), nid.source(SMALL.charlie)].map((id) => {
          const found = byId.get(id);
          expect(found, `${id} is drawn`).toBeDefined();
          return found!;
        });
        measured(`${look.mode} ${size.width}: cards`, cards.map((c) => ({ id: c.id, height: c.height, box: c.box, content: c.content })));

        await test.step("no card is taller than the room SOURCE_H keeps, and no two cards overlap", async () => {
          expect(cards.length, "the four sources of the model").toBe(4);
          for (const c of cards) expect.soft(c.height, `${c.id} is ${c.height}px high and its room is ${SOURCE_H}px`).toBeLessThanOrEqual(SOURCE_H);
          for (const [i, a] of cards.entries()) {
            for (const b of cards.slice(i + 1)) expect.soft(overlap(a.rect, b.rect), `${a.id} and ${b.id} overlap`).toBe(false);
          }
        });

        await test.step("the 12-character name is whole, on one line", async () => {
          expect(short.text).toBe(NAME_12);
          expect(short.content, "nothing of it is cut").toBeLessThanOrEqual(short.box + 1);
          expect(short.box, "one line").toBeLessThanOrEqual(TITLE_LINE + 1);
        });
        await test.step("the 30-character name takes at most two lines", async () => {
          expect(middle.text).toBe(NAME_30);
          expect(middle.box, "a title box of two lines at most").toBeLessThanOrEqual(2 * TITLE_LINE + 1);
          expect(middle.titleAttr).toBe(NAME_30);
        });
        await test.step("the 70-character name is cut after two lines and keeps its full name in the title attribute", async () => {
          expect(long.text, "the full name is in the page").toBe(NAME_70);
          expect(long.titleAttr, "and in the title attribute").toBe(NAME_70);
          expect(long.box, `the title box is ${long.box}px: two lines of ${TITLE_LINE}px at most`).toBeLessThanOrEqual(2 * TITLE_LINE + 1);
          expect(long.content, "the rest is cut vertically (the content is taller than the box)").toBeGreaterThan(long.box);
        });

        await test.step("by keyboard: Tab from the fold reaches Details, Enter opens the panel, whose heading is the FULL name and holds the focus", async () => {
          const source = nodeEl(page, nid.source(SMALL.charlie));
          await tabTo(page, source.getByRole("button", { name: `Expand ${NAME_70}`, exact: true }), source.getByRole("button", { name: `Details for ${NAME_70}`, exact: true }), "the card's Details button");
          await page.keyboard.press("Enter");
          const panel = page.getByRole("complementary", { name: "Source details" });
          await expect(panel).toBeVisible();
          const name = panel.getByRole("heading", { level: 2, name: NAME_70, exact: true });
          await expect(name, "the panel's heading is the full name").toBeVisible();
          await expect(name, "and takes the focus when the panel opens").toBeFocused();
        });
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// P3: the Discovery bar

/** smallModel() without the source that needs credentials: three chips, no credentials chip (the normal family of chips). */
function normalModel(): ApiGraphModel {
  const model = smallModel();
  for (const source of model.sources) source.needs_credentials = false;
  return model;
}

interface ChipsReading {
  /** The bar's width in px. */
  bar: number;
  /** The chips row carries gbar-chips-wide (a credentials chip, or a four-digit count). */
  wide: boolean;
  chips: { title: string; whole: boolean; word: boolean }[];
}
const readChips = (page: Page): Promise<ChipsReading> =>
  page.evaluate(() => {
    const barEl = document.querySelector<HTMLElement>(".graph-bar");
    const group = barEl?.querySelector<HTMLElement>(".gbar-chips");
    if (!barEl || !group) throw new Error("the Discovery bar has no chips row");
    const g = group.getBoundingClientRect();
    return {
      bar: Math.round(barEl.getBoundingClientRect().width),
      wide: group.classList.contains("gbar-chips-wide"),
      chips: Array.from(barEl.querySelectorAll<HTMLElement>(".gbar-chip")).map((chip) => {
        const r = chip.getBoundingClientRect();
        const word = chip.querySelector<HTMLElement>(".gbar-chip-word");
        return {
          title: (chip.getAttribute("title") ?? "").trim(),
          // Drawn whole: inside the one row of the chips (a chip that does not fit is clipped out of it, never cut in half).
          whole: r.width > 1 && r.top >= g.top - 1 && r.bottom <= g.bottom + 1 && r.left >= g.left - 1 && r.right <= g.right + 1,
          word: !!word && getComputedStyle(word).display !== "none" && word.getBoundingClientRect().width > 1,
        };
      }),
    };
  });

/** The bar of a 1440 px window with the sidebar open is 1148 px wide, that of a 1024 px window with it open 744 px; the chips' tiers are measured against the bar, not the window. */
const expectBar = (reading: ChipsReading, want: number) =>
  expect(Math.abs(reading.bar - want), `the bar is ${reading.bar}px wide and this case needs the ${want}px bar`).toBeLessThanOrEqual(24);

interface SnapReading { pressed: string | null; border: string; shadow: string; outlineStyle: string; outlineWidth: number }
/** Waits for the button's transitions to finish (a colour that is still fading is not its state), then reads the look the state gives it. */
const readSnap = (snap: Locator): Promise<SnapReading> =>
  snap.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)));
    const s = getComputedStyle(el);
    return { pressed: el.getAttribute("aria-pressed"), border: `${s.borderTopColor} ${s.borderBottomColor}`, shadow: s.boxShadow, outlineStyle: s.outlineStyle, outlineWidth: parseFloat(s.outlineWidth) };
  });
/** Takes the focus and the pointer away from the button, so it shows only its state. */
async function release(page: Page, snap: Locator): Promise<void> {
  await snap.evaluate((el) => (el as HTMLElement).blur());
  await page.mouse.move(2, 2);
}

test.describe("P3: the Discovery bar", () => {
  for (const look of LOOKS) {
    test(`${look.mode}: a set without the credentials chip keeps the words of all three chips at the 1148 px bar of a 1440 px window`, async ({ page }) => {
      test.setTimeout(120_000);
      const stub = await prepare(page, { graph: normalModel() });
      await setLook(page, look);
      await page.setViewportSize({ width: 1440, height: 900 });
      await openDiscovery(page, stub);
      await setSidebar(page, "expanded");
      const reading = await readChips(page);
      measured(`${look.mode} normal chips`, reading);
      expectBar(reading, 1148);
      expect(reading.wide, "no credentials chip: the normal family").toBe(false);
      expect(reading.chips.map((c) => c.title), "three chips").toEqual([expect.stringMatching(/^\d+ sources?$/), expect.stringMatching(/^\d+ points?$/), expect.stringMatching(/^\d+ mapped$/)]);
      for (const chip of reading.chips) {
        expect.soft(chip.whole, `${chip.title}: drawn whole`).toBe(true);
        expect.soft(chip.word, `${chip.title}: its words are visible`).toBe(true);
      }
      await expect(bar(page).locator(".gbar-chip-word:visible")).toHaveCount(3);
    });

    test(`${look.mode}: a set with the credentials chip draws all four chips, numbers only, at the 1148 px and the 744 px bar`, async ({ page }) => {
      test.setTimeout(120_000);
      const stub = await prepare(page, { graph: smallModel() });
      await setLook(page, look);
      await page.setViewportSize({ width: 1440, height: 900 });
      await openDiscovery(page, stub);
      await setSidebar(page, "expanded");
      for (const [width, height, want] of [[1440, 900, 1148], [1024, 640, 744]] as const) {
        await test.step(`${width} px window, sidebar open: a ${want} px bar`, async () => {
          await page.setViewportSize({ width, height });
          await setSidebar(page, "expanded");
          const reading = await readChips(page);
          measured(`${look.mode} ${width} wide chips`, reading);
          expectBar(reading, want);
          expect(reading.wide, "the credentials chip: the wide family").toBe(true);
          expect(reading.chips, "all four chips are drawn").toHaveLength(4);
          expect(reading.chips[3].title, "the fourth is the credentials chip").toMatch(/^\d+ (needs|need) credentials$/);
          for (const chip of reading.chips) {
            expect.soft(chip.whole, `${chip.title}: drawn whole`).toBe(true);
            expect.soft(chip.word, `${chip.title}: numbers only`).toBe(false);
          }
        });
      }
    });

    for (const width of [1440, 1024]) {
      test(`${look.mode} at ${width} px: Snap to grid ON shows an inset line and no outline, its border is an OFF button's, and the keyboard focus adds the outline`, async ({ page }) => {
        test.setTimeout(120_000);
        const stub = await prepare(page, { graph: smallModel() });
        await setLook(page, look);
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 640 });
        await openDiscovery(page, stub);
        const snap = barButton(page, "Snap to grid");
        await expect(snap, "Snap to grid is in the bar").toBeVisible();

        let onBorder = "";
        await test.step("ON and not focused: the inset line, no outline", async () => {
          if ((await snap.getAttribute("aria-pressed")) !== "true") await snap.click();
          await expect(snap).toHaveAttribute("aria-pressed", "true");
          await release(page, snap);
          const on = await readSnap(snap);
          measured(`${look.mode} ${width} snap on`, on);
          expect(on.shadow, "an inset line at the foot").toContain("inset");
          expect(on.outlineStyle, "no outline: it is not the focus ring").toBe("none");
          onBorder = on.border;
        });

        await test.step("ON and focused by keyboard: the outline too, and the inset line stays", async () => {
          await barButton(page, "Find").focus();
          await page.keyboard.press("Tab");
          await expect(snap, "Tab from Find reaches Snap to grid").toBeFocused();
          const focused = await readSnap(snap);
          measured(`${look.mode} ${width} snap on and focused`, focused);
          expect(focused.outlineStyle, "the focus ring is drawn").not.toBe("none");
          expect(focused.outlineWidth, "and is 2px").toBeGreaterThanOrEqual(2);
          expect(focused.shadow, "the inset line stays").toContain("inset");
          expect(focused.border, "the border does not change with the focus").toBe(onBorder);
        });

        await test.step("OFF: the same border, no inset line", async () => {
          await page.keyboard.press("Space");
          await expect(snap).toHaveAttribute("aria-pressed", "false");
          await release(page, snap);
          const off = await readSnap(snap);
          measured(`${look.mode} ${width} snap off`, off);
          expect(off.border, "ON has the border of OFF: only the inset line and the fill say ON").toBe(onBorder);
          expect(off.shadow, "no inset line when off").toBe("none");
          expect(off.outlineStyle, "and no outline").toBe("none");
        });
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// P4: the Details table

const STAMP_SECONDS = "\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}";
const STAMP_MINUTES = "\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}";

interface DetailsCase {
  title: string;
  headings: (string | RegExp)[];
  /** The columns (0 = Asset) of Highest and Last bucket, and the time format of their sub-lines; null for a table with no figures column. */
  figures: { highest: number; last: number; stamp: string } | null;
}
const DETAILS: DetailsCase[] = [
  { title: "Power by rack", headings: ["Asset", "Lowest", "Highest", "Last bucket (average)"], figures: { highest: 2, last: 3, stamp: STAMP_SECONDS } },
  { title: "Energy per hour", headings: ["Asset", "Highest", /^Last bucket \(.+\)$/, "Total of the buckets shown"], figures: { highest: 1, last: 2, stamp: STAMP_MINUTES } },
  { title: "Cost this month", headings: ["Asset"], figures: null },
];

test.describe("P4: the Details table", () => {
  for (const look of LOOKS) {
    test(`${look.mode} at 1440 px: the drawer is 560 px wide, the table reads plainly, its box does not scroll sideways and Highest says which bucket`, async ({ page }) => {
      test.setTimeout(180_000);
      const stub = await prepare(page);
      await openDashboard(page, stub, look, 1440);
      for (const subject of DETAILS) {
        await test.step(subject.title, async () => {
          await detailsButton(page, subject.title).click();
          const dialog = drawer(page, subject.title);
          await expect(dialog).toBeVisible();
          const panel = await boxOf(dialog, "the drawer");
          expect(Math.abs(panel.width - 560), `the drawer is ${panel.width}px wide`).toBeLessThanOrEqual(1);

          const table = dialog.locator(".wd-table");
          await expect(table.getByRole("columnheader"), "the headings of the plain layout, with no 'Highest in the bucket from'").toHaveText(subject.headings);
          const wrap = dialog.locator(".wd-table-wrap");
          const spill = await wrap.evaluate((el) => el.scrollWidth - el.clientWidth);
          expect(spill, `the table's box scrolls sideways by ${spill}px`).toBeLessThanOrEqual(1);

          if (subject.figures) {
            const { highest, last, stamp } = subject.figures;
            const rows = table.locator("tbody tr");
            await expect(rows, "one row for each of the chart's three series").toHaveCount(3);
            for (let i = 0; i < 3; i++) {
              const row = rows.nth(i);
              const name = ((await row.locator("td").first().innerText()).split("\n")[0] ?? "").trim();
              await expect(row.locator("td").nth(highest).locator("small.wd-sub"), `${name}: the Highest cell says which bucket`).toHaveText(new RegExp(`^bucket from ${stamp}$`));
              await expect(row.locator("td").nth(highest).locator(".wd-fig").first(), `${name}: and starts with the figure`).toHaveText(/^~?[\d,]+\.\d{2} kWh?$/);
              await expect(row.locator("td").nth(last).locator("small.wd-sub"), `${name}: the Last bucket cell keeps its 'from <time>'`).toHaveText(new RegExp(`^from ${stamp}$`));
            }
          }
          await page.keyboard.press("Escape");
          await expect(dialog).toBeHidden();
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// P5: the link to Tariffs

const NO_RATE = "— no rate: no tariff applies to this figure";
const TARIFFS_LINK = "Set a rate in Tariffs";

test.describe("P5: the link to Tariffs", () => {
  test("the administrator sees a link to Tariffs next to the no-rate line of Cost today, and Tab, Enter follows it", async ({ page }) => {
    test.setTimeout(120_000);
    const stub = await prepare(page);
    await openDashboard(page, stub, LIGHT, 1440);
    await detailsButton(page, "Cost today").click();
    const dialog = drawer(page, "Cost today");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".wd-markers li"), "the no-rate sentence, then the link, in the same item").toHaveText([`${NO_RATE} ${TARIFFS_LINK}`]);
    const link = dialog.getByRole("link", { name: TARIFFS_LINK, exact: true });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute("href", /\/tariffs$/);

    await tabTo(page, dialog, link, "the Set a rate in Tariffs link");
    await page.keyboard.press("Enter");
    await expect(page, "the link leads to Tariffs").toHaveURL(/\/tariffs$/);
    await expect(heading1(page, "Tariffs")).toBeVisible();
  });

  test("an account whose role holds dashboards.view and assets.view but not tariffs.view sees the no-rate line and no link", async ({ browser, page }) => {
    test.setTimeout(150_000);
    await asAdmin(browser, async (request) => {
      await removeAccounts(request);
      const role = await request.post("/api/roles", { data: { name: READER_ROLE, description: "made by w14.spec.ts", permissions: ["dashboards.view", "assets.view"] } });
      expect(role.status(), `creating the role: ${await role.text()}`).toBe(201);
      const user = await request.post("/api/users", { data: { username: READER.username, password: READER.password, role: READER_ROLE } });
      expect(user.status(), `creating the account: ${await user.text()}`).toBe(201);
    });
    try {
      const stub = await prepare(page, { who: READER });
      await openDashboard(page, stub, null, 1440);
      await detailsButton(page, "Cost today").click();
      const dialog = drawer(page, "Cost today");
      await expect(dialog).toBeVisible();
      await expect(dialog.locator(".wd-markers li"), "the sentence is there").toHaveText([NO_RATE]);
      await expect(dialog.getByRole("link", { name: TARIFFS_LINK }), "and no link").toHaveCount(0);
      await expect(dialog.locator('a[href$="/tariffs"]'), "nothing in the drawer leads to Tariffs").toHaveCount(0);
    } finally {
      await asAdmin(browser, removeAccounts);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// P6: no sideways scroll

interface Place { name: string; path: string; ready: (page: Page) => Promise<void> }
const PLACES: Place[] = [
  { name: "Assets Tree", path: "/assets", ready: async (page) => { await expect(heading1(page, "Assets Tree")).toBeVisible(); } },
  { name: "Dashboards", path: "/dashboards", ready: async (page) => { await expect(heading1(page, "Dashboards")).toBeVisible(); await expect(page.getByText(DASHBOARD, { exact: true }).first()).toBeVisible(); } },
  { name: "Settings", path: "/settings", ready: async (page) => { await expect(heading1(page, "Settings")).toBeVisible(); } },
  { name: "Discovery", path: "/discovery", ready: async (page) => { await expect(heading1(page, "Discovery")).toBeVisible(); await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 60_000 }); } },
];

test.describe("P6: no sideways scroll", () => {
  for (const size of [{ width: 800, height: 600 }, { width: 1024, height: 640 }]) {
    for (const sidebar of ["expanded", "minimized"] as const) {
      test(`at ${size.width} x ${size.height} with the sidebar ${sidebar === "expanded" ? "open" : "minimized"}, the Assets Tree, Dashboards, Settings and Discovery do not scroll sideways`, async ({ page }) => {
        test.setTimeout(180_000);
        const stub = await prepare(page, { graph: smallModel() });
        await setLook(page, LIGHT);
        await page.setViewportSize(size);
        for (const place of PLACES) {
          await test.step(place.name, async () => {
            await page.goto(place.path);
            await place.ready(page);
            await setSidebar(page, sidebar);
            // Sampled three times, 300 ms apart: a list that arrives late is part of the page too.
            const worst = { over: 0, widest: "" };
            for (let i = 0; i < 3; i++) {
              const reading = await sideways(page);
              if (reading.over > worst.over) Object.assign(worst, reading);
              await page.waitForTimeout(300);
            }
            measured(`${place.name} ${size.width}px ${sidebar}`, worst);
            expect(worst.over, `${place.name} at ${size.width}px, sidebar ${sidebar}: the document scrolls sideways by ${worst.over}px (${worst.widest})`).toBe(0);
          });
        }
        expect(stub.reads, "Discovery read the generated graph").toBeGreaterThan(0);
      });
    }
  }
});
