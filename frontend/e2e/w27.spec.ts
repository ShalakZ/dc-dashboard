import { execFileSync } from "node:child_process";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test";
import { cardText, exactText, familyOf, pickScale, type Marks } from "../src/lib/figures";
import { markGuideSeen, navLink, rowAction } from "./shell";

// W27 (the dashboard experience): figures that read at a glance (separators, MWh and k/M, the exact value one hover away), cards that use their room, the two-step template gallery,
// the first-run guide, "Updated HH:MM" with Refresh, and Make a copy. Admin `admin` / `correct-horse`, as in the earlier projects. The contract is the plan
// docs/superpowers/plans/2026-10-20-w27-dashboard-experience.md (D1 to D9, Review Focus 3 to 6) and the rulings R5, R9, R10, R12 and R13 of .waves/w27.md.
//
// IT NEEDS THE SCRATCH STACK: it runs only when COMPOSE_PROJECT_NAME starts with `dcdash_e2e_` (like w11, w21 and w24 case R) and is skipped with its message otherwise. beforeAll raises
// the raw retention to 90 days (the old value goes back in afterAll), seeds the pilot hall INSIDE the stack (`docker compose exec ... --layout pilot-hall`), makes a site-wide rate when there is
// none, and makes the starter dashboards `w27 <run> power` and `w27 <run> <60 characters>` through POST /api/dashboards with `recipe: "power"`. Nothing is mocked except where a case says so
// (an answer held back, a list answered empty); the expected figures come from POST /api/widget-data with the SAME body the page sent, through lib/figures.ts, never from fixed numbers.
// afterAll puts the stack back: every dashboard `w27 <run> ...`, the role and the account, the rate, the seeded subtree and its source, the retention and the account's own look.
// Every case that opens a dashboard calls markGuideSeen (e2e/shell.ts) except the guide cases (5), which use contexts of their own. Names are matched by SUBSTRING, so every lookup is `exact: true`.
//   1   FIGURES, real data (1920 light, 1440 dark, 1024 light). The Energy and Cost cards show the card face (cardText) of the API's figure, with the exact face (exactText) as the title; both
//       sides of the comparison share one unit and one scale letter; at 1920 the two months sit SIDE BY SIDE (the figures share a row), at 1024 STACKED.
//   2   NO CLIPPING, NO SHIFT (1920, 1440, 1024; light and dark). No card body scrolls, no figure is split over two lines or sticks out of its card, and the Energy and Cost cards (and the grid)
//       keep their size when their answer lands (the answers are held back, then released).
//   3   THE GALLERY BY MOUSE (1440 x 900). "Choose a template", "Recommended for this site" (as the server says; the pilot hall alone: Power, Cost, Energy by area) and "More templates" (Last 24
//       hours, Blank); Cost: Name (placeholder = the title), Range This month, Back to templates returns to the chosen card; Create from Cost and from Energy by area opens in view mode with the widgets
//       the server previewed, position by position; Blank opens in edit mode. 3b: Cancel and Create stay inside the window at 1440 x 900, 1024 x 640 and 800 x 600.
//   4   THE GALLERY BY KEYBOARD ALONE. Enter on "New dashboard"; the first card has the focus; Tab goes through the cards in page order and wraps (Shift+Tab from the first control reaches the
//       last); Enter picks and Name has the focus; Tab wraps on the second step; Escape closes and the focus returns to "New dashboard".
//   5   THE GUIDE (fresh browser contexts). The panel is in the first render (it is there when the first card is), has its lines, Got it closes it and the focus lands on the header's "How to read
//       this", a reload shows none, the header button reopens it and the focus lands on its heading; with localStorage blocked it still shows, closes for the session and stays closed on the way back.
//   6   UPDATED AND REFRESH. "Updated HH:MM" is the site's time, in no live region; Refresh asks again for every card and keeps the focus; at 1024 (sidebar minimised and expanded, a 60 character
//       name, a focus link) the header does not move when the first answer lands or on a Refresh, and its parts stay apart inside the window.
//   7   MAKE A COPY. The row menu has it; "<name> (copy)", then "(copy 2)", each with a toast; the copy's widgets equal the source's (API).
//   8   A VIEWER (a role with only dashboards.view): no "New dashboard", no row menu, no GET /api/dashboard-templates, the server says 403 to the templates and the copy, and an empty list says the old words.
// Assertions that depend on data or timing that nobody could check while writing this are listed in the commit's status block.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const SCRATCH = (process.env.COMPOSE_PROJECT_NAME ?? "").startsWith("dcdash_e2e_");
const SKIP_MESSAGE = "needs the scratch stack's COMPOSE_PROJECT_NAME (dcdash_e2e_*); the seeder refuses anything else";

interface Look { mode: "light" | "dark"; theme: string }
interface Box { x: number; y: number; width: number; height: number }
const LIGHT: Look = { mode: "light", theme: "navy-gold" };
const DARK: Look = { mode: "dark", theme: "desert-gold" };

const RUN = Date.now().toString(36);
const D_POWER = `w27 ${RUN} power`;
/** A 60 character name: it must wrap inside the header at 1024 and push nothing out. */
const D_LONG = `w27 ${RUN} ${"long header name ".repeat(4)}`.slice(0, 59).concat("x");
/** What an earlier run that stopped half way may have left behind: `w27 ` and a run id (Date.now() in base 36 is 8 characters until 2059), nothing a person named. */
const LEFTOVER = /^w27 [0-9a-z]{8}( |$)/;

const SEED_ROOT = "Seeded pilot hall";
const SEED_SOURCE = "seeded-pilot-hall";
const ROLE = "w27-dash-only";
const VIEWER = { username: "w27-viewer", password: "w27-viewer-pass", role: ROLE };
const NOTHING_YET = "Nothing to compare yet";

// ---------------------------------------------------------------------------------------------------------------------------------
// The API shapes this spec reads (written here, so a change of the server shows up as a failure)

