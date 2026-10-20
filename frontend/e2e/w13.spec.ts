import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { markGuideSeen, userBlock } from "./shell";
import { answer, defs, H, type ShowcaseWidget, type WidgetRequest } from "./w13Showcase";

test.beforeEach(({ page }) => markGuideSeen(page)); // w27: the dashboard guide is not what this spec looks at

// W13 (the dashboard widgets follow the theme, look like cards of the app, and give an engineer the details one step away): the card on its own ground in the light and the
// dark look, the five widget types drawn with their markers, no overflow, the 2-row gauge, a chart repainting after a Mode switch with no reload, the Details drawer, and the editor
// preview and edit-mode chrome. Admin `admin` / `correct-horse`, the account the earlier projects use.
//
// IT WRITES NEXT TO NOTHING and needs no readings from the stack. The stack has no estimated, partial, no-rate or stale data on demand, so beforeAll saves ONE dashboard through
// the API (`w13 <run>`, the 15 widgets of e2e/w13Showcase.ts, on the first six real asset ids) and every case answers `POST /api/widget-data` through `page.route` from that
// showcase (the same config gets the same answer; the readings are built from the clock of the request). Any other write the page tries is refused with a 500 and fails the case
// (the Mode and Theme save, the sign-in and the widget query are the only ones allowed). afterAll deletes the dashboard, also after a failed case, and puts the admin's look back to
// Light and Navy and gold (the account's saved look wins over the browser's mirror, so every case sets the look it needs through the API first).
//
// Locators. A card is the `region` named by its title, matched with `exact: true` (a title can be a prefix of another: "Load" and "Load (2 rows)", and Playwright matches a name by
// case-insensitive substring); the Details drawer is the `dialog` named `Details: <title>`. Colours are compared as the browser computes them, with the look's own tokens read
// through a probe element (`tokenRgb`), so the spec pins the wiring (the card IS --widget-bg, the axis text IS --chart-axis-text) and not the palette, which the owner may tune.
//
// The cases:
//   types     (light navy-gold and dark desert-gold: the unit tests cover all eight looks) every card is drawn, its title is an h2, its ground is the --widget-bg token (and not white in
//             dark), each type shows its markers (~ estimated, * partial, the no-rate dash, "no data", a stale age, a removed-asset chip, the gauge as a meter), a chart has its text
//             alternative and a canvas, and the title, the stat figure, a table cell, the hint line and the gauge text read at 4.5:1.
//   overflow  at 1024, 1440 and 1920 px the page does not scroll sideways, no card's body has a horizontal scrollbar, no card is wider than its box, no two cards overlap.
//   gauge     the 2 x 2 gauge is 170 px high at 1024, 1440 and 1920, its figure and name boxes do not meet, nothing is clipped, the scale labels sit under the drawn arc's feet (within 12 px), and below 200 px of card width only the Details drawer can
//             download the CSV.
//   theme     a time series repaints after a Mode switch through the profile menu with NO navigation: every opaque pixel in the left 56 px of its canvas (the axis labels) is the
//             --chart-axis-text colour of the look on screen, light then dark then light again.
//   details   the keyboard and the click open the drawer, Escape gives the focus back to the button, and what it says is what the mocked answer proves: the asset, the window with the
//             site's zone, the reading time counting up, the stale sentence, the marker meanings of a table, the figures of a chart (lowest and highest from the data, a total only
//             when it is exact, never an average over buckets) and the words for a metric bar over time.
//   editor    in the editor the preview card has the dashboard card's ground, border, title level and title font; edit mode has no Details or CSV button, and in dark the drop
//             placeholder and the resize handles show against the card.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";

interface Look { mode: "light" | "dark"; theme: string }
type Rgb = [number, number, number];
interface Box { x: number; y: number; width: number; height: number }

const LIGHT: Look = { mode: "light", theme: "navy-gold" };
const DARK: Look = { mode: "dark", theme: "desert-gold" };
const RUN = Date.now().toString(36);
const DASHBOARD = `w13 ${RUN}`;
/** What an earlier run that stopped half way may have left behind (the gallery's "W13 showcase" starts with a capital and is not matched). */
const LEFTOVER = /^w13 [0-9a-z]+$/;

const ROW = 90; // lib/gridMetrics.ts: 80 px rows with 10 px gaps
const TWO_ROWS = 2 * ROW - 10;
/** The width under which a card hides its CSV button (a container query at 199.98 px of CONTENT; the card's two borders are not counted). */
const NARROW = 200;

// ---------------------------------------------------------------------------------------------------------------------------------
// The dashboard and the mock

let dashboardId = 0;
let zone = "";
let widgets: ShowcaseWidget[] = [];
let assetIds: number[] = [];

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

test.beforeAll(async ({ browser }) => {
  await asAdmin(browser, async (request) => {
    const prefs = await request.put("/api/me/preferences", { data: LIGHT });
    expect(prefs.ok(), `starting from the light look: ${prefs.status()} ${await prefs.text()}`).toBe(true);
    zone = ((await (await request.get("/api/site")).json()) as { timezone: string }).timezone;

    const listed = (await (await request.get("/api/dashboards")).json()) as { id: number; name: string }[];
    for (const old of listed.filter((d) => LEFTOVER.test(d.name))) await request.delete(`/api/dashboards/${old.id}`);

    const assets = (await (await request.get("/api/assets")).json()) as { id: number }[];
    assetIds = assets.map((a) => a.id).sort((a, b) => a - b).slice(0, 6);
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
  });
});

interface Stub {
  /** Console errors and uncaught exceptions of the page. */
  errors: string[];
  /** Writes the spec does not expect; the page got a 500 for each. */
  stray: string[];
  /** Widget queries no showcase widget answers (the real server got them). */
  unmatched: string[];
}
let current: Stub | null = null;

test.afterEach(() => {
  const stub = current;
  current = null;
  expect(stub?.stray ?? [], "the spec writes nothing to the stack: these requests were refused").toEqual([]);
  expect(stub?.errors ?? [], "the page logged no console error and no exception").toEqual([]);
});

/** Helpers the page-side code of this spec shares: any CSS colour as [r, g, b, a] (a canvas does the parsing, so color-mix() and friends work too). */
interface W13Window { __w13Rgba: (css: string) => [number, number, number, number]; __w13Alive?: number }