interface ApiAsset { id: number; parent_id: number | null; name: string; kind: string }
interface ApiSource { id: number; name: string }
interface ApiUser { id: number; username: string }
interface ApiRole { id: number; name: string; builtin: boolean }
interface ApiTariff { id: number; asset_id: number | null }
interface StorageSettings { raw_retention_days: number; compress_after_days: number; rollup_1m_retention_days: number; disk_capacity_gb: number; warn_threshold_pct: number }
interface ApiWidget { id: number; title: string; type: string; x: number; y: number; w: number; h: number; config: Record<string, unknown> }
interface ApiDashboard { id: number; name: string; range: string; updated_at: string; widgets: ApiWidget[] }
interface TemplateWidget { type: string; x: number; y: number; w: number; h: number; source: string | null; compare: string; bars: string; scope: string }
interface Template { id: string; title: string; description: string; range: string; recommended: boolean; needs: string | null; widgets: TemplateWidget[] }
interface Templates { nothing_metered: boolean; templates: Template[] }
interface WidgetRequest { type: string; config: Record<string, unknown>; range: string; focus?: number }
interface Side { kwh: number; cost: number | null; estimated: boolean; partial: boolean; no_data_days: number }
interface WidgetAnswer {
  source: string; unit: string | null;
  values: { value: number | null; estimated: boolean; partial: boolean; no_data: boolean }[];
  compare: { state: string; days: number; currency: string | null; assets: { this: Side | null; last: Side | null }[] } | null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What the cases share

const real = {
  zone: "", rootId: 0, powerId: 0, longId: 0,
  /** The titles of the starter's data cards, read back from the API: Energy, Cost, the breakdown and the daily chart. */
  titles: { energy: "", cost: "", bars: "", chart: "" },
  dataCards: 0,
  oldStorage: null as StorageSettings | null, siteTariffId: 0,
};
/** Dashboards the cases made (also swept by name); afterAll deletes them. */
const made: number[] = [];
/** The look the account had before this spec (read from GET /api/me in beforeAll); afterAll stores exactly this one. */
let originalLook: Look = LIGHT;

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

async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/** Deletes every top-level asset called `name` with everything below it. */
async function removeTree(request: APIRequestContext, name: string): Promise<void> {
  for (const old of (await json<ApiAsset[]>(request, "/api/assets")).filter((a) => a.parent_id === null && a.name === name)) {
    const gone = await request.delete(`/api/assets/${old.id}?confirm=true`);
    expect([200, 204, 404], `deleting ${name} (${old.id}): ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
}

/** The starter dashboard (or any recipe) through the same route the New dashboard dialog uses. */
async function createFromRecipe(request: APIRequestContext, name: string, recipe: string): Promise<ApiDashboard> {
  const response = await request.post("/api/dashboards", { data: { name, recipe } });
  expect(response.status(), `creating ${name} from ${recipe}: ${response.status()} ${await response.text()}`).toBe(201);
  const dashboard = (await response.json()) as ApiDashboard;
  made.push(dashboard.id);
  return dashboard;
}

async function removeDashboards(request: APIRequestContext, extra: number[] = []): Promise<void> {
  const mine = (await json<{ id: number; name: string }[]>(request, "/api/dashboards")).filter((d) => LEFTOVER.test(d.name) || extra.includes(d.id));
  for (const old of mine) {
    const gone = await request.delete(`/api/dashboards/${old.id}`);
    expect([200, 204, 404], `deleting the dashboard ${old.name}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
}

async function removeAccounts(request: APIRequestContext): Promise<void> {
  for (const user of (await json<ApiUser[]>(request, "/api/users")).filter((u) => u.username === VIEWER.username)) {
    const gone = await request.delete(`/api/users/${user.id}`);
    expect([204, 404], `deleting ${user.username}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
  for (const role of (await json<ApiRole[]>(request, "/api/roles")).filter((r) => !r.builtin && r.name === ROLE)) {
    const gone = await request.delete(`/api/roles/${role.id}`);
    expect([204, 404], `deleting the role ${role.name}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
}

/**
 * Runs the seeder inside the api container of the scratch stack, as w11.spec.ts, w21.spec.ts and w24.spec.ts do, for the pilot hall. A second run finds `seeded-pilot-hall` and exits 1
 * with "already exists": the caller removes any earlier seed first (an old one has no readings after the day it ran), so that is a failure here.
 */
function seedPilotHall(): void {
  try {
    execFileSync("docker", ["compose", "exec", "-T", "-e", "DCDASH_ALLOW_SEED_HISTORY=1", "api", "python", "-m", "dcdash.seed.history", "--layout", "pilot-hall", "--yes"], {
      env: process.env, encoding: "utf8", stdio: "pipe", timeout: 900_000, maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    const failure = e as { status?: number | null; stderr?: string; stdout?: string; message: string };
    throw new Error(`the pilot-hall seeder failed (exit ${failure.status ?? "none"}): ${`${failure.stderr ?? ""}${failure.stdout ?? ""}`.trim() || failure.message}`);
  }
}

async function removeSeed(request: APIRequestContext): Promise<void> {
  await removeTree(request, SEED_ROOT);
  for (const source of (await json<ApiSource[]>(request, "/api/sources")).filter((s) => s.name === SEED_SOURCE)) {
    const gone = await request.delete(`/api/sources/${source.id}?confirm=true`);
    expect([200, 204, 404], `deleting the source ${SEED_SOURCE}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
}

/** The site-local clock, in minutes since midnight, from the site's time zone like the page does. */
function siteMinutes(timezone: string, now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  return Number(parts.find((p) => p.type === "hour")?.value) * 60 + Number(parts.find((p) => p.type === "minute")?.value);
}
/** The distance between two times of day, round the clock. */
const minutesApart = (a: number, b: number): number => Math.min(Math.abs(a - b) % 1440, 1440 - (Math.abs(a - b) % 1440));

// ---------------------------------------------------------------------------------------------------------------------------------
// The browser: sign in, the look, locators, boxes

async function setLook(page: Page, look: Look): Promise<void> {
  const saved = await page.request.put("/api/me/preferences", { data: look });
  expect(saved.ok(), `storing ${JSON.stringify(look)}: ${saved.status()} ${await saved.text()}`).toBe(true);
}

/** Signs in as the admin, stores the look the case needs (the account's saved look wins over the browser's mirror) and marks the guide as seen BEFORE any page opens. */
async function signIn(page: Page, look: Look = LIGHT): Promise<void> {
  await markGuideSeen(page);
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in: ${login.status()} ${await login.text()}`).toBe(true);
  await setLook(page, look);
}

async function expectLook(page: Page, look: Look): Promise<void> {
  await expect(page.locator("html"), `the page is in the ${look.mode} look`).toHaveAttribute("data-mode", look.mode === "dark" ? /dark/ : /light/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", look.theme);
}

const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
/** A card of the dashboard, by its title (every data card is a region named by its title). */
const frameOf = (page: Page, title: string) => page.getByRole("region", { name: title, exact: true });
const dialogNew = (page: Page) => page.getByRole("dialog", { name: "New dashboard", exact: true });
const openLink = (page: Page, name: string) => page.getByRole("link", { name: `Open ${name} page`, exact: true });
const dashboardTitle = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });

/** The rows of a comparing stat (and its headline). */
const statOf = (card: Locator) => ({
  big: card.locator(".stat .big"), num: card.locator(".stat .stat-num"), lastFig: card.locator(".stat-last-fig"), nothing: card.locator(".stat-nothing"),
});

async function boxOf(target: Locator, what: string): Promise<Box> {
  const box = await target.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  expect(box.width * box.height, `${what} has a box`).toBeGreaterThan(0);
  return box;
}
const overlap = (a: Box, b: Box): boolean =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;
const inside = (inner: Box, outer: Box, slack = 1): boolean =>
  inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;
function expectSame(got: Box, want: Box, what: string, tolerance = 1): void {
  for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(got[key] - want[key]), `${what}: ${key} was ${want[key]} and is ${got[key]}`).toBeLessThanOrEqual(tolerance);
}
async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, `${where}: the page does not scroll sideways`).toBeLessThanOrEqual(0);
}
/** The target lies inside the window and what a click at its centre reaches is the target itself. */
async function expectReachable(page: Page, target: Locator, where: string): Promise<void> {
  const view = page.viewportSize()!;
  expect(inside(await boxOf(target, where), { x: 0, y: 0, width: view.width, height: view.height }), `${where} lies inside the window`).toBe(true);
  const reached = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit === el || el.contains(hit);
  });
  expect(reached, `nothing covers ${where}`).toBe(true);
}

async function sidebar(page: Page, want: "expanded" | "minimized"): Promise<void> {
  const shell = page.locator(".shell");
  if ((await shell.getAttribute("data-sidebar")) !== want) await page.locator(".side-toggle").click();
  await expect(shell).toHaveAttribute("data-sidebar", want);
  await settled(page);
}

/** What the page asked for: the widget-data bodies, and the templates requests. */
interface Watch { widget: WidgetRequest[]; templates: string[] }
function watch(page: Page): Watch {
  const seen: Watch = { widget: [], templates: [] };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/widget-data") seen.widget.push(request.postDataJSON() as WidgetRequest);
    if (request.method() === "GET" && url.pathname === "/api/dashboard-templates") seen.templates.push(url.pathname);
  });
  return seen;
}