/** Signs in, answers the widget query from the showcase, refuses every other write, and listens for errors. */
async function prepare(page: Page): Promise<Stub> {
  const stub: Stub = { errors: [], stray: [], unmatched: [] };
  current = stub;
  page.on("console", (message) => {
    if (message.type() !== "error" || /net::ERR_ABORTED/.test(message.text())) return;
    stub.errors.push(`console: ${message.text()} (${message.location().url})`);
  });
  page.on("pageerror", (error) => stub.errors.push(`pageerror: ${error.message}`));
  await page.addInitScript(() => {
    let context: CanvasRenderingContext2D | null = null;
    (window as unknown as W13Window).__w13Rgba = (css: string) => {
      if (!context) {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        context = canvas.getContext("2d", { willReadFrequently: true });
      }
      const ctx = context!;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const data = ctx.getImageData(0, 0, 1, 1).data;
      return [data[0], data[1], data[2], data[3] / 255];
    };
  });
  // Registered FIRST, so it is asked last: a write that is not the sign-in, the look's save or the widget query is refused and written down.
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    if (method === "GET" || method === "HEAD") return route.fallback();
    if (path === "/api/login" || path === "/api/widget-data" || (method === "PUT" && path === "/api/me/preferences")) return route.fallback();
    stub.stray.push(`${method} ${path}`);
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "w13: this spec writes nothing" }) });
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
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in as ${ADMIN.username}: ${login.status()} ${await login.text()}`).toBe(true);
  return stub;
}

async function setLook(page: Page, look: Look): Promise<void> {
  const saved = await page.request.put("/api/me/preferences", { data: look });
  expect(saved.ok(), `storing ${JSON.stringify(look)}: ${saved.status()} ${await saved.text()}`).toBe(true);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Locators and small readings

const html = (page: Page) => page.locator("html");
const card = (page: Page, title: string) => page.getByRole("region", { name: title, exact: true });
const detailsButton = (page: Page, title: string) => card(page, title).getByRole("button", { name: `Details for ${title}`, exact: true });
const drawer = (page: Page, title: string) => page.getByRole("dialog", { name: `Details: ${title}`, exact: true });
const panelOf = (page: Page) => page.locator("#profile-panel");
const modeSelect = (page: Page) => panelOf(page).getByLabel("Mode", { exact: true });
const widgetOf = (title: string): ShowcaseWidget => {
  const found = widgets.find((w) => w.title === title);
  if (!found) throw new Error(`the showcase has no widget "${title}"`);
  return found;
};
const CHARTS = (): string[] => widgets.filter((w) => w.type === "timeseries" || w.type === "bar").map((w) => w.title);

/** The text of a `<dd>` of a Details definition list, by its `<dt>`. */
const exactly = (text: string): RegExp => new RegExp(`^${text.replace(/[.*+?^()|[\]\\{}$]/g, "\\$&")}$`);
const field = (dialog: Locator, label: string): Locator =>
  dialog.locator("dl.wd-kv > div").filter({ has: dialog.page().locator("dt").filter({ hasText: exactly(label) }) }).locator("dd");
const heading3 = (dialog: Locator, name: string): Locator => dialog.getByRole("heading", { level: 3, name, exact: true });

const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const measured = (what: string, value: unknown) => {
  test.info().annotations.push({ type: "measure", description: `${what}: ${JSON.stringify(value)}` });
};

/** Re-reads `read` every 250 ms until `ok` holds, then asserts it with everything it last measured in the message. */
async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, timeout = 10_000): Promise<T> {
  const end = Date.now() + timeout;
  let last = await read();
  while (!ok(last) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await read();
  }
  expect(ok(last), `${what}; last measured ${JSON.stringify(last)}`).toBe(true);
  return last;
}

async function boxOf(target: Locator, what: string): Promise<Box> {
  const box = await target.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  return box!;
}

/** Opens the dashboard in `look` at `width` px and waits until every card has its data (and every chart its canvas). */
async function openDashboard(page: Page, stub: Stub, look: Look, width = 1440): Promise<void> {
  await setLook(page, look);
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`/dashboards/${dashboardId}`);
  await expect(html(page)).toHaveAttribute("data-mode", look.mode);
  await expect(html(page)).toHaveAttribute("data-theme", look.theme);
  await expect(page.getByRole("heading", { level: 1, name: DASHBOARD, exact: true })).toBeVisible();
  for (const w of widgets) await expect(card(page, w.title).locator(".widget-body"), `${w.title} has its data`).toBeVisible();
  for (const title of CHARTS()) await expect(card(page, title).locator("canvas").first(), `${title} has drawn its canvas`).toBeVisible();
  await settled(page);
  expect(stub.unmatched, "every widget query of the dashboard has a showcase answer").toEqual([]);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Colours

const channel = (v: number): number => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: readonly number[]): number => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
const contrast = (a: readonly number[], b: readonly number[]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const css = (c: readonly number[]): string => `rgb(${c.map((v) => Math.round(v)).join(", ")})`;
const rgb = (c: readonly number[]): Rgb => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];

/** The colour a custom property has in the page's current look, as [r, g, b]. */
async function tokenRgb(page: Page, token: string): Promise<Rgb> {
  const c = await page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.documentElement.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return (window as unknown as W13Window).__w13Rgba(value);
  }, token);
  return rgb(c);
}

/** One computed colour property of an element or of its pseudo-element (`::after`), as [r, g, b]. */
async function colourOf(target: Locator, property: string, pseudo: string | null = null): Promise<Rgb> {
  const c = await target.evaluate((el, [name, pseudoElement]) => {
    const style = getComputedStyle(el, pseudoElement) as unknown as Record<string, string>;
    return (window as unknown as W13Window).__w13Rgba(style[name]);
  }, [property, pseudo] as [string, string | null]);
  return rgb(c);
}

/** Page side: an element's text colour and the opaque ground it stands on (its own and its ancestors' backgrounds laid over each other, and every opacity applied). */
function inkOf(el: HTMLElement): { fg: number[]; bg: number[] } {
  const rgba = (window as unknown as W13Window).__w13Rgba;
  const layers: number[][] = [];
  let opacity = 1;
  let opaque = false;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    opacity *= Number(style.opacity);
    if (opaque) continue;
    const c = rgba(style.backgroundColor);
    if (c[3] > 0) layers.push(c);
    if (c[3] >= 1) opaque = true;
  }
  let bg = [255, 255, 255];
  for (const layer of layers.reverse()) bg = [0, 1, 2].map((i) => layer[i] * layer[3] + bg[i] * (1 - layer[3]));
  const text = rgba(getComputedStyle(el).color);
  const alpha = text[3] * opacity;
  return { fg: [0, 1, 2].map((i) => text[i] * alpha + bg[i] * (1 - alpha)), bg };
}

/** The ground behind an element. */
async function groundOf(target: Locator): Promise<Rgb> {
  return rgb((await target.evaluate(inkOf)).bg);
}

/** Asserts that the text of `target` reads at `min`:1 on the ground it stands on, naming the colours when it does not. */
async function expectReadable(target: Locator, what: string, min = 4.5): Promise<void> {
  await expect(target, `${what} is drawn`).toBeVisible();
  const { fg, bg } = await target.evaluate(inkOf);
  const ratio = contrast(fg, bg);
  expect(ratio, `${what}: text ${css(fg)} on ${css(bg)} is ${ratio.toFixed(2)}:1 and needs ${min}:1`).toBeGreaterThanOrEqual(min);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Case: every type, in the light and the dark look

/** What each showcase card must show. The tests below fail if a widget is added to the showcase without an entry here. */
const TYPE_CHECKS: Record<string, (c: Locator) => Promise<void>> = {
  "Active power": async (c) => {
    await expect(c.locator(".stat .stat-num"), "the figure").toHaveText("12.34");
    await expect(c.locator(".stat .stat-unit"), "the unit").toHaveText("kW");
    await expect(c.locator(".stat-name"), "the asset name").toHaveText("Rack A01");
    await expect(c.locator(".stat .big.muted"), "a fresh reading is not dimmed").toHaveCount(0);
  },
  "Cost today": async (c) => {
    await expect(c.locator(".stat .stat-num"), "a cost with no rate shows the dash").toHaveText("—");
    await expect(c.locator(".widget-hint"), "the footer says what the dash means").toContainText("— no rate");
    await expect(c.locator(".widget-since"), "a rolling cost says where its window starts").toHaveText(/^since /);
  },
  "Energy 24 h": async (c) => {
    await expect(c.locator(".stat .stat-num"), "an estimated figure carries ~").toHaveText("~123.46");
    await expect(c.locator(".widget-hint")).toContainText("~ estimated");
  },
  "Supply voltage": async (c) => {
    await expect(c.locator(".stat .big.muted"), "a stale reading is dimmed").toHaveCount(1);
    await expect(c.locator(".stat .stat-num")).toHaveText("229.80");
    await expect(c.locator(".stat-age"), "a stale reading says how old it is").toContainText(/\d+ min ago/);
  },
  "Load": async (c) => {
    const meter = c.locator('[role="meter"]');
    await expect(meter, "the gauge is a meter").toHaveCount(1);
    await expect(meter).toHaveAttribute("aria-valuenow", "62.5");
    await expect(meter).toHaveAttribute("aria-valuemin", "0");
    await expect(meter).toHaveAttribute("aria-valuemax", "100");
    await expect(meter).toHaveAttribute("aria-valuetext", "62.50 kW");
    await expect(c.locator(".gauge-fill"), "the arc is filled").toHaveCount(1);
    await expect(c.locator(".gauge-figure")).toHaveText("62.50 kW");
    await expect(c.locator(".gauge-name")).toHaveText("Rack A01");
    await expect(c.locator(".gauge-scale > span")).toHaveText(["0", "100 kW"]);
  },
  "Load (2 rows)": async (c) => {
    await expect(c.locator('[role="meter"]')).toHaveAttribute("aria-valuenow", "27.8");
    await expect(c.locator(".gauge-figure")).toHaveText("27.80 A");
    await expect(c.locator(".gauge-name")).toHaveText("Rack A02");
  },
  "Stale gauge": async (c) => {
    await expect(c.locator(".gauge-figure.muted"), "a stale gauge is dimmed").toHaveCount(1);
    await expect(c.locator(".gauge-name"), "it names its asset and says how old it is").toContainText(/UPS-1 output.*\d+ h ago/);
  },
  "No data gauge": async (c) => {
    await expect(c.locator('[role="meter"]'), "no value is not a meter").toHaveCount(0);
    await expect(c.locator('.gauge[role="img"]')).toHaveAttribute("aria-label", "CRAH-3 supply fan: no data");
    await expect(c.locator(".gauge-fill"), "nothing is drawn for a missing value").toHaveCount(0);
    await expect(c.locator(".gauge-figure")).toHaveText("no data");
  },
  "Power by rack": async (c) => {
    await expect(c.locator('.widget-chart[role="img"]')).toHaveAttribute("aria-label", /^Line chart of 3 assets: Rack A01, Rack A02, UPS-1 output\. active_power_kw in kW, Last 24 hours\. Open Details/);
  },
  "Energy per hour": async (c) => {
    await expect(c.locator('.widget-chart[role="img"]')).toHaveAttribute("aria-label", /^Line chart of 3 assets: Rack A01, Rack A02, UPS-1 output\. Energy in kWh, Last 24 hours\./);
    await expect(c.locator(".widget-chips .chip-long"), "the removed asset is a chip").toHaveText("1 asset removed");
  },
  "Energy per asset": async (c) => {
    await expect(c.locator('.widget-chart[role="img"]')).toHaveAttribute("aria-label", /^Bar chart of 6 assets: Rack A01, Rack A02, UPS-1 output and 3 more\. Energy in kWh, Last 24 hours\./);
  },
  "Cost per hour": async (c) => {
    await expect(c.locator('.widget-chart[role="img"]')).toHaveAttribute("aria-label", /^Bar chart of 3 assets: Rack A01, Rack A02, UPS-1 output\. Cost in QAR, Last 24 hours\./);
    await expect(c.locator(".widget-hint"), "a partial series explains *").toContainText("* partial");
  },
  "Power now": async (c) => {
    await expect(c.locator("th")).toHaveText(["Asset", "Value (kW)"]);
    await expect(c.locator("tbody tr")).toHaveCount(6);
    await expect(c.locator("tbody tr").nth(0).locator("td").nth(1)).toHaveText("8.00");
    await expect(c.locator("tbody tr").nth(4).locator("td").nth(1), "an asset that recorded nothing says so").toHaveText("no data");
    await expect(c.locator("tbody tr").nth(2).locator(".cell-age"), "a stale row says how old it is").toContainText(/h ago/);
  },
  "Cost this month": async (c) => {
    await expect(c.locator("tbody tr")).toHaveCount(6);
    await expect(c.locator("tbody tr").nth(1).locator("td.num"), "estimated").toHaveText("~137.25");
    await expect(c.locator("tbody tr").nth(2).locator("td.num"), "partial").toHaveText("174.50*");
    await expect(c.locator("tbody tr").nth(3).locator("td.num"), "no rate").toHaveText("—");
    await expect(c.locator(".widget-hint")).toContainText("~ estimated");
    await expect(c.locator(".widget-hint")).toContainText("* partial");
    await expect(c.locator(".widget-hint")).toContainText("— no rate");
    await expect(c.locator(".widget-chips .chip-long")).toHaveText("1 asset removed");
  },
  "Peak per hour": async (c) => {
    await expect(c.locator('.widget-chart[role="img"]')).toHaveAttribute("aria-label", /^Bar chart of 2 assets: Rack A01, Rack A02\. active_power_kw in kW, Last 24 hours\./);
  },
};

for (const look of [LIGHT, DARK]) {
  test(`every widget type is drawn on its own card and reads well in ${look.mode} ${look.theme}`, async ({ page }) => {
    test.setTimeout(180_000);
    const stub = await prepare(page);
    await openDashboard(page, stub, look);
    expect(Object.keys(TYPE_CHECKS).sort(), "the cases below cover exactly the showcase widgets").toEqual(widgets.map((w) => w.title).sort());

    const widgetBg = await tokenRgb(page, "--widget-bg");
    for (const w of widgets) {
      const c = card(page, w.title);
      await test.step(w.title, async () => {
        await expect(c, "the card is drawn").toBeVisible();
        await expect(c.getByRole("heading", { level: 2, name: w.title, exact: true }), "the title is an h2").toBeVisible();
        const ground = await groundOf(c);
        expect(css(ground), `${w.title}: the card's ground is the --widget-bg token ${css(widgetBg)}`).toBe(css(widgetBg));
        if (look.mode === "dark") expect(css(ground), `${w.title}: a card in dark mode is not white`).not.toBe("rgb(255, 255, 255)");
        await expect(detailsButton(page, w.title), "the card has its Details button").toBeVisible();
        await TYPE_CHECKS[w.title](c);
        if (w.type === "timeseries" || w.type === "bar") {
          const canvas = await boxOf(c.locator("canvas").first(), `${w.title}'s canvas`);
          expect(canvas.width, `${w.title}'s canvas is wide enough to read`).toBeGreaterThan(150);
          expect(canvas.height, `${w.title}'s canvas is tall enough to read`).toBeGreaterThan(100);
        }
      });
    }

    await test.step("text reads at 4.5:1 on the card", async () => {
      await expectReadable(card(page, "Active power").getByRole("heading", { level: 2, name: "Active power", exact: true }), "the card title");
      await expectReadable(card(page, "Active power").locator(".stat-num"), "the stat figure");
      await expectReadable(card(page, "Active power").locator(".stat-unit"), "the stat unit");
      await expectReadable(card(page, "Active power").locator(".stat-name"), "the stat's asset name");
      await expectReadable(card(page, "Supply voltage").locator(".stat .big.muted"), "the dimmed (stale) figure");
      await expectReadable(card(page, "Supply voltage").locator(".stat-age small"), "the age of a stale reading");
      await expectReadable(card(page, "Power now").locator("tbody tr").nth(0).locator("td").nth(0), "a table cell (the asset name)");
      await expectReadable(card(page, "Power now").locator("tbody tr").nth(0).locator("td").nth(1), "a table cell (the figure)");
      await expectReadable(card(page, "Power now").locator("tbody tr").nth(4).locator("td").nth(1), "the table's no-data cell");
      await expectReadable(card(page, "Power now").locator("th").first(), "a table head cell");
      await expectReadable(card(page, "Cost this month").locator(".widget-hint"), "the hint line");
      await expectReadable(card(page, "Cost this month").locator(".widget-since"), "the since line");
      await expectReadable(card(page, "Load").locator(".gauge-figure .stat-num"), "the gauge figure");
      await expectReadable(card(page, "Load").locator(".gauge-name"), "the gauge name");
      await expectReadable(card(page, "Load").locator(".gauge-scale > span").first(), "the end of the gauge scale");
    });

    await test.step("the gauge arc follows the look: the fill is --gauge-fill, the track is --gauge-track, and they differ", async () => {
      const fill = await colourOf(card(page, "Load").locator(".gauge-fill"), "stroke");
      const track = await colourOf(card(page, "Load").locator(".gauge-track"), "stroke");
      expect(css(fill), "the fill").toBe(css(await tokenRgb(page, "--gauge-fill")));
      expect(css(track), "the track").toBe(css(await tokenRgb(page, "--gauge-track")));
      expect(contrast(fill, track), `the fill ${css(fill)} against its track ${css(track)}`).toBeGreaterThanOrEqual(3);
      const groundOfArc = await groundOf(card(page, "Load").locator(".gauge-arc"));
      expect(contrast(track, groundOfArc), `the track ${css(track)} against the card ${css(groundOfArc)}`).toBeGreaterThan(1.1);
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Case: no overflow

interface FitReport {
  page: number;
  cards: { title: string; frame: number; body: number; bodyY: number; box: { x: number; y: number; width: number; height: number } }[];
}

test("no card overflows its box, no two cards meet, and the page does not scroll sideways at 1024, 1440 and 1920 px", async ({ page }) => {
  test.setTimeout(240_000);
  const stub = await prepare(page);
  for (const width of [1024, 1440, 1920]) {
    await test.step(`${width} px`, async () => {
      await openDashboard(page, stub, LIGHT, width);
      const report: FitReport = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth - window.innerWidth,
        cards: Array.from(document.querySelectorAll<HTMLElement>(".widget-frame")).map((frame) => {
          const body = frame.querySelector<HTMLElement>(".widget-body");
          const r = frame.getBoundingClientRect();
          return {
            title: frame.getAttribute("aria-label") ?? "",
            frame: frame.scrollWidth - frame.clientWidth,
            body: body ? body.scrollWidth - body.clientWidth : 0,
            bodyY: body ? body.scrollHeight - body.clientHeight : 0,
            box: { x: r.x, y: r.y, width: r.width, height: r.height },
          };
        }),
      }));
      expect(report.cards.length, "every showcase card is on the page").toBe(widgets.length);
      expect(report.page, `the page scrolls sideways by ${report.page}px`).toBeLessThanOrEqual(0);
      const wide = report.cards.filter((c) => c.frame > 1 || c.body > 1);
      expect(wide, `cards with content wider than the card (a horizontal scrollbar), by px, at ${width}px`).toEqual([]);
      // A stat and a gauge hold their whole content: a vertical scrollbar there is clipping. A table or a chart may scroll or stretch.
      const clipped = report.cards.filter((c) => ["stat", "gauge"].includes(widgetOf(c.title).type) && c.bodyY > 1);
      expect(clipped, `stat and gauge cards whose content is taller than the card at ${width}px`).toEqual([]);
      const meets: string[] = [];
      for (const [i, a] of report.cards.entries()) {
        for (const b of report.cards.slice(i + 1)) {
          if (a.box.x < b.box.x + b.box.width - 1 && b.box.x < a.box.x + a.box.width - 1 && a.box.y < b.box.y + b.box.height - 1 && b.box.y < a.box.y + a.box.height - 1) meets.push(`${a.title} / ${b.title}`);
        }
      }
      expect(meets, `cards that overlap at ${width}px`).toEqual([]);
      measured(`${width}px smallest card`, report.cards.reduce((m, c) => (c.box.width < m.box.width ? c : m)).box);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Case: the gauge at two rows

interface GaugeFit {
  frame: Box;
  body: { client: number; scroll: number; clientW: number; scrollW: number };
  boxes: Record<"body" | "arc" | "scale" | "figure" | "name", Box>;
  /** The dial's svg box and the two scale labels' boxes (min, max). */
  svg: Box;
  ends: Box[];
  cut: { figure: number; name: number; scale: number[] };
}

test("the 2 x 2 gauge is 170 px high at 1024, 1440 and 1920 px, with its figure and name apart and nothing clipped", async ({ page }) => {
  test.setTimeout(180_000);
  const stub = await prepare(page);
  for (const width of [1024, 1440, 1920]) {
    await test.step(`${width} px`, async () => {
      await openDashboard(page, stub, LIGHT, width);
      const c = card(page, "Load (2 rows)");
      const fit: GaugeFit = await c.evaluate((frame) => {
        const rect = (el: Element | null) => {
          if (!el) throw new Error("the gauge is missing a part");
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        const body = frame.querySelector<HTMLElement>(".widget-body")!;
        const figure = frame.querySelector<HTMLElement>(".gauge-figure")!;
        const name = frame.querySelector<HTMLElement>(".gauge-name")!;
        return {
          frame: rect(frame),
          body: { client: body.clientHeight, scroll: body.scrollHeight, clientW: body.clientWidth, scrollW: body.scrollWidth },
          boxes: { body: rect(body), arc: rect(frame.querySelector(".gauge-arc")), scale: rect(frame.querySelector(".gauge-scale")), figure: rect(figure), name: rect(name) },
          svg: rect(frame.querySelector(".gauge-svg")),
          ends: Array.from(frame.querySelectorAll(".gauge-scale > span")).map(rect),
          cut: {
            figure: figure.scrollWidth - figure.clientWidth,
            name: name.scrollWidth - name.clientWidth,
            scale: Array.from(frame.querySelectorAll<HTMLElement>(".gauge-scale > span")).map((s) => s.scrollWidth - s.clientWidth),
          },
        };
      });
      measured(`${width}px gauge`, fit);
      expect(Math.abs(fit.frame.height - TWO_ROWS), `the card is ${fit.frame.height}px high, not ${TWO_ROWS}`).toBeLessThanOrEqual(1);
      const meet = (a: Box, b: Box) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
      expect(meet(fit.boxes.figure, fit.boxes.name), `the figure ${JSON.stringify(fit.boxes.figure)} meets the name ${JSON.stringify(fit.boxes.name)}`).toBe(false);
      expect(meet(fit.boxes.scale, fit.boxes.figure), `the scale ${JSON.stringify(fit.boxes.scale)} meets the figure ${JSON.stringify(fit.boxes.figure)}`).toBe(false);
      expect(meet(fit.boxes.arc, fit.boxes.figure), `the arc ${JSON.stringify(fit.boxes.arc)} meets the figure ${JSON.stringify(fit.boxes.figure)}`).toBe(false);
      for (const part of ["arc", "scale", "figure", "name"] as const) {
        const p = fit.boxes[part];
        const b = fit.boxes.body;
        const inside = p.x >= b.x - 1 && p.y >= b.y - 1 && p.x + p.width <= b.x + b.width + 1 && p.y + p.height <= b.y + b.height + 1;
        expect(inside, `the ${part} ${JSON.stringify(p)} sticks out of the card body ${JSON.stringify(b)}`).toBe(true);
      }
      expect(fit.body.scroll, `the body scrolls vertically (${fit.body.scroll} of ${fit.body.client}px): something is clipped`).toBeLessThanOrEqual(fit.body.client + 1);
      expect(fit.body.scrollW, `the body scrolls sideways (${fit.body.scrollW} of ${fit.body.clientW}px)`).toBeLessThanOrEqual(fit.body.clientW + 1);
      expect(fit.svg.height, "the dial is tall enough to see").toBeGreaterThanOrEqual(32);
      expect(fit.cut.figure, "the figure is cut").toBeLessThanOrEqual(1);
      expect(fit.cut.name, "the name is cut with an ellipsis").toBeLessThanOrEqual(1);
      expect(Math.max(...fit.cut.scale), "an end of the scale is cut").toBeLessThanOrEqual(1);

      // The ends of the scale sit under the feet of the DRAWN arc (whole-wave review I1). The svg is viewBox 0 0 100 52, xMidYMax meet, with the feet at x = 6 and 94: it is drawn
      // min(box width, box height * 100 / 52) wide, centred, whatever the card is. Measured from the svg box, not from the card.
      const drawn = Math.min(fit.svg.width, (fit.svg.height * 100) / 52);
      const drawnLeft = fit.svg.x + (fit.svg.width - drawn) / 2;
      const footLeft = drawnLeft + 0.06 * drawn;
      const footRight = drawnLeft + 0.94 * drawn;
      const [minEnd, maxEnd] = fit.ends;
      measured(`${width}px arc`, { drawn, footLeft, footRight, minCentre: minEnd.x + minEnd.width / 2, maxRight: maxEnd.x + maxEnd.width });
      expect(Math.abs(minEnd.x + minEnd.width / 2 - footLeft), `the min label's centre is ${Math.round(minEnd.x + minEnd.width / 2)}, the arc's left end is at ${Math.round(footLeft)} (the arc is ${Math.round(drawn)} px wide in a ${Math.round(fit.svg.width)} px box)`).toBeLessThanOrEqual(12);
      expect(Math.abs(maxEnd.x + maxEnd.width - footRight), `the max label ends at ${Math.round(maxEnd.x + maxEnd.width)}, the arc's right end is at ${Math.round(footRight)}`).toBeLessThanOrEqual(12);

      // Below 200 px of card width the CSV button leaves the header and only the Details drawer downloads (decision D3).
      const csv = c.getByRole("button", { name: "Download CSV for Load (2 rows)", exact: true });
      if (fit.frame.width < NARROW - 4) await expect(csv, `a ${Math.round(fit.frame.width)}px card has no CSV button in its header`).toBeHidden();
      if (fit.frame.width > NARROW + 4) await expect(csv, `a ${Math.round(fit.frame.width)}px card keeps its CSV button`).toBeVisible();
      if (fit.frame.width < NARROW - 4) {
        await detailsButton(page, "Load (2 rows)").click();
        await expect(drawer(page, "Load (2 rows)").getByRole("button", { name: "Download CSV", exact: true }), "the drawer downloads the CSV instead").toBeVisible();
        await page.keyboard.press("Escape");
        await expect(drawer(page, "Load (2 rows)")).toBeHidden();
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Case: a chart repaints after a Mode switch

interface Strip { light: number; dark: number; other: number; canvases: number }

/** The opaque pixels in the left 56 px of the chart's canvases (the axis labels), by which of the two axis text colours they are nearest (RGB distance <= 40). */
function stripOf(chart: Locator, light: Rgb, dark: Rgb): Promise<Strip> {
  return chart.evaluate((box, [lightInk, darkInk]) => {
    const out = { light: 0, dark: 0, other: 0, canvases: 0 };
    const away = (r: number, g: number, b: number, ink: number[]) => Math.hypot(r - ink[0], g - ink[1], b - ink[2]);
    for (const canvas of Array.from(box.querySelectorAll("canvas"))) {
      const context = canvas.getContext("2d");
      const shown = canvas.getBoundingClientRect().width;
      if (!context || shown === 0) continue;
      out.canvases++;
      const scale = canvas.width / shown;
      const width = Math.min(canvas.width, Math.round(56 * scale));
      const data = context.getImageData(0, 0, width, canvas.height).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 200) continue;
        const nearLight = away(data[i], data[i + 1], data[i + 2], lightInk);
        const nearDark = away(data[i], data[i + 1], data[i + 2], darkInk);
        if (Math.min(nearLight, nearDark) > 40) out.other++;
        else if (nearLight <= nearDark) out.light++;
        else out.dark++;
      }
    }
    return out;
  }, [light, dark] as [Rgb, Rgb]);
}

const isSave = (r: { url(): string; request(): { method(): string } }) => new URL(r.url()).pathname === "/api/me/preferences" && r.request().method() === "PUT";

test("a time series repaints in the other mode's colours after a Mode switch through the profile menu, with no reload", async ({ page }) => {
  test.setTimeout(180_000);
  const stub = await prepare(page);
  const chart = card(page, "Power by rack").locator(".widget-chart");

  // The axis text colour of each look, read from the page itself.
  await openDashboard(page, stub, DARK);
  const darkInk = await tokenRgb(page, "--chart-axis-text");
  await openDashboard(page, stub, LIGHT);
  const lightInk = await tokenRgb(page, "--chart-axis-text");
  const apart = Math.hypot(lightInk[0] - darkInk[0], lightInk[1] - darkInk[1], lightInk[2] - darkInk[2]);
  expect(apart, `the two looks' axis text colours (${css(lightInk)} and ${css(darkInk)}) are ${apart.toFixed(0)} apart in RGB; the classifier needs more than 2 x 40`).toBeGreaterThan(80);

  await page.evaluate(() => { (window as unknown as W13Window).__w13Alive = 1; });
  let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });

  const switchTo = async (mode: "light" | "dark") => {
    await userBlock(page).click();
    await expect(panelOf(page)).toBeVisible();
    const [response] = await Promise.all([page.waitForResponse(isSave), modeSelect(page).selectOption(mode)]);
    expect(response.ok(), `saving the mode: ${response.status()}`).toBe(true);
    await page.keyboard.press("Escape");
    await expect(panelOf(page)).toBeHidden();
    await expect(html(page)).toHaveAttribute("data-mode", mode);
  };
  const expectInk = async (mode: "light" | "dark") => {
    const ink = (s: Strip) => (mode === "light" ? { right: s.light, wrong: s.dark } : { right: s.dark, wrong: s.light });
    await eventually(
      () => stripOf(chart, lightInk, darkInk),
      (s) => ink(s).right > 20 && ink(s).wrong === 0,
      `in ${mode} mode the axis labels (the opaque pixels in the left 56px of the canvas) must be ${mode === "light" ? css(lightInk) : css(darkInk)}: more than 20 of them, and none of the other look's ${mode === "light" ? css(darkInk) : css(lightInk)}`,
    );
  };

  await expectInk("light");
  await switchTo("dark");
  await expectInk("dark");
  await switchTo("light");
  await expectInk("light");

  expect(await page.evaluate(() => (window as unknown as W13Window).__w13Alive), "the page was reloaded (its marker is gone)").toBe(1);
  expect(navigations, "the page navigated while the mode was switched").toBe(0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Case: Details

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

/** `HH:MM:SS` of a reading, with the date in front when it is not the site's today. */
const READING = "(?:\\d{4}-\\d{2}-\\d{2} )?\\d{2}:\\d{2}:\\d{2}";

test.describe("Details", () => {
  test("it opens from the keyboard and from a click, gives the focus back, and says what the answer proves about a fresh reading", async ({ page }) => {
    test.setTimeout(180_000);
    const stub = await prepare(page);
    await openDashboard(page, stub, LIGHT);
    const title = "Active power";
    const button = detailsButton(page, title);
    const dialog = drawer(page, title);

    await test.step("Tab reaches the card's Details button, which is a real button with the name of its card", async () => {
      await tabTo(page, page.getByLabel("Dashboard range"), button, "the first card's Details button");
      expect(await button.evaluate((el) => el.tagName), "a real button").toBe("BUTTON");
      await expect(dialog).toBeHidden();
    });

    await test.step("Enter opens the drawer", async () => {
      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("heading", { level: 2, name: `Details: ${title}`, exact: true })).toBeVisible();
    });

    await test.step("it names the asset (a link to its page), the metric and unit, and what the figure is", async () => {
      await expect(heading3(dialog, "What it shows")).toBeVisible();
      await expect(dialog.getByRole("link", { name: "Rack A01", exact: true })).toHaveAttribute("href", `/assets/${assetIds[0]}`);
      await expect(field(dialog, "Source")).toHaveText("active_power_kw (kW)");
      await expect(field(dialog, "Figure")).toHaveText("Latest reading");
      await expect(heading3(dialog, "What the markers mean here"), "a figure without a marker explains none").toHaveCount(0);
      await expect(heading3(dialog, "Per asset"), "a fresh reading has no per-asset table").toHaveCount(0);
    });

    await test.step("the window carries the site's zone and is the 24 hours of the dashboard", async () => {
      await expect(heading3(dialog, "Time window")).toBeVisible();
      const text = (await field(dialog, "Window").innerText()).trim();
      const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) to (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \((.+)\)$/.exec(text);
      expect(m, `the window reads "yyyy-mm-dd hh:mm to yyyy-mm-dd hh:mm (zone)", it reads "${text}"`).not.toBeNull();
      expect(m![3], "the zone named is the site's").toBe(zone);
      const asUtc = (stamp: string) => Date.parse(`${stamp.replace(" ", "T")}:00Z`);
      const hours = (asUtc(m![2]) - asUtc(m![1])) / H;
      expect(hours, `the window is ${hours} hours long, text "${text}"`).toBeGreaterThanOrEqual(22);
      expect(hours).toBeLessThanOrEqual(26);
      await expect(field(dialog, "Range")).toHaveText("Last 24 hours");
      await expect(field(dialog, "Data")).toHaveText("The latest reading of each asset");
    });

    await test.step("the reading time is a clock time and an age that counts up while the drawer is open", async () => {
      await expect(heading3(dialog, "Freshness")).toBeVisible();
      const reading = field(dialog, "Rack A01");
      await expect(reading).toHaveText(new RegExp(`^Last reading ${READING} \\((just now|\\d+ s ago|\\d+ min ago)\\)$`));
      const first = await reading.innerText();
      await eventually(() => reading.innerText(), (text) => text !== first, `the reading's age does not count up (it still reads "${first}")`, 6_000);
    });

    await test.step("Escape closes it and the focus is on the button that opened it", async () => {
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(button).toBeFocused();
    });

    await test.step("a click opens it too, and Escape gives the focus back again", async () => {
      await button.click();
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(button).toBeFocused();
    });
  });

  test("a stale reading is told as stale, in words", async ({ page }) => {
    const stub = await prepare(page);
    await openDashboard(page, stub, LIGHT);
    await detailsButton(page, "Supply voltage").click();
    const dialog = drawer(page, "Supply voltage");
    await expect(dialog).toBeVisible();
    await expect(field(dialog, "CRAH-3 supply fan")).toHaveText(
      new RegExp(`^Last reading ${READING} \\(\\d+ min ago\\) Stale: older than three polling intervals of its meter \\(and at least a minute\\)\\.$`),
    );
    await expect(heading3(dialog, "Per asset"), "the stale state is the Freshness section's, not a second table").toHaveCount(0);
  });

  test("a table explains the markers it uses, the assets that are left out, and the state of each row", async ({ page }) => {
    const stub = await prepare(page);
    await openDashboard(page, stub, LIGHT);
    await detailsButton(page, "Cost this month").click();
    const dialog = drawer(page, "Cost this month");
    await expect(dialog).toBeVisible();
    await expect(field(dialog, "Source")).toHaveText("Cost (QAR)");
    await expect(field(dialog, "Figure")).toHaveText("Total");
    await expect(field(dialog, "Data")).toHaveText("One figure per asset over the whole window");
    await expect(field(dialog, "Left out")).toContainText("1 asset removed");
    // w14 (P5): the no-rate line is followed, inside the same item, by the link to Tariffs for a role that may open that page (the administrator does).
    await expect(dialog.locator(".wd-markers li"), "one sentence for each marker the answer uses, in this order").toHaveText([
      "~ estimated from power, not measured",
      "* partial: some energy in the period had no rate, so the cost is incomplete",
      "— no rate: no tariff applies to this figure Set a rate in Tariffs",
    ]);
    await expect(dialog.locator(".wd-markers li").nth(2).getByRole("link", { name: "Set a rate in Tariffs", exact: true }), "the link stands inside the no-rate item").toHaveCount(1);
    const rows = dialog.locator(".wd-table tbody tr");
    await expect(rows).toHaveCount(6);
    // The figures are on the card; the table names each asset's state in words.
    await expect(rows.filter({ hasText: "Rack A02" }), "the estimated row").toContainText("estimated");
    await expect(rows.filter({ hasText: "UPS-1 output" }), "the partial row").toContainText("partial");
    await expect(rows.filter({ hasText: "CRAH-3 supply fan" }), "the row with no rate").toContainText("no rate");
    await expect(rows.filter({ hasText: "Rack A01" }), "a plain row says nothing about its state").toHaveText("Rack A01");
  });

  test("a chart's Details carries its figures as text: lowest and highest from the data, a total only when exact, never an average over buckets", async ({ page }) => {
    test.setTimeout(180_000);
    const stub = await prepare(page);
    await openDashboard(page, stub, LIGHT);
    const now = Date.now();
    const answerOf = (title: string) => {
      const w = widgetOf(title);
      const got = answer(widgets, { type: w.type, config: w.config, range: "24h" }, now);
      if (!got) throw new Error(`no showcase answer for ${title}`);
      return got;
    };
    const unit = (text: string, value: number, u: string) => `${text}${value.toFixed(2)}${u}`;

    await test.step("Power by rack: the words, and the lowest and highest bucket extremes of the stored readings", async () => {
      await detailsButton(page, "Power by rack").click();
      const dialog = drawer(page, "Power by rack");
      await expect(dialog).toBeVisible();
      await expect(field(dialog, "Figure")).toHaveText("Average of each bucket, with the lowest and highest as a band");
      await expect(field(dialog, "Data"), "the tier is named, a bucket width never is").toHaveText("Averages of the stored readings (the 1-minute roll-up)");
      const table = dialog.locator(".wd-table");
      // w14 (P4): the column "Highest in the bucket from" is gone; the Highest cell carries the figure and, under it, "bucket from <time>" (the start of that bucket, never the moment of the peak).
      await expect(table.getByRole("columnheader")).toHaveText(["Asset", "Lowest", "Highest", "Last bucket (average)"]);
      await expect(table.getByRole("columnheader", { name: /^(average|mean|avg)/i }), "no column is an average over buckets").toHaveCount(0);
      const data = answerOf("Power by rack");
      for (const series of data.series) {
        const lowest = Math.min(...series.points.flatMap((p) => (p.min === null ? [] : [p.min])));
        const highest = Math.max(...series.points.flatMap((p) => (p.max === null ? [] : [p.max])));
        const row = table.locator("tbody tr").filter({ hasText: series.name });
        await expect(row.locator("td").nth(1), `${series.name}: the lowest bucket minimum`).toHaveText(unit("", lowest, " kW"));
        await expect(row.locator("td").nth(2).locator(".wd-fig").first(), `${series.name}: the highest bucket maximum`).toHaveText(unit("", highest, " kW"));
        await expect(row.locator("td").nth(2).locator("small.wd-sub"), `${series.name}: and which bucket it is`).toHaveText(/^bucket from \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      }
      await expect(dialog.locator(".wd-note").first()).toContainText("Figures are of the buckets shown in the chart.");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });

    await test.step("Energy per hour: a total of the buckets shown, with the marks of its series", async () => {
      await detailsButton(page, "Energy per hour").click();
      const dialog = drawer(page, "Energy per hour");
      await expect(dialog).toBeVisible();
      await expect(field(dialog, "Figure")).toHaveText("Total per hour");
      await expect(field(dialog, "Data")).toHaveText("One value per hour");
      await expect(field(dialog, "Left out")).toContainText("1 asset removed");
      const table = dialog.locator(".wd-table");
      await expect(table.getByRole("columnheader", { name: "Total of the buckets shown", exact: true })).toHaveCount(1);
      await expect(table.getByRole("columnheader", { name: /^(average|mean|avg)/i })).toHaveCount(0);
      const total = (name: string) => table.locator("tbody tr").filter({ hasText: name }).locator("td").last();
      const sums = answerOf("Energy per hour").series.map((s) => ({ name: s.name, sum: s.points.reduce((acc, p) => acc + (p.value ?? 0), 0), s }));
      expect(sums[0].sum, "the showcase's first series adds up to 306 kWh").toBe(306);
      await expect(total("Rack A01")).toHaveText("306.00 kWh");
      await expect(total("Rack A02"), "an estimated series: ~").toHaveText(`~${sums[1].sum.toFixed(2)} kWh`);
      await expect(total("UPS-1 output"), "a plain series: no mark (the server never sends partial for energy)").toHaveText(`${sums[2].sum.toFixed(2)} kWh`);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });

    await test.step("Cost per hour: a series with unpriced hours claims no total and no highest hour", async () => {
      await detailsButton(page, "Cost per hour").click();
      const dialog = drawer(page, "Cost per hour");
      await expect(dialog).toBeVisible();
      const row = dialog.locator(".wd-table tbody tr").filter({ hasText: "Rack A02" });
      await expect(row, "its state in words").toContainText("no rate");
      await expect(row.locator("td").last(), "no total").toHaveText("—");
      await expect(row.locator("td").nth(1), "no highest hour either").toHaveText("— unpriced hours");
      await expect(dialog.locator(".wd-note").filter({ hasText: "A total is shown only when every bucket has a value." })).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });

    await test.step("Peak per hour: a metric bar over time says its aggregation and its tier, not an average", async () => {
      await detailsButton(page, "Peak per hour").click();
      const dialog = drawer(page, "Peak per hour");
      await expect(dialog).toBeVisible();
      await expect(field(dialog, "Figure")).toHaveText("Highest per hour");
      await expect(field(dialog, "Data")).toHaveText("One value per hour: the highest inside each (the hourly roll-up)");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Case: the editor and edit mode

interface CardStyle { background: string; border: string; radius: string; titleTag: string; titleSize: string; titleWeight: string; titleLine: string; titleColor: string }
const styleOf = (frame: Locator): Promise<CardStyle> =>
  frame.evaluate((el) => {
    const style = getComputedStyle(el);
    const title = el.querySelector<HTMLElement>(".widget-title");
    if (!title) throw new Error("the card has no .widget-title");
    const t = getComputedStyle(title);
    return {
      background: style.backgroundColor, border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`, radius: style.borderTopLeftRadius,
      titleTag: title.tagName.toLowerCase(), titleSize: t.fontSize, titleWeight: t.fontWeight, titleLine: t.lineHeight, titleColor: t.color,
    };
  });

for (const look of [LIGHT, DARK]) {
  test(`the editor's preview is the dashboard card, and edit mode has no Details or CSV button (${look.mode})`, async ({ page }) => {
    test.setTimeout(180_000);
    const stub = await prepare(page);
    await openDashboard(page, stub, look);
    const onDashboard = await styleOf(card(page, "Active power"));

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await expect(page.locator(".react-grid-item")).toHaveCount(widgets.length);
    await expect(page.getByRole("button", { name: /^Details for / }), "edit mode has no Details button").toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Download CSV/ }), "edit mode has no CSV button").toHaveCount(0);
    await expect(card(page, "Active power").locator(".widget-grip"), "the header is the drag handle and shows the grip").toBeVisible();

    const edit = page.getByRole("button", { name: "Edit Active power", exact: true });
    await expect(edit).toBeEnabled();
    await edit.click();
    const dialog = page.getByRole("dialog", { name: "Edit widget", exact: true });
    await expect(dialog).toBeVisible();
    const preview = dialog.locator(".widget-preview .widget-frame");
    await expect(preview.locator(".widget-body"), "the preview fetches its data").toBeVisible();
    const inEditor = await styleOf(preview);
    expect(inEditor, "the preview card (editor) against the dashboard card: ground, border, radius and title").toEqual(onDashboard);
    expect(inEditor.titleTag, "the title is an h2 in the preview too").toBe("h2");
    expect(css(await groundOf(preview)), "the preview's ground is the --widget-bg token").toBe(css(await tokenRgb(page, "--widget-bg")));
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
  });
}

test("in dark, the drop placeholder and the resize handles show against the card in edit mode", async ({ page }) => {
  test.setTimeout(180_000);
  const stub = await prepare(page);
  await openDashboard(page, stub, DARK);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".react-grid-item")).toHaveCount(widgets.length);
  await settled(page);

  const title = "Active power";
  const frame = card(page, title);
  const item = page.locator(".react-grid-item").filter({ has: frame });
  const cardGround = await groundOf(frame);
  const pageGround = await groundOf(page.locator(".dash-grid-edit"));
  measured("card ground / page ground", [css(cardGround), css(pageGround)]);

  await test.step("the corner handle is an L of --text-2, the edge handles bars of --widget-handle, each seen at 3:1 on the card", async () => {
    const corner = item.locator(".react-resizable-handle-se");
    await expect(corner, "the corner handle").toHaveCount(1);
    const cornerInk = await colourOf(corner, "borderRightColor", "::after");
    const cornerSize = await corner.evaluate((el) => { const s = getComputedStyle(el, "::after"); return { content: s.content, width: s.width, border: s.borderRightWidth }; });
    expect(cornerSize.content, "the corner handle draws its L (the ::after has content)").not.toBe("none");
    expect(contrast(cornerInk, cardGround), `the corner handle ${css(cornerInk)} on the card ${css(cardGround)} (${JSON.stringify(cornerSize)})`).toBeGreaterThanOrEqual(3);
    for (const edge of ["e", "s"] as const) {
      const handle = item.locator(`.react-resizable-handle-${edge}`);
      await expect(handle, `the ${edge} handle`).toHaveCount(1);
      const ink = await colourOf(handle, "backgroundColor", "::after");
      expect(contrast(ink, cardGround), `the ${edge} handle bar ${css(ink)} on the card ${css(cardGround)}`).toBeGreaterThanOrEqual(3);
    }
  });

  await test.step("dragging a card shows the placeholder: a dashed accent outline and a tint, both different from the page", async () => {
    const head = await boxOf(frame.locator(".widget-head"), "the card's header");
    const start = { x: head.x + 44, y: head.y + head.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    try {
      await page.mouse.move(start.x + 14, start.y + 14, { steps: 4 });
      await page.mouse.move(start.x + 260, start.y + 130, { steps: 12 });
      const placeholder = page.locator(".react-grid-placeholder");
      await expect(placeholder, "a drag shows the drop placeholder").toBeVisible();
      const outline = await placeholder.evaluate((el) => { const s = getComputedStyle(el); return { style: s.outlineStyle, width: s.outlineWidth, opacity: s.opacity }; });
      const outlineInk = await colourOf(placeholder, "outlineColor");
      const tint = await colourOf(placeholder, "backgroundColor");
      expect(outline.style, "the outline is dashed").toBe("dashed");
      expect(outline.width, "the outline is 2px").toBe("2px");
      expect(outline.opacity, "the placeholder is not faded").toBe("1");
      expect(contrast(outlineInk, pageGround), `the outline ${css(outlineInk)} on the page ${css(pageGround)}`).toBeGreaterThanOrEqual(3);
      expect(css(tint), `the tint ${css(tint)} differs from the page ground ${css(pageGround)}`).not.toBe(css(pageGround));
    } finally {
      await page.mouse.move(start.x, start.y, { steps: 12 });
      await page.mouse.up();
    }
  });
});