/** Holds every POST /api/widget-data back until the returned function is called (or 30 seconds pass); calling it lets them through and takes the hold away. */
async function holdAnswers(page: Page): Promise<() => Promise<void>> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const match = (url: URL) => url.pathname === "/api/widget-data";
  const handler = async (route: Route) => {
    await Promise.race([gate, new Promise<void>((resolve) => setTimeout(resolve, 30_000))]);
    try {
      await route.continue();
    } catch {
      // the page moved on before the answer was let through
    }
  };
  await page.route(match, handler);
  return async () => {
    open();
    await page.unroute(match, handler);
  };
}

const dashboardUrl = (id: number): string => `/dashboards/${id}?asset=${real.rootId}`;

/** Opens a dashboard on the pilot hall and waits until every named card is drawn, no skeleton is left and the page has stopped moving. */
async function openDashboard(page: Page, id: number, name: string, titles: string[]): Promise<void> {
  await page.goto(dashboardUrl(id));
  await expect(dashboardTitle(page, name)).toBeVisible();
  for (const title of titles) await expect(frameOf(page, title)).toBeVisible();
  await expect(page.locator(".sk-region, .widget-sk"), "no skeleton is left (the charts load their chunk after the answer)").toHaveCount(0);
  await settled(page);
}
const dataTitles = (): string[] => [real.titles.energy, real.titles.cost, real.titles.bars, real.titles.chart];
const openPower = (page: Page) => openDashboard(page, real.powerId, D_POWER, dataTitles());

/** The Dashboards page; with `templates` it waits until the server's template list has been read (the dialog then opens with every card at once). */
async function openDashboards(page: Page, templates = false): Promise<void> {
  const loaded = templates ? page.waitForResponse((r) => new URL(r.url()).pathname === "/api/dashboard-templates" && r.request().method() === "GET") : null;
  await page.goto("/dashboards");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboards", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: D_POWER, exact: true })).toBeVisible();
  if (loaded) await (await loaded).finished();
  await settled(page);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The figures: what the API says, and what the card should say about it

async function widgetAnswer(request: APIRequestContext, body: WidgetRequest): Promise<WidgetAnswer> {
  const response = await request.post("/api/widget-data", { data: body });
  expect(response.ok(), `POST /api/widget-data: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as WidgetAnswer;
}

interface StatWant { headline: string; headTitle: string | null; last: string; lastTitle: string }

/** The stat card of a comparison, worked out from the answer by the same rules as the page (lib/compare.ts `compareScale`, `sideCardFigure`, StatWidget): one scale over both sides and the headline. */
function expectedStat(answer: WidgetAnswer): StatWant {
  const compare = answer.compare!;
  const asset = compare.assets[0];
  const row = answer.values[0];
  const cost = answer.source === "cost";
  const unit = cost ? compare.currency : "kWh";
  const sideOf = (side: Side | null): number | null => (!side || (compare.days > 0 && side.no_data_days >= compare.days) ? null : cost ? side.cost : side.kwh);
  const marksOf = (side: Side | null): Marks => ({ estimated: side?.estimated ?? false, partial: cost && (side?.partial ?? false) });
  const scale = pickScale(familyOf(unit, cost ? "cost" : "energy"), unit, [sideOf(asset.this), sideOf(asset.last), row.value]);
  const rowMarks: Marks = { estimated: row.estimated, partial: row.partial };
  const measured = row.value !== null && Number.isFinite(row.value);
  const noReading = row.value === null && row.no_data && !cost;
  return {
    headline: noReading ? "no data" : cardText(row.value, scale, rowMarks),
    headTitle: noReading ? "no data" : measured ? exactText(row.value, answer.unit, rowMarks) : null,
    last: cardText(sideOf(asset.last), scale, marksOf(asset.last)),
    lastTitle: exactText(sideOf(asset.last), unit, marksOf(asset.last)),
  };
}
/** The scale letter behind a figure's digits: "275.43k*" and "~275.99k" are k, "275.43" has none. */
const letterOf = (figure: string): string => /([kM])\*?$/.exec(figure)?.[1] ?? "";

/** The card says what the answer says: the card face as text, the exact face as the title, one unit on both sides; and, for a layout, the months side by side or stacked. */
async function expectStatCard(card: Locator, answer: WidgetAnswer, where: string, layout: "side" | "stacked" | null): Promise<void> {
  const stat = statOf(card);
  expect(answer.compare, `${where}: the answer carries a comparison`).toBeTruthy();
  if (answer.compare!.state === "nothing_yet") {
    await expect(stat.nothing, `${where}: on the 1st there is nothing to compare yet`).toHaveText(NOTHING_YET);
    return;
  }
  const want = expectedStat(answer);
  const head = await stat.big.evaluate((el) => {
    const num = el.querySelector(".stat-num")?.textContent ?? "";
    const unit = (el.querySelector(".stat-unit")?.textContent ?? "").trim();
    return { num, unit, text: unit ? `${num} ${unit}` : num, title: el.getAttribute("title") };
  });
  expect(head.text, `${where}: this month on the card face`).toBe(want.headline);
  expect(head.title, `${where}: its title is the exact value`).toBe(want.headTitle);
  const last = await stat.lastFig.evaluate((el) => ({ text: el.textContent ?? "", title: el.getAttribute("title") }));
  expect(last.text, `${where}: last month's same days on the card face`).toBe(want.last);
  expect(last.title, `${where}: its title is the exact value`).toBe(want.lastTitle);
  if (last.text !== "—" && head.num !== "—" && head.num !== "no data") {
    const figure = last.text.split(" ")[0];
    expect(last.text.slice(figure.length).trim(), `${where}: the two sides read in one unit`).toBe(head.unit);
    expect(letterOf(figure), `${where}: and with one scale letter`).toBe(letterOf(head.num));
  }
  if (layout === null) return;
  const [big, num, lastFig] = [await boxOf(stat.big, `${where}: the headline`), await boxOf(stat.num, `${where}: the figure`), await boxOf(stat.lastFig, `${where}: last month's figure`)];
  const cardBox = await boxOf(card, `${where}: the card`);
  const sharesRow = Math.min(num.y + num.height, lastFig.y + lastFig.height) - Math.max(num.y, lastFig.y) > 1;
  if (layout === "side") {
    expect(sharesRow, `${where}: the two figures share a row (card ${Math.round(cardBox.width)} px wide)`).toBe(true);
    expect(lastFig.x, `${where}: last month's figure is to the right of the headline`).toBeGreaterThanOrEqual(big.x + big.width - 1);
  } else {
    expect(sharesRow, `${where}: the two figures do not share a row (card ${Math.round(cardBox.width)} px wide)`).toBe(false);
    expect(lastFig.y, `${where}: last month's figure is under the headline`).toBeGreaterThanOrEqual(num.y + num.height - 1);
  }
}

/** The created widgets as the template previewed them: (type, x, y, w, h, source, compare, bars, scope) of each, in reading order. */
type Row = [string, number, number, number, number, string | null, string, string, string];
const createdRow = (w: ApiWidget): Row => [
  w.type, w.x, w.y, w.w, w.h, (w.config.source as string | undefined) ?? null, (w.config.compare as string | undefined) ?? "none",
  (w.config.bars as string | undefined) ?? "asset", (w.config.scope as string | undefined) ?? "fixed",
];
const previewRow = (w: TemplateWidget): Row => [w.type, w.x, w.y, w.w, w.h, w.source, w.compare, w.bars, w.scope];
const byPlace = <T extends { x: number; y: number }>(list: T[]): T[] => [...list].sort((a, b) => a.y - b.y || a.x - b.x);

test.describe.configure({ mode: "serial" });

test.describe("W27: the dashboard experience on the seeded pilot hall", () => {
  test.skip(!SCRATCH, SKIP_MESSAGE);

  test.beforeAll(async ({ browser }) => {
    if (!SCRATCH) return;
    test.setTimeout(1_500_000);
    await asAdmin(browser, async (request) => {
      const me = await json<{ preferences: Look }>(request, "/api/me");
      originalLook = { mode: me.preferences.mode, theme: me.preferences.theme }; // what the account had before this spec; afterAll puts exactly this back
      const prefs = await request.put("/api/me/preferences", { data: LIGHT });
      expect(prefs.ok(), `starting from the light look: ${prefs.status()} ${await prefs.text()}`).toBe(true);
      real.zone = (await json<{ timezone: string }>(request, "/api/site")).timezone;
      await removeDashboards(request);
      await removeAccounts(request);
      await removeSeed(request); // an earlier seed has no readings after the day it ran

      // Raw retention 90 days BEFORE the seed, so the whole of last month is kept (the seeder starts at the previous month); the old values go back in afterAll.
      const stored = await json<StorageSettings>(request, "/api/settings/storage");
      real.oldStorage = {
        raw_retention_days: stored.raw_retention_days, compress_after_days: stored.compress_after_days, rollup_1m_retention_days: stored.rollup_1m_retention_days,
        disk_capacity_gb: stored.disk_capacity_gb, warn_threshold_pct: stored.warn_threshold_pct,
      };
      if (stored.raw_retention_days < 90) {
        const raised = await request.put("/api/settings/storage?confirm=true", { data: { ...real.oldStorage, raw_retention_days: 90, rollup_1m_retention_days: Math.max(stored.rollup_1m_retention_days, 90) } });
        expect(raised.ok(), `raising the raw retention: ${raised.status()} ${await raised.text()}`).toBe(true);
      }
      // A site-wide rate, when the stack has none (Cost is recommended, and a cost has a figure, only with a rate).
      if (!(await json<ApiTariff[]>(request, "/api/tariffs")).some((t) => t.asset_id === null)) {
        const rate = await request.post("/api/tariffs", { data: { asset_id: null, rate_per_kwh: 0.15, effective_from: "2020-01-01" } });
        expect(rate.status(), `a site-wide rate: ${rate.status()} ${await rate.text()}`).toBe(201);
        real.siteTariffId = ((await rate.json()) as { id: number }).id;
      }
    });
    seedPilotHall();
    await asAdmin(browser, async (request) => {
      const root = (await json<ApiAsset[]>(request, "/api/assets")).find((a) => a.parent_id === null && a.name === SEED_ROOT);
      expect(root, `the seeder made "${SEED_ROOT}"`).toBeTruthy();
      real.rootId = root!.id;
      const power = await createFromRecipe(request, D_POWER, "power");
      real.powerId = power.id;
      real.longId = (await createFromRecipe(request, D_LONG, "power")).id;
      const data = power.widgets.filter((w) => w.type !== "text");
      expect(data.map((w) => w.type), "the starter's data cards: two stats, a breakdown and a daily chart").toEqual(["stat", "stat", "bar", "timeseries"]);
      [real.titles.energy, real.titles.cost, real.titles.bars, real.titles.chart] = data.map((w) => w.title);
      real.dataCards = data.length;
    });
  });

  test.afterAll(async ({ browser }) => {
    if (!SCRATCH) return;
    test.setTimeout(600_000);
    const failures: string[] = [];
    const step = async (what: string, run: (request: APIRequestContext) => Promise<unknown>) => {
      try {
        await asAdmin(browser, run);
      } catch (e) {
        failures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    await step("putting the look back", async (request) => {
      const back = await request.put("/api/me/preferences", { data: originalLook });
      expect(back.ok(), `putting the look back: ${back.status()}`).toBe(true);
    });
    await step("deleting the dashboards", (request) => removeDashboards(request, made));
    await step("deleting the account and the role", removeAccounts);
    await step("deleting the site-wide rate", async (request) => {
      if (real.siteTariffId) await request.delete(`/api/tariffs/${real.siteTariffId}`);
    });
    await step("deleting the seed", removeSeed);
    await step("putting the retention back", async (request) => {
      if (!real.oldStorage || real.oldStorage.raw_retention_days >= 90) return;
      const back = await request.put("/api/settings/storage?confirm=true", { data: real.oldStorage });
      expect(back.ok(), `putting the retention back: ${back.status()} ${await back.text()}`).toBe(true);
    });
    expect(failures, "the clean-up put the stack back").toEqual([]);
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // 1. Figures, real data

  const FIGURE_RUNS = [
    { width: 1920, height: 1080, look: LIGHT, layout: "side" as const },
    { width: 1440, height: 900, look: DARK, layout: null },
    { width: 1024, height: 640, look: LIGHT, layout: "stacked" as const },
  ];
  for (const run of FIGURE_RUNS) {
    test(`1. ${run.width} px, ${run.look.mode}: the Energy and Cost cards say what the API says, on the card face with the exact value as the title${run.layout === "side" ? ", and set the two months side by side" : run.layout === "stacked" ? ", and stack the two months" : ""}`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: run.width, height: run.height });
      const seen = watch(page);
      await signIn(page, run.look);
      await openPower(page);
      await expectLook(page, run.look);
      for (const [title, source] of [[real.titles.energy, "energy"], [real.titles.cost, "cost"]] as const) {
        const body = seen.widget.find((b) => b.type === "stat" && b.config.source === source);
        expect(body, `the page asked for the ${source} stat`).toBeTruthy();
        expect(body!.focus, `and it carried the focus (the pilot hall)`).toBe(real.rootId);
        const answer = await widgetAnswer(page.request, body!);
        await expectStatCard(frameOf(page, title), answer, `${run.width} px ${run.look.mode} ${title}`, run.layout);
      }
    });
  }

  // -------------------------------------------------------------------------------------------------------------------------------
  // 2. No clipping, no shift

  const FIT_SIZES = [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1024, height: 640 }];
  for (const size of FIT_SIZES) {
    test(`2. ${size.width} px, light and dark: no card scrolls, no figure is split or sticks out, and the stat cards keep their size when their answer lands`, async ({ page }) => {
      test.setTimeout(300_000);
      await page.setViewportSize({ width: size.width, height: size.height });
      await signIn(page);
      for (const look of [LIGHT, DARK]) {
        const where = `${size.width} px ${look.mode}`;
        await setLook(page, look);
        // The answers are held back, so the cards are skeletons; then they are let through.
        const release = await holdAnswers(page);
        await page.goto(dashboardUrl(real.powerId));
        await expect(dashboardTitle(page, D_POWER)).toBeVisible();
        for (const title of dataTitles()) await expect(frameOf(page, title)).toBeVisible();
        await expect(page.locator(".widget-sk"), `${where}: the cards are skeletons while their answers are held`).not.toHaveCount(0);
        await expectLook(page, look);
        await settled(page);
        const stats = [frameOf(page, real.titles.energy), frameOf(page, real.titles.cost)];
        const grid = page.locator(".dash-grid");
        const before = [await boxOf(stats[0], `${where}: Energy while loading`), await boxOf(stats[1], `${where}: Cost while loading`)];
        const gridBefore = await boxOf(grid, `${where}: the grid while loading`);
        await release();
        await expect(page.locator(".sk-region, .widget-sk"), `${where}: no skeleton is left`).toHaveCount(0);
        await settled(page);
        expectSame(await boxOf(stats[0], `${where}: Energy`), before[0], `${where}: the Energy card keeps its box when its answer lands`);
        expectSame(await boxOf(stats[1], `${where}: Cost`), before[1], `${where}: the Cost card keeps its box when its answer lands`);
        expectSame(await boxOf(grid, `${where}: the grid`), gridBefore, `${where}: the grid keeps its box when the answers land`);

        const problems = await page.evaluate(() => {
          const out: string[] = [];
          const lines = (el: Element): number => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return new Set(Array.from(range.getClientRects()).filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
          };
          for (const frame of document.querySelectorAll<HTMLElement>(".widget-frame")) {
            const title = frame.getAttribute("aria-label") ?? "(card)";
            const body = frame.querySelector<HTMLElement>(".widget-body");
            if (body && (body.scrollWidth > body.clientWidth + 1 || body.scrollHeight > body.clientHeight + 1)) {
              out.push(`${title}: the body scrolls (${body.scrollWidth} x ${body.scrollHeight} in ${body.clientWidth} x ${body.clientHeight})`);
            }
            const room = (body ?? frame).getBoundingClientRect();
            for (const el of frame.querySelectorAll<HTMLElement>(".stat-num, .stat-unit, .stat-last-fig")) {
              if (lines(el) > 1) out.push(`${title}: "${el.textContent}" is split over ${lines(el)} lines`);
              const box = el.getBoundingClientRect();
              if (box.right > room.right + 1 || box.left < room.left - 1) out.push(`${title}: "${el.textContent}" sticks out of the card`);
            }
            const last = frame.querySelector<HTMLElement>(".stat-last-fig");
            if (last && last.scrollWidth > last.clientWidth + 1) out.push(`${title}: last month's figure is cut off ("${last.textContent}")`);
          }
          return out;
        });
        expect(problems, `${where}: nothing clips or splits`).toEqual([]);
        await expectNoSidewaysScroll(page, where);
      }
    });
  }

  // -------------------------------------------------------------------------------------------------------------------------------
  // 3. The gallery by mouse

  test("3. New dashboard: Choose a template, Recommended for this site, More templates; Cost and Energy by area are created as previewed, Blank opens in edit mode", async ({ page }) => {
    test.setTimeout(360_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const seen = watch(page);
    await signIn(page);
    const templates = await json<Templates>(page.request, "/api/dashboard-templates");
    expect(templates.templates.map((t) => t.id), "the server's templates, in its order").toEqual(["power", "cost", "areas", "day"]);
    const titles = templates.templates.map((t) => t.title);
    const wantRecommended = templates.templates.filter((t) => t.recommended).map((t) => t.title);
    const wantMore = [...templates.templates.filter((t) => !t.recommended).map((t) => t.title), "Blank"];
    expect(wantRecommended, "the pilot hall has meters, so Power is recommended").toContain("Power");
    expect(wantMore, "Last 24 hours is never recommended").toContain("Last 24 hours");
    // On a stack whose only top-level asset is the pilot hall the three are recommended, as the owner's brief says; with other top-level assets the default focus differs and the server decides.
    const roots = (await json<ApiAsset[]>(page.request, "/api/assets")).filter((a) => a.parent_id === null);
    if (roots.length === 1) expect(wantRecommended, "on the pilot hall alone").toEqual(["Power", "Cost", "Energy by area"]);

    await openDashboards(page, true);
    await button(page, "New dashboard").click();
    const dialog = dialogNew(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Choose a template", exact: true })).toBeVisible();
    await expect(dialog.locator("button.tpl-card"), "every template once, and Blank").toHaveCount(titles.length + 1);
    const recommended = dialog.getByRole("region", { name: "Recommended for this site", exact: true });
    const more = dialog.getByRole("region", { name: "More templates", exact: true });
    await expect(recommended.locator(".tpl-title"), "Recommended holds what the server recommends").toHaveText(wantRecommended);
    await expect(more.locator(".tpl-title"), "More templates holds the rest, Blank last").toHaveText(wantMore);
    await expect(recommended.getByRole("button", { name: "Blank", exact: true }), "Blank is never recommended").toHaveCount(0);
    await expect(recommended.locator(".tpl-tag")).toHaveCount(wantRecommended.length);
    await expect(more.locator(".tpl-tag"), "only the recommended cards carry the tag").toHaveCount(0);
    await expect(recommended.locator(".tpl-tag").first()).toHaveText("Recommended");
    const radius = await recommended.locator(".tpl-tag").first().evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
    expect(radius, "the tag is a rectangle, not a pill").toBeLessThanOrEqual(4);

    // Step 2 of Cost, and back.
    await dialog.getByRole("button", { name: "Cost", exact: true }).click();
    const name = dialog.getByLabel("Name", { exact: true });
    const range = dialog.getByLabel("Range", { exact: true });
    await expect(name, "step 2 puts the focus on Name").toBeFocused();
    await expect(name, "the placeholder is the template's title").toHaveAttribute("placeholder", "Cost");
    await expect(range).toHaveValue("this_month");
    await expect(range.locator("option:checked"), "the range reads This month").toHaveText("This month");
    await dialog.getByRole("button", { name: "Back to templates", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Choose a template", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cost", exact: true }), "Back returns with the focus on the card that was chosen").toBeFocused();

    // Create from Cost and from Energy by area: the new dashboard opens in view mode with what the template previewed.
    for (const [id, label] of [["cost", "Cost"], ["areas", "Energy by area"]] as const) {
      if (id !== "cost") {
        await openDashboards(page, true);
        await button(page, "New dashboard").click();
        await expect(dialog).toBeVisible();
      }
      const template = templates.templates.find((t) => t.id === id)!;
      const newName = `w27 ${RUN} ${id}`;
      await dialog.getByRole("button", { name: label, exact: true }).click();
      await name.fill(newName);
      await dialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(page).toHaveURL(/\/dashboards\/\d+$/);
      const newId = Number(new URL(page.url()).pathname.split("/").pop());
      made.push(newId);
      await expect(dashboardTitle(page, newName)).toBeVisible();
      await expect(button(page, "Edit"), `${label} opens in view mode`).toBeVisible();
      await expect(button(page, "Save")).toHaveCount(0);
      const dashboard = await json<ApiDashboard>(page.request, `/api/dashboards/${newId}`);
      expect(dashboard.widgets.length, `${label}: as many widgets as the server says`).toBe(template.widgets.length);
      expect(byPlace(dashboard.widgets).map(createdRow), `${label}: each widget is where the preview put it`).toEqual(byPlace(template.widgets).map(previewRow));
      expect(dashboard.range, `${label}: on the template's range`).toBe(template.range);
    }

    // Blank opens in edit mode.
    await openDashboards(page, true);
    await button(page, "New dashboard").click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Blank", exact: true }).click();
    const blankName = `w27 ${RUN} blank`;
    await name.fill(blankName);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboards\/\d+$/);
    made.push(Number(new URL(page.url()).pathname.split("/").pop()));
    await expect(dashboardTitle(page, blankName)).toBeVisible();
    await expect(button(page, "Save"), "Blank opens in edit mode").toBeVisible();
    await button(page, "Cancel").click();
    await expect(button(page, "Edit")).toBeVisible();
    expect(seen.templates.length, "the editor's page asked for the templates").toBeGreaterThan(0);
  });

  const DIALOG_SIZES = [{ width: 1440, height: 900 }, { width: 1024, height: 640 }, { width: 800, height: 600 }];
  for (const size of DIALOG_SIZES) {
    test(`3b. ${size.width} x ${size.height}, light and dark: Cancel on the first step and Back, Cancel and Create on the second stay inside the window and reachable`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(size);
      await signIn(page);
      for (const look of [LIGHT, DARK]) {
        const where = `${size.width} x ${size.height} ${look.mode}`;
        await setLook(page, look);
        await openDashboards(page, true);
        await button(page, "New dashboard").click();
        const dialog = dialogNew(page);
        await expect(dialog).toBeVisible();
        await expectLook(page, look);
        await expect(dialog.locator("button.tpl-card")).toHaveCount(5);
        await expectReachable(page, dialog.getByRole("button", { name: "Cancel", exact: true }), `${where}: Cancel on step 1`);
        expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth), `${where}: the dialog has no horizontal scroll`).toBeLessThanOrEqual(1);
        await dialog.getByRole("button", { name: "Power", exact: true }).click();
        await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
        for (const label of ["Back to templates", "Cancel", "Create"]) await expectReachable(page, dialog.getByRole("button", { name: label, exact: true }), `${where}: ${label} on step 2`);
        expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth), `${where}: step 2 has no horizontal scroll`).toBeLessThanOrEqual(1);
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(dialog).toBeHidden();
      }
    });
  }

  // -------------------------------------------------------------------------------------------------------------------------------
  // 4. The gallery by keyboard alone

  const activeNow = (page: Page) => page.evaluate(() => {
    const a = document.activeElement;
    return { template: a?.getAttribute("data-template") ?? null, name: (a?.textContent ?? "").trim().slice(0, 40) };
  });

  test("4. by keyboard alone: Enter opens the gallery, Tab goes through the cards and wraps, Enter picks and Name has the focus, Escape closes and the focus returns to New dashboard", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openDashboards(page, true);
    const opener = button(page, "New dashboard");
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = dialogNew(page);
    await expect(dialog).toBeVisible();
    const cards = dialog.locator("button.tpl-card");
    await expect(cards).toHaveCount(5);
    const order = await cards.evaluateAll((els) => els.map((el) => el.getAttribute("data-template") ?? ""));
    expect(order[order.length - 1], "Blank is the last card").toBe("blank");

    expect((await activeNow(page)).template, "the first card has the focus when the dialog opens").toBe(order[0]);
    for (let i = 1; i < order.length; i++) {
      await page.keyboard.press("Tab");
      expect((await activeNow(page)).template, `Tab ${i} reaches card ${order[i]}, in page order`).toBe(order[i]);
    }
    await page.keyboard.press("Tab");
    expect((await activeNow(page)).name, "after the last card comes Cancel").toBe("Cancel");
    await page.keyboard.press("Tab");
    expect((await activeNow(page)).template, "Tab from the last control wraps to the first card").toBe(order[0]);
    await page.keyboard.press("Shift+Tab");
    expect((await activeNow(page)).name, "Shift+Tab from the first control reaches the last").toBe("Cancel");
    await page.keyboard.press("Shift+Tab");
    expect((await activeNow(page)).template, "and back to the last card").toBe(order[order.length - 1]);

    // Tab to Cost (a few presses at most) and pick it with Enter.
    for (let i = 0; i < order.length + 2 && (await activeNow(page)).template !== "cost"; i++) await page.keyboard.press("Tab");
    expect((await activeNow(page)).template, "the Cost card has the focus").toBe("cost");
    await page.keyboard.press("Enter");
    const name = dialog.getByLabel("Name", { exact: true });
    await expect(name, "Enter picks the card and Name has the focus").toBeFocused();
    await expect(name).toHaveAttribute("placeholder", "Cost");

    // The second step wraps too.
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Create", exact: true }), "Shift+Tab from Name reaches Create").toBeFocused();
    await page.keyboard.press("Tab");
    await expect(name, "and Tab from Create wraps to Name").toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog, "Escape closes the dialog").toBeHidden();
    await expect(opener, "and the focus returns to New dashboard").toBeFocused();
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // 5. The guide

  /** A browser context of its own (no storage, so the guide is due), signed in as the admin, with the look the case needs. */
  async function freshContext(browser: Browser, blocked: boolean): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 } });
    if (blocked) {
      await context.addInitScript(() => {
        Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("localStorage is blocked", "SecurityError"); } });
      });
    }
    const login = await context.request.post("/api/login", { data: ADMIN });
    expect(login.ok(), `signing in: ${login.status()} ${await login.text()}`).toBe(true);
    const look = await context.request.put("/api/me/preferences", { data: LIGHT });
    expect(look.ok(), `the light look: ${look.status()} ${await look.text()}`).toBe(true);
    return { context, page: await context.newPage() };
  }
  const guideHeading = (page: Page) => page.getByRole("heading", { name: "How to read this dashboard", exact: true });
  const guideButton = (page: Page) => page.getByRole("button", { name: "How to read this", exact: true });

  test("5. a fresh browser: the panel is there with the first card, Got it closes it and the focus lands on How to read this, a reload shows none, the header button reopens it on its heading", async ({ browser }) => {
    test.setTimeout(240_000);
    const { context, page } = await freshContext(browser, false);
    try {
      // Written before the page exists: at the moment the first card is in the document, is the panel in it already?
      await context.addInitScript(() => {
        const w = window as unknown as { __guide: { atFirstCard: boolean | null; firstCardTop: number | null } };
        w.__guide = { atFirstCard: null, firstCardTop: null };
        new MutationObserver(() => {
          if (w.__guide.atFirstCard !== null) return;
          const card = document.querySelector(".widget-frame");
          if (!card) return;
          w.__guide.atFirstCard = document.querySelector(".dash-guide") !== null;
          w.__guide.firstCardTop = card.getBoundingClientRect().top;
        }).observe(document, { childList: true, subtree: true });
      });
      await page.goto(dashboardUrl(real.powerId));
      await expect(dashboardTitle(page, D_POWER)).toBeVisible();
      await expect(guideHeading(page), "the guide is open on a first visit").toBeVisible();
      await expect(frameOf(page, real.titles.energy)).toBeVisible();
      await expect(page.locator(".sk-region, .widget-sk")).toHaveCount(0);
      await settled(page);
      const guide = await page.evaluate(() => (window as unknown as { __guide: { atFirstCard: boolean | null; firstCardTop: number | null } }).__guide);
      expect(guide.atFirstCard, "the panel was already in the page when the first card appeared (it is never inserted late)").toBe(true);
      const top = await page.evaluate((title) => document.querySelector(`.widget-frame[aria-label="${title}"]`)?.getBoundingClientRect().top ?? -1, real.titles.energy);
      expect(Math.abs(top - guide.firstCardTop!), "and the first card did not move afterwards").toBeLessThanOrEqual(2);
      await expect(page.locator(".dash-guide li"), "the starter has all five lines (a comparison, a focus, a breakdown, the marks, the buttons)").toHaveCount(5);
      await expect(guideButton(page), "the header offers it again").toBeVisible();

      await button(page, "Got it").click();
      await expect(guideHeading(page), "Got it closes the panel").toHaveCount(0);
      await expect(guideButton(page), "and the focus lands on the header's How to read this").toBeFocused();

      await page.reload();
      await expect(dashboardTitle(page, D_POWER)).toBeVisible();
      await expect(frameOf(page, real.titles.energy)).toBeVisible();
      await settled(page);
      await expect(guideHeading(page), "a reload shows no panel").toHaveCount(0);
      expect(await page.evaluate(() => Object.keys(window.localStorage).filter((k) => k.startsWith("dcdash.guide.dashboard.v1:")).length), "the browser remembers it").toBe(1);

      await guideButton(page).click();
      await expect(guideHeading(page), "the header button reopens it").toBeVisible();
      await expect(guideHeading(page), "with the focus on its heading").toBeFocused();
      await button(page, "Got it").click();
      await expect(guideButton(page)).toBeFocused();
    } finally {
      await context.close();
    }
  });

  test("5. with localStorage blocked the panel still shows, closes for the session and stays closed on the way back", async ({ browser }) => {
    test.setTimeout(240_000);
    const { context, page } = await freshContext(browser, true);
    try {
      await page.goto(dashboardUrl(real.powerId));
      await expect(dashboardTitle(page, D_POWER)).toBeVisible();
      await expect(guideHeading(page), "the guide shows although nothing can be remembered").toBeVisible();
      await expect(frameOf(page, real.titles.energy)).toBeVisible();
      await button(page, "Got it").click();
      await expect(guideHeading(page), "Got it closes it for the session").toHaveCount(0);
      await expect(guideButton(page)).toBeFocused();
      // Away to the list and back by the page's own links (no reload): the session remembers.
      await navLink(page, "Dashboards").click();
      await expect(page.getByRole("heading", { level: 1, name: "Dashboards", exact: true })).toBeVisible();
      await page.getByRole("link", { name: D_POWER, exact: true }).click();
      await expect(dashboardTitle(page, D_POWER)).toBeVisible();
      await expect(guideButton(page)).toBeVisible();
      await settled(page);
      await expect(guideHeading(page), "back on the dashboard in the same session the panel stays closed").toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // 6. Updated and Refresh

  test("6. Updated is the site's time and in no live region; Refresh asks every card again and keeps the focus", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const seen = watch(page);
    await signIn(page);
    await openPower(page);
    const updated = page.locator(".dash-updated");
    await expect(updated, "the header says when the figures were read").toHaveText(/^Updated \d\d:\d\d$/);
    const clock = async (): Promise<number> => {
      const [h, m] = ((await updated.textContent()) ?? "").replace("Updated ", "").split(":").map(Number);
      return h * 60 + m;
    };
    expect(minutesApart(await clock(), siteMinutes(real.zone)), "it is the time at the site (a few minutes of slack for a slow run)").toBeLessThanOrEqual(3);
    expect(
      await updated.evaluate((el) => el.closest('[aria-live], [role="status"], [role="alert"], [role="log"]') === null),
      "the time is in no live region (it changes with every refetch and must not be read out)",
    ).toBe(true);

    const before = seen.widget.length;
    const refresh = button(page, "Refresh");
    await refresh.click();
    await expect.poll(() => seen.widget.length, { message: "Refresh asked for the figures of every card again" }).toBeGreaterThanOrEqual(before + real.dataCards);
    await expect(refresh, "the button keeps the focus the click gave it").toBeFocused();
    await expect(page.locator('.dash-fresh button[aria-disabled="true"]'), "it waits only while the figures are being read").toHaveCount(0);
    await expect(refresh).toBeFocused();
    await expect(updated).toHaveText(/^Updated \d\d:\d\d$/);
    expect(minutesApart(await clock(), siteMinutes(real.zone)), "and the time is still the site's now").toBeLessThanOrEqual(3);
    await expect(page.locator(".sk-region, .widget-sk"), "no card went back to a skeleton").toHaveCount(0);
  });

  for (const bar of ["minimized", "expanded"] as const) {
    test(`6. 1024 px, sidebar ${bar}, a 60 character name and a focus link: the header does not move when the first answer lands or on a Refresh, and its parts stay apart inside the window`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: 1024, height: 768 });
      await signIn(page);
      const where = `1024 px ${bar}`;
      expect(D_LONG.length, "the name has 60 characters").toBe(60);
      const release = await holdAnswers(page);
      await page.goto(dashboardUrl(real.longId));
      await expect(dashboardTitle(page, D_LONG)).toBeVisible();
      await expect(openLink(page, SEED_ROOT), `${where}: the focus link`).toBeVisible();
      await sidebar(page, bar);
      await expect(page.locator(".widget-sk"), `${where}: the answers are still held`).not.toHaveCount(0);
      const parts: [string, Locator][] = [
        ["the title", dashboardTitle(page, D_LONG)], ["Refresh", button(page, "Refresh")], ["How to read this", guideButton(page)],
        ["Dashboard range", page.getByLabel("Dashboard range")], ["Focus", button(page, "Focus")], ["the focus link", openLink(page, SEED_ROOT)], ["Edit", button(page, "Edit")],
      ];
      const head = page.locator("div.dash-head").filter({ has: page.locator("h1") }); // the page's loading skeleton has a header of the same class, without an h1
      const measure = async (): Promise<[string, Box][]> => {
        const boxes: [string, Box][] = [["the header", await boxOf(head, `${where}: the header`)]];
        for (const [what, target] of parts) boxes.push([what, await boxOf(target, `${where}: ${what}`)]);
        return boxes;
      };
      const empty = await measure(); // the time's slot is there but empty
      await release();
      await expect(page.locator(".dash-updated"), `${where}: the time has landed`).toHaveText(/^Updated \d\d:\d\d$/);
      await expect(page.locator(".sk-region, .widget-sk")).toHaveCount(0);
      await settled(page);
      const full = await measure();
      for (const [i, [what, box]] of full.entries()) expectSame(box, empty[i][1], `${where}: ${what} does not move when the first answer lands`, 1);

      // Apart and inside the window.
      const view = { x: 0, y: 0, width: 1024, height: 100_000 };
      const pieces = full.slice(1);
      for (let i = 0; i < pieces.length; i++) {
        expect(inside(pieces[i][1], view), `${where}: ${pieces[i][0]} lies inside the window`).toBe(true);
        for (let j = i + 1; j < pieces.length; j++) expect(overlap(pieces[i][1], pieces[j][1]), `${where}: ${pieces[i][0]} and ${pieces[j][0]} do not overlap`).toBe(false);
      }
      await expectNoSidewaysScroll(page, where);

      // A Refresh changes neither the header nor the places of the buttons.
      await button(page, "Refresh").click();
      await expect(page.locator('.dash-fresh button[aria-disabled="true"]')).toHaveCount(0);
      await settled(page);
      const after = await measure();
      for (const [i, [what, box]] of after.entries()) expectSame(box, full[i][1], `${where}: ${what} does not move on a Refresh`, 1);
      await expectNoSidewaysScroll(page, `${where} after Refresh`);
    });
  }

  // -------------------------------------------------------------------------------------------------------------------------------
  // 7. Make a copy

  test("7. the row menu has Make a copy: (copy), then (copy 2), each with a toast, and the copy's widgets equal the source's", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openDashboards(page);
    const source = await json<ApiDashboard>(page.request, `/api/dashboards/${real.powerId}`);
    expect(source.widgets.length, "the source has widgets").toBeGreaterThan(0);
    const rowOf = (name: string) => page.getByRole("row").filter({ has: page.getByRole("link", { name, exact: true }) });
    const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const shape = (d: ApiDashboard) => d.widgets.map((w) => ({ title: w.title, type: w.type, x: w.x, y: w.y, w: w.w, h: w.h, config: w.config }));

    for (const copyName of [`${D_POWER} (copy)`, `${D_POWER} (copy 2)`]) {
      await (await rowAction(page, rowOf(D_POWER), "Make a copy")).click();
      await expect(page.getByRole("link", { name: copyName, exact: true }), `the list gains ${copyName}`).toBeVisible();
      await expect(page.locator(".toast-stack .toast-text").filter({ hasText: new RegExp(`^Copied to ${escaped(copyName)}$`) }), "and a toast names it").toBeVisible();
      const list = await json<{ id: number; name: string }[]>(page.request, "/api/dashboards");
      const copy = list.find((d) => d.name === copyName);
      expect(copy, `${copyName} is in the API's list`).toBeTruthy();
      made.push(copy!.id);
      expect(shape(await json<ApiDashboard>(page.request, `/api/dashboards/${copy!.id}`)), `${copyName} has the source's widgets`).toEqual(shape(source));
    }
    // Delete both copies; the source stays for the other cases.
    for (const copyName of [`${D_POWER} (copy)`, `${D_POWER} (copy 2)`]) {
      const copy = (await json<{ id: number; name: string }[]>(page.request, "/api/dashboards")).find((d) => d.name === copyName);
      if (copy) expect([200, 204, 404], `deleting ${copyName}`).toContain((await page.request.delete(`/api/dashboards/${copy.id}`)).status());
    }
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // 8. A viewer

  test("8. a role with dashboards.view only: no New dashboard, no row menu, no templates request, the server says 403, and an empty list says the old words", async ({ browser, page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await asAdmin(browser, async (request) => {
      await removeAccounts(request);
      const role = await request.post("/api/roles", { data: { name: ROLE, description: "made by w27.spec.ts", permissions: ["dashboards.view"] } });
      expect(role.status(), `creating the role: ${await role.text()}`).toBe(201);
      const user = await request.post("/api/users", { data: { username: VIEWER.username, password: VIEWER.password, role: VIEWER.role } });
      expect(user.status(), `creating the account: ${await user.text()}`).toBe(201);
    });
    try {
      const seen = watch(page);
      await markGuideSeen(page);
      const login = await page.request.post("/api/login", { data: { username: VIEWER.username, password: VIEWER.password } });
      expect(login.ok(), `signing in as the account: ${login.status()} ${await login.text()}`).toBe(true);
      await openDashboards(page);
      await expect(button(page, "New dashboard"), "the viewer cannot make a dashboard").toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Actions for / }), "and has no row menu").toHaveCount(0);
      await expect(page.getByRole("link", { name: D_POWER, exact: true }), "the viewer reads the list").toBeVisible();
      expect(seen.templates, "the page never asks the server for templates").toEqual([]);
      expect((await page.request.get("/api/dashboard-templates")).status(), "the server refuses the templates").toBe(403);
      expect((await page.request.post(`/api/dashboards/${real.powerId}/copy`)).status(), "and the copy").toBe(403);

      // An empty list: the old words, no template cards, still no request.
      await page.route((url) => url.pathname === "/api/dashboards", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: "[]" }) : route.fallback()));
      await page.goto("/dashboards");
      await expect(page.getByText("No dashboards yet.", { exact: true }), "an empty list says the old words").toBeVisible();
      await expect(button(page, "Blank"), "with no template cards").toHaveCount(0);
      await expect(button(page, "Power")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "More templates", exact: true })).toHaveCount(0);
      await settled(page);
      expect(seen.templates, "and no templates request on the empty page either").toEqual([]);
    } finally {
      await asAdmin(browser, removeAccounts);
    }
  });
});
