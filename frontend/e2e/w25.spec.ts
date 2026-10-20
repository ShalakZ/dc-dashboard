import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";

// W25 (the power dashboard, part 3b): a focus asset in the address (`?asset=<id>`), cards that follow it, drill-through on the breakdown, and the starter "Power" dashboard. Admin `admin` /
// `correct-horse`, as in the earlier projects. The contract is the plan docs/superpowers/plans/2026-10-19-w25-power-focus-and-starter.md (section 2) and the rulings R1 to R13 of .waves/w25.md.
//
// IT MAKES ITS OWN DATA and needs nothing from the stack: beforeAll makes `W25 Site` > `W25 Hall 1` > `W25 Row 1` > three racks, `W25 Hall 2` (with one asset of a very long name) and a Panel `W25 Panel A`
// beside the halls, and the dashboards the cases need (`w25 <run> follow`, `... edit`, `... drill`, `... plain`, and one with a very long name). afterAll deletes them, the role and the user of case 4 and the
// look it changed, each step on its own, also after a failed case. The stack may hold other top-level assets (the look stack's pilot hall, the other specs' leftovers): every expectation that depends on
// how many there are READS that number from `GET /api/assets` first. The cases are serial. Names are matched by SUBSTRING, so every lookup is `exact: true`. The words are written here again, as
// literals (src/lib/focus.ts, src/lib/breakdown.ts), so a change of wording shows up as a failure.
//   1   ADDRESS AND BACK. `?asset=<hall>` opens focused: the trail, the link "Open W25 Hall 1 page"; a card that follows the focus sends `focus` in its request and a fixed card does not, and a fixed
//       card makes no new request when the focus changes; choosing a focus in the dialog pushes one history entry, Back returns to the one before, the range picked for the visit stays.
//   2   THE TRAIL GOES UP. From a rack, each ancestor crumb moves the focus up (Back walks back) and the keyboard focus lands on the new current crumb, the dashboard crumb clears the focus; the page
//       holds exactly one navigation named Breadcrumb.
//   3   GONE AND INVALID LINKS. A number that is no asset, text, 0 and a number past the id range, and an asset deleted just before the load: the whole site, the line "The asset in this link no longer
//       exists, ...", `asset` dropped from the address; choosing a focus in the same visit takes the line away.
//   4   NO `assets.view`. A role made through the API with `dashboards.view` only: no Focus button, no Open page link, `?asset` ignored with its own line, no `GET /api/assets`, and a 403 from the
//       widget-data routes only when the body carries a `focus`.
//   5   SEVERAL TOP-LEVEL ASSETS (a second root made in the case and removed in it): a card that follows the focus says "This site has N top-level assets: ..." through the real server, a children card lists
//       the roots, a breakdown looks at the whole site. The LAST case checks ONE top-level asset: it is the focus without being chosen (it runs only when the stack has at most one top-level asset besides
//       this spec's own, and it removes `W25 Site` first when there is one).
//   6   START FROM POWER, through the dialog: five widgets, view mode, the name "Power" for an empty name, the server's name-taken line for a second one, the cards follow `?asset=`; the empty page's two buttons.
//   7   DRILL-THROUGH, fixture-driven: the breakdown's POST /api/widget-data is answered in the page with bars that are real asset ids. A click on the canvas (the bar is found by its pixels) narrows to an
//       asset with children and opens the page of a leaf; so does a click on the axis name; by keyboard Details, Tab to "Narrow to ..." and Enter. Where NO widget of the dashboard follows the
//       focus a click opens the page even of an asset with children and Details has no "Narrow to". Edit mode has none of it.
//   8   THE EDITOR. In edit mode with a focus: no Focus button, the quiet line; a stat set to "The focus asset" and a breakdown under "The focus asset" save with `scope: "focus"`, empty assets and no
//       `root`, and reopen with the choice made; a stored fixed widget's config is byte for byte the same after a save.
//   9   LOOK AND SIZE. The header's Focus, Open page and Edit (a long dashboard name, a long asset name) at 1440 and at 1024 with the sidebar minimised and expanded, light and dark; the Focus dialog at
//       1440 x 900, 1024 x 640 and 800 x 600; a following card is dimmed and busy while the answer for the new focus is held. No timing is asserted.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";

interface Look { mode: "light" | "dark"; theme: string }
interface Box { x: number; y: number; width: number; height: number }
const LIGHT: Look = { mode: "light", theme: "navy-gold" };
const DARK: Look = { mode: "dark", theme: "desert-gold" };

const RUN = Date.now().toString(36);
const D_FOLLOW = `w25 ${RUN} follow`;
const D_EDIT = `w25 ${RUN} edit`;
const D_DRILL = `w25 ${RUN} drill`;
const D_PLAIN = `w25 ${RUN} plain`;
const D_LONG = `w25 ${RUN} very long dashboard name `.concat("that goes on and on ".repeat(6)).slice(0, 96).trimEnd();
/** What an earlier run that stopped half way may have left behind: `w25 ` and a run id (Date.now() in base 36 is 8 characters until 2059), nothing a person named. */
const LEFTOVER = /^w25 [0-9a-z]{8}( |$)/;

const SITE = "W25 Site";
const OTHER = "W25 Other Site";
const HALL1 = "W25 Hall 1";
const ROW = "W25 Row 1";
const RACKS = ["W25 Rack 01", "W25 Rack 02", "W25 Rack 03"] as const;
const HALL2 = "W25 Hall 2";
const PANEL = "W25 Panel A";
const LONG_ASSET = "W25 Long ".concat("name ".repeat(14)).trimEnd();

const T_FOLLOW = "W25 follows";
const T_FIXED = "W25 fixed";
const T_BARS = "W25 bars";
const T_CHILDREN = "W25 children";
const T_DRILL = "W25 drill";

const GONE = "The asset in this link no longer exists, so the dashboard shows the whole site.";
const DENIED = "This link opens the dashboard on one asset. Your role cannot open assets, so it shows the whole site.";
const COMPARE = "same_days_last_month";

const ROLE = "w25-dash-only";
const VIEWER = { username: "w25-viewer", password: "w25-viewer-pass", role: ROLE };

test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------------------------------------------------------------
// The data, the dashboards and the look

const ids = { site: 0, hall1: 0, row: 0, racks: [0, 0, 0], hall2: 0, panel: 0, long: 0 };
let followId = 0;
let editId = 0;
let drillId = 0;
let plainId = 0;
let longId = 0;
/** A dashboard called Power that was there before this spec (case 6 then leaves the starter alone). */
let powerTaken = false;
/** The dashboards case 6 made; afterAll deletes them even if the case did not get to its own clean-up. */
const powerIds: number[] = [];
/** The look the account had before this spec (read from GET /api/me in beforeAll); afterAll stores exactly this one. */
let originalLook: Look = LIGHT;

interface ApiAsset { id: number; parent_id: number | null; name: string; kind: string; sort_order: number }
interface ApiUser { id: number; username: string }
interface ApiRole { id: number; name: string; builtin: boolean }
interface WidgetBody { title: string; type: string; x: number; y: number; w: number; h: number; config: Record<string, unknown> }
interface ApiWidget extends WidgetBody { id: number }
interface ApiDashboard { id: number; name: string; range: string; updated_at: string; widgets: ApiWidget[] }

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

async function createAsset(request: APIRequestContext, name: string, parentId: number | null, kind: string, order: number): Promise<number> {
  const made = await request.post("/api/assets", { data: { name, parent_id: parentId, kind, sort_order: order } });
  expect(made.status(), `creating ${name}: ${made.status()} ${await made.text()}`).toBe(201);
  return ((await made.json()) as { id: number }).id;
}

async function deleteAsset(request: APIRequestContext, id: number): Promise<void> {
  const gone = await request.delete(`/api/assets/${id}?confirm=true`);
  expect([200, 204, 404], `deleting asset ${id}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
}

/** Deletes every top-level asset called `name` with everything below it. */
async function removeTree(request: APIRequestContext, name: string): Promise<void> {
  for (const old of (await json<ApiAsset[]>(request, "/api/assets")).filter((a) => a.parent_id === null && a.name === name)) await deleteAsset(request, old.id);
}

const topLevelOf = (assets: ApiAsset[]): ApiAsset[] => assets.filter((a) => a.parent_id === null);

/** The data config of a widget as the API stores it; the w25 key `scope` is added by the caller only when it is not the default. */
function config(over: Record<string, unknown>): Record<string, unknown> {
  return { assets: [], source: "energy", metric: null, aggregation: "sum", range: null, bars: "asset", min: 0, max: null, ...over };
}

async function createDashboard(request: APIRequestContext, name: string, widgets: WidgetBody[]): Promise<number> {
  const created = await request.post("/api/dashboards", { data: { name, range: "24h" } });
  expect(created.ok(), `creating ${name}: ${created.status()} ${await created.text()}`).toBe(true);
  const made = (await created.json()) as { id: number; updated_at: string };
  if (widgets.length > 0) {
    const saved = await request.put(`/api/dashboards/${made.id}`, { data: { name, range: "24h", updated_at: made.updated_at, widgets } });
    expect(saved.ok(), `saving the widgets of ${name}: ${saved.status()} ${await saved.text()}`).toBe(true);
  }
  return made.id;
}

/** The fixed compare stat of the follow dashboard and of the edit one: the stored config of a widget that never follows a focus (the "before" of every pin). */
const fixedConfig = (): Record<string, unknown> => config({ assets: [ids.racks[0]], range: "this_month", compare: COMPARE });

/** Four cards: a stat and a table that follow the focus, a compare stat of its own (a refetch every five minutes, not 30 s), a breakdown that follows. */
function followWidgets(): WidgetBody[] {
  return [
    { title: T_FOLLOW, type: "stat", x: 0, y: 0, w: 3, h: 2, config: config({ scope: "focus" }) },
    { title: T_FIXED, type: "stat", x: 3, y: 0, w: 3, h: 3, config: fixedConfig() },
    { title: T_BARS, type: "bar", x: 6, y: 0, w: 6, h: 5, config: config({ scope: "focus", bars: "kind", kind: "Rack" }) },
    { title: T_CHILDREN, type: "table", x: 0, y: 3, w: 6, h: 4, config: config({ scope: "children" }) },
  ];
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

async function removeDashboards(request: APIRequestContext, extra: number[] = []): Promise<void> {
  const mine = (await json<{ id: number; name: string }[]>(request, "/api/dashboards")).filter((d) => LEFTOVER.test(d.name) || extra.includes(d.id));
  for (const old of mine) {
    const gone = await request.delete(`/api/dashboards/${old.id}`);
    expect([200, 204, 404], `deleting the dashboard ${old.name}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  await asAdmin(browser, async (request) => {
    const me = await json<{ preferences: Look }>(request, "/api/me");
    originalLook = { mode: me.preferences.mode, theme: me.preferences.theme }; // what the account had before this spec; afterAll puts exactly this back
    const prefs = await request.put("/api/me/preferences", { data: LIGHT });
    expect(prefs.ok(), `starting from the light look: ${prefs.status()} ${await prefs.text()}`).toBe(true);
    await removeDashboards(request);
    await removeAccounts(request);
    await removeTree(request, OTHER);
    await removeTree(request, SITE);
    powerTaken = (await json<{ name: string }[]>(request, "/api/dashboards")).some((d) => d.name.toLowerCase() === "power");

    // One at a time: the server serialises the sibling-name check.
    ids.site = await createAsset(request, SITE, null, "Site", 1);
    ids.hall1 = await createAsset(request, HALL1, ids.site, "Hall", 1);
    ids.row = await createAsset(request, ROW, ids.hall1, "Row", 1);
    for (const [i, name] of RACKS.entries()) ids.racks[i] = await createAsset(request, name, ids.row, "Rack", i + 1);
    ids.hall2 = await createAsset(request, HALL2, ids.site, "Hall", 2);
    ids.panel = await createAsset(request, PANEL, ids.site, "Panel", 3);
    ids.long = await createAsset(request, LONG_ASSET, ids.hall2, "Rack", 1);
    followId = await createDashboard(request, D_FOLLOW, followWidgets());
    editId = await createDashboard(request, D_EDIT, [{ title: "W25 own stat", type: "stat", x: 0, y: 0, w: 3, h: 2, config: fixedConfig() }]);
    drillId = await createDashboard(request, D_DRILL, [{ title: T_DRILL, type: "bar", x: 0, y: 0, w: 6, h: 5, config: config({ scope: "focus", bars: "kind", kind: "Rack" }) }]);
    // The same breakdown card, but with a root of its own: no widget of this dashboard follows the focus.
    plainId = await createDashboard(request, D_PLAIN, [{ title: T_DRILL, type: "bar", x: 0, y: 0, w: 6, h: 5, config: config({ bars: "kind", kind: "Rack", root: ids.hall1 }) }]);
    longId = await createDashboard(request, D_LONG, [{ title: T_FOLLOW, type: "stat", x: 0, y: 0, w: 3, h: 2, config: config({ scope: "focus" }) }]);
  });
});

test.afterAll(async ({ browser }) => {
  test.setTimeout(300_000);
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
  await step("deleting the dashboards", (request) => removeDashboards(request, powerIds));
  await step("deleting the account and the role", removeAccounts);
  await step("deleting the second root", (request) => removeTree(request, OTHER));
  await step("deleting the assets", (request) => removeTree(request, SITE));
  expect(failures, "the clean-up put the stack back").toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// What the page asked and what the server answered

interface WidgetRequest { type: string; config: Record<string, unknown>; range: string; focus?: number }
interface FocusBlock { asset: { id: number; name: string; path: string } | null; state: string; children: { shown: number; count: number } | null; top_level: number | null }
interface WidgetAnswer { focus: FocusBlock | null; breakdown: { root: { id: number; name: string } | null; count: number } | null; values: { asset_id: number; name: string }[] }
interface Seen { body: WidgetRequest; at: number }

interface Watch {
  widget: Seen[]; // every POST /api/widget-data the page made, in order
  answers: { body: WidgetRequest; answer: WidgetAnswer }[]; // and what the server said to each
  assetGets: string[]; // every GET of the asset list
  failed: string[]; // every answer with a status of 400 or more
  errors: string[]; // console errors and uncaught exceptions of the page
}
let current: Watch | null = null;

test.afterEach(() => {
  const w = current;
  current = null;
  if (w) expect(w.errors, "the page logged no console error and no exception").toEqual([]);
});

/** Listens to the page. `ignore` names the console lines a case expects (the browser prints one for every 4xx answer). */
function watch(page: Page, ignore: RegExp | null = null): Watch {
  const w: Watch = { widget: [], answers: [], assetGets: [], failed: [], errors: [] };
  current = w;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/widget-data") w.widget.push({ body: request.postDataJSON() as WidgetRequest, at: Date.now() });
    if (request.method() === "GET" && url.pathname === "/api/assets") w.assetGets.push(url.pathname + url.search);
  });
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (response.status() >= 400) w.failed.push(`${response.request().method()} ${url.pathname} ${response.status()}`);
    if (response.request().method() !== "POST" || url.pathname !== "/api/widget-data" || !response.ok()) return;
    try {
      w.answers.push({ body: response.request().postDataJSON() as WidgetRequest, answer: (await response.json()) as WidgetAnswer });
    } catch {
      // the page moved on before the body could be read
    }
  });
  page.on("console", (message) => {
    if (message.type() !== "error" || /net::ERR_ABORTED/.test(message.text()) || (ignore !== null && ignore.test(message.text()))) return;
    w.errors.push(`console: ${message.text()} (${message.location().url})`);
  });
  page.on("pageerror", (error) => w.errors.push(`pageerror: ${error.message}`));
  return w;
}

const follows = (s: { body: WidgetRequest }): boolean => s.body.config.scope === "focus" || s.body.config.scope === "children";

async function signIn(page: Page, look: Look = LIGHT): Promise<void> {
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in: ${login.status()} ${await login.text()}`).toBe(true);
  await setLook(page, look);
}

/** Stores the look the case needs (the account's saved look wins over the browser's mirror, so it is set through the API before a page opens). */
async function setLook(page: Page, look: Look): Promise<void> {
  const saved = await page.request.put("/api/me/preferences", { data: look });
  expect(saved.ok(), `storing ${JSON.stringify(look)}: ${saved.status()} ${await saved.text()}`).toBe(true);
}

async function prepare(page: Page, look: Look = LIGHT, ignore: RegExp | null = null): Promise<Watch> {
  const w = watch(page, ignore);
  await signIn(page, look);
  return w;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Locators and readings

const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
/** A card of the dashboard, by its title (every data card is a region named by its title). */
const frameOf = (page: Page, title: string) => page.getByRole("region", { name: title, exact: true });
const detailsButton = (card: Locator, title: string) => card.getByRole("button", { name: `Details for ${title}`, exact: true });
const drawerOf = (page: Page, title: string) => page.getByRole("dialog", { name: `Details: ${title}`, exact: true });
/** The page's ONE trail. */
const crumbsNav = (page: Page) => page.getByRole("navigation", { name: "Breadcrumb", exact: true });
const crumbItems = (page: Page) => crumbsNav(page).locator("li > a, li > span:not(.sep)");
/** The last crumb: the page the trail is on now. */
const currentCrumb = (page: Page) => crumbsNav(page).locator('[aria-current="page"]');
const openLink = (page: Page, name: string) => page.getByRole("link", { name: `Open ${name} page`, exact: true });
const askedAsset = (page: Page): string | null => new URL(page.url()).searchParams.get("asset");

/** Opens a dashboard and waits until every named card is drawn, no skeleton is left and the page has stopped moving. */
async function openDashboard(page: Page, id: number, name: string, titles: string[], search = ""): Promise<void> {
  await page.goto(`/dashboards/${id}${search}`);
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
  for (const title of titles) await expect(frameOf(page, title)).toBeVisible();
  await expect(page.locator(".sk-region, .widget-sk"), "no skeleton is left (the charts load their chunk after the answer)").toHaveCount(0);
  await settled(page);
}
const FOLLOW_TITLES = [T_FOLLOW, T_FIXED, T_BARS, T_CHILDREN];
const openFollow = (page: Page, focus: number | null = null) => openDashboard(page, followId, D_FOLLOW, FOLLOW_TITLES, focus === null ? "" : `?asset=${focus}`);

/** The names from the top of the tree down to `id`, the way the trail shows them: a site with ONE top-level asset does not repeat it. */
async function chainNames(request: APIRequestContext, id: number): Promise<string[]> {
  const assets = await json<ApiAsset[]>(request, "/api/assets");
  const byId = new Map(assets.map((a) => [a.id, a]));
  const chain: ApiAsset[] = [];
  for (let at = byId.get(id); at; at = at.parent_id === null ? undefined : byId.get(at.parent_id)) chain.unshift(at);
  const roots = topLevelOf(assets);
  return (roots.length === 1 && chain[0]?.id === roots[0].id ? chain.slice(1) : chain).map((a) => a.name);
}

/** The trail reads Dashboards / <dashboard> / <ancestors> / <focus asset>; exactly one navigation carries it. */
async function expectTrail(page: Page, dashboard: string, focus: number | null): Promise<void> {
  await expect(crumbsNav(page), "the page holds exactly one navigation named Breadcrumb").toHaveCount(1);
  const chain = focus === null ? [] : await chainNames(page.request, focus);
  await expect(crumbItems(page)).toHaveText(["Dashboards", dashboard, ...chain]);
}

const dialogOf = (page: Page) => page.getByRole("dialog", { name: "Choose a focus", exact: true });

/** Opens the Focus dialog, picks `name` (or Whole site for null) and presses Show. */
async function chooseFocus(page: Page, name: string | null): Promise<void> {
  await button(page, "Focus").click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  if (name === null) {
    await dialog.getByRole("button", { name: "Whole site", exact: true }).click();
  } else {
    const picker = dialog.getByRole("group", { name: "Focus asset", exact: true });
    await picker.getByLabel("Search assets", { exact: true }).fill(name);
    await picker.getByRole("radio", { name, exact: true }).check();
  }
  await dialog.getByRole("button", { name: "Show", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function boxOf(target: Locator, what: string): Promise<Box> {
  const box = await target.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  expect(box.width * box.height, `${what} has a box`).toBeGreaterThan(0);
  return box;
}
const overlap = (a: Box, b: Box): boolean =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;
const inside = (inner: Box, outer: Box, slack = 1): boolean =>
  inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;

async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, `${where}: the page does not scroll sideways`).toBeLessThanOrEqual(0);
}

/** The accessible name of the element that has the focus: its aria-label, its label's text, else its own text; `<body>` when nothing has it. */
async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "<body>";
    const named = el.getAttribute("aria-label");
    if (named) return named;
    const labels = (el as HTMLInputElement).labels;
    return ((labels && labels.length > 0 ? labels[0].textContent : el.textContent) ?? el.tagName).replace(/\s+/g, " ").trim();
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. Address and Back

test("1. ?asset opens the dashboard focused; a following card sends the focus and a fixed card does not; choosing a focus pushes one entry, Back returns, the range of the visit stays", async ({ page }) => {
  test.setTimeout(180_000);
  const w = await prepare(page);
  await openFollow(page, ids.hall1);
  await expectTrail(page, D_FOLLOW, ids.hall1);
  await expect(openLink(page, HALL1), "the link goes to the asset's page").toHaveAttribute("href", `/assets/${ids.hall1}`);

  // The request bodies: every card that follows names the focus from its first request (the id is in the address), the fixed one never does.
  const first = w.widget.slice();
  expect(first.filter(follows).length, "the stat, the breakdown and the table follow the focus").toBeGreaterThanOrEqual(3);
  for (const s of first.filter(follows)) expect(s.body.focus, `a ${s.body.type} that follows carries the focus`).toBe(ids.hall1);
  const fixed = first.filter((s) => !follows(s));
  expect(fixed.length, "the fixed card asked").toBeGreaterThan(0);
  for (const s of fixed) expect("focus" in s.body, "a fixed card leaves the focus out of its body").toBe(false);
  expect(fixed[0].body.config.scope, "and its stored config has no scope").toBeUndefined();
  await expect(frameOf(page, T_FIXED).locator(".follow-note"), "the fixed card says it keeps its own assets").toHaveText(`Its own assets, not ${HALL1}`);
  await expect(frameOf(page, T_FOLLOW).locator(".follow-note"), "the card that follows says nothing of the kind").toHaveCount(0);
  await expect(frameOf(page, T_CHILDREN).locator("table.widget-table tbody td:first-child"), "the children of the hall").toHaveText([ROW]);

  // The range picked for the visit: the cards that follow ask again for it, the compare stat keeps its own range and asks nothing.
  await page.getByLabel("Dashboard range").selectOption("7d");
  await expect.poll(() => w.widget.filter((s) => follows(s) && s.body.range === "7d").length, { message: "the cards that follow ask for the new range" }).toBeGreaterThanOrEqual(3);
  await expect(page.locator('.widget-body[aria-busy="true"]')).toHaveCount(0);
  await settled(page);

  // Choosing a focus in the dialog PUSHES one history entry; the fixed card makes no request at all.
  const mark = w.widget.length;
  const entries = await page.evaluate(() => history.length);
  await chooseFocus(page, RACKS[0]);
  await expect.poll(() => askedAsset(page)).toBe(String(ids.racks[0]));
  expect(await page.evaluate(() => history.length), "choosing a focus adds one entry").toBe(entries + 1);
  await expectTrail(page, D_FOLLOW, ids.racks[0]);
  await expect.poll(() => w.widget.slice(mark).filter((s) => follows(s) && s.body.focus === ids.racks[0]).length, { message: "the cards that follow ask about the rack" }).toBeGreaterThanOrEqual(3);
  await expect(page.locator('.widget-body[aria-busy="true"]')).toHaveCount(0);
  await settled(page);
  for (const s of w.widget.slice(mark).filter(follows)) expect(s.body.range, "and keep the range of the visit").toBe("7d");
  expect(w.widget.slice(mark).filter((s) => !follows(s)), "the fixed card made no new request when the focus changed").toEqual([]);
  // Its own asset IS the focus now, so the card has nothing to say about it; the footer's room stays, empty and hidden from a screen reader, so the card does not move.
  await expect(frameOf(page, T_FIXED).locator(".follow-note"), "a fixed card whose own asset is the focus carries no note").toHaveCount(0);
  await expect(frameOf(page, T_FIXED).locator(".widget-foot"), "and keeps its footer line, empty").toHaveAttribute("aria-hidden", "true");

  // Back returns to the focus before; the visit's range is still the one picked.
  const back = w.widget.length;
  await page.goBack();
  await expect.poll(() => askedAsset(page)).toBe(String(ids.hall1));
  await expectTrail(page, D_FOLLOW, ids.hall1);
  await expect(page.getByLabel("Dashboard range")).toHaveValue("7d");
  await expect(page.getByText(/for this visit only/)).toBeVisible();
  await expect(openLink(page, HALL1)).toBeVisible();
  await expect(page.locator('.widget-body[aria-busy="true"]')).toHaveCount(0);
  await expect(frameOf(page, T_FIXED).locator(".follow-note"), "the note is back with a focus that is not the card's own asset").toHaveText(`Its own assets, not ${HALL1}`);
  expect(w.widget.slice(back).filter((s) => !follows(s)), "Back made no request for the fixed card either").toEqual([]);

  // The link to the asset's own page.
  await openLink(page, HALL1).click();
  await expect(page).toHaveURL(new RegExp(`/assets/${ids.hall1}$`));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. The trail goes up

test("2. from a rack each ancestor in the trail moves the focus up, Back walks back, the dashboard crumb clears it; the page holds one Breadcrumb", async ({ page }) => {
  test.setTimeout(180_000);
  await prepare(page);
  await openFollow(page, ids.racks[0]);
  await expectTrail(page, D_FOLLOW, ids.racks[0]);
  await expect(frameOf(page, T_CHILDREN).locator(".widget-empty"), "a rack has no children").toContainText(`${RACKS[0]} has no children.`);
  await expect(crumbItems(page).last(), "the focus asset is the current page").toHaveAttribute("aria-current", "page");

  await crumbsNav(page).getByRole("link", { name: ROW, exact: true }).click();
  await expect.poll(() => askedAsset(page)).toBe(String(ids.row));
  await expectTrail(page, D_FOLLOW, ids.row);
  await expect(currentCrumb(page), "after a click on a crumb the keyboard focus is on the new current crumb").toBeFocused();
  await expect(openLink(page, ROW)).toBeVisible();
  await expect(frameOf(page, T_CHILDREN).locator("table.widget-table tbody td:first-child"), "the three racks are the row's children").toHaveText([...RACKS]);

  await crumbsNav(page).getByRole("link", { name: HALL1, exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => askedAsset(page)).toBe(String(ids.hall1));
  await expectTrail(page, D_FOLLOW, ids.hall1);
  await expect(currentCrumb(page), "and so is it after Enter on a crumb").toBeFocused();

  await page.goBack();
  await expect.poll(() => askedAsset(page)).toBe(String(ids.row));
  await expectTrail(page, D_FOLLOW, ids.row);
  await page.goBack();
  await expect.poll(() => askedAsset(page)).toBe(String(ids.racks[0]));
  await expectTrail(page, D_FOLLOW, ids.racks[0]);

  // The dashboard's own crumb is the whole site.
  await crumbsNav(page).getByRole("link", { name: D_FOLLOW, exact: true }).click();
  await expect.poll(() => askedAsset(page)).toBeNull();
  await expectTrail(page, D_FOLLOW, null);
  await expect(currentCrumb(page), "the dashboard is the current crumb now, and has the focus").toBeFocused();
  await expect(page.getByRole("link", { name: /^Open .* page$/ })).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. Gone and invalid links

test("3. a number that is no asset, text, 0, a number past the id range and an asset deleted just before the load all show the whole site with the line, and drop ?asset", async ({ page }) => {
  test.setTimeout(240_000);
  const w = await prepare(page);
  const doomed = await createAsset(page.request, `W25 Gone ${RUN}`, ids.hall2, "Rack", 9);
  await deleteAsset(page.request, doomed);
  const links: [string, boolean][] = [["2147483000", true], ["abc", false], ["0", false], ["2147483648", false], [String(doomed), true]];
  for (const [raw, askedServer] of links) {
    w.widget.length = 0;
    await page.goto(`/dashboards/${followId}?asset=${raw}&keep=1`);
    await expect(page.getByRole("heading", { level: 1, name: D_FOLLOW, exact: true })).toBeVisible();
    await expect(page.getByText(GONE, { exact: true }), `?asset=${raw}: the line says the asset is gone`).toBeVisible();
    await expect.poll(() => askedAsset(page), { message: `?asset=${raw} is dropped from the address` }).toBeNull();
    expect(new URL(page.url()).searchParams.get("keep"), "and only that parameter").toBe("1");
    await expectTrail(page, D_FOLLOW, null);
    await expect(page.getByRole("link", { name: /^Open .* page$/ })).toHaveCount(0);
    await expect(button(page, "Focus"), "the person may still choose a focus").toBeVisible();
    await expect.poll(() => w.widget.some((s) => follows(s) && !("focus" in s.body)), { message: `?asset=${raw}: the cards that follow ask about the whole site` }).toBe(true);
    if (!askedServer) expect(w.widget.filter((s) => "focus" in s.body), `?asset=${raw} is not an id: nothing is sent to the server`).toEqual([]);
  }

  // The line is about the link that was opened: choosing a focus in the same visit takes it away.
  await expect(page.getByText(GONE, { exact: true }), "the line is still there until something is chosen").toBeVisible();
  await chooseFocus(page, HALL1);
  await expect.poll(() => askedAsset(page)).toBe(String(ids.hall1));
  await expect(page.getByText(GONE, { exact: true }), "choosing a focus takes the line away").toHaveCount(0);
  await expectTrail(page, D_FOLLOW, ids.hall1);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. A role without the Assets Tree

test("4. a role with dashboards.view only: no Focus, no Open page, ?asset ignored with its line, no asset list, and a 403 only for a body that carries a focus", async ({ browser, page }) => {
  test.setTimeout(240_000);
  const roots = await asAdmin(browser, async (request) => {
    await removeAccounts(request);
    const role = await request.post("/api/roles", { data: { name: ROLE, description: "made by w25.spec.ts", permissions: ["dashboards.view"] } });
    expect(role.status(), `creating the role: ${await role.text()}`).toBe(201);
    const user = await request.post("/api/users", { data: { username: VIEWER.username, password: VIEWER.password, role: VIEWER.role } });
    expect(user.status(), `creating the account: ${await user.text()}`).toBe(201);
    return topLevelOf(await json<ApiAsset[]>(request, "/api/assets")).length;
  });
  try {
    const w = watch(page);
    const login = await page.request.post("/api/login", { data: { username: VIEWER.username, password: VIEWER.password } });
    expect(login.ok(), `signing in as the account: ${login.status()} ${await login.text()}`).toBe(true);
    await openFollow(page, ids.hall1);
    await expect(page.getByText(DENIED, { exact: true }), "the line names no asset").toBeVisible();
    await expect(button(page, "Focus"), "no Focus control").toHaveCount(0);
    await expect(page.getByRole("link", { name: /^Open .* page$/ }), "no link to the asset's page").toHaveCount(0);
    await expectTrail(page, D_FOLLOW, null);
    expect(w.assetGets, "the asset list is never asked for").toEqual([]);
    expect(w.widget.length, "the cards asked").toBeGreaterThan(0);
    expect(w.widget.filter((s) => "focus" in s.body), "no request names a focus").toEqual([]);
    expect(w.failed, "and nothing the page asked for was refused").toEqual([]);
    if (roots >= 2) {
      await expect(frameOf(page, T_FOLLOW).locator(".widget-empty"), "the card that needs a focus says why it cannot get one").toHaveText(
        `This site has ${roots} top-level assets, so this figure needs a focus asset, and your role cannot choose one.`,
      );
    }

    // The server: a focus needs the Assets Tree, also on the CSV route; the same body without it is a normal request.
    expect((await page.request.get("/api/assets")).status(), "the role really lacks the asset list").toBe(403);
    const body = { type: "stat", config: config({ assets: [ids.racks[0]] }), range: "24h" };
    const refused = await page.request.post("/api/widget-data", { data: { ...body, focus: ids.hall1 } });
    expect(refused.status(), "a body with a focus is refused").toBe(403);
    expect(await refused.json(), "with the one text for every missing permission").toEqual({ detail: "insufficient permission" });
    const plain = await page.request.post("/api/widget-data", { data: body });
    expect([200, 422], `the same body without a focus is not a permission matter (${plain.status()} ${await plain.text()})`).toContain(plain.status());
    expect((await page.request.post("/api/widget-data/csv", { data: { ...body, focus: ids.hall1 } })).status(), "the CSV route says the same").toBe(403);
    expect((await page.request.post("/api/widget-data/csv", { data: body })).status(), "and answers a body without a focus").toBe(200);

    // A viewer sees the empty Dashboards page as it always was: no template cards (w27) and no buttons to start one.
    await page.route((url) => url.pathname === "/api/dashboards", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: "[]" }) : route.fallback()));
    await page.goto("/dashboards");
    await expect(page.getByText("No dashboards yet.", { exact: true })).toBeVisible();
    await expect(button(page, "Blank")).toHaveCount(0);
    await expect(button(page, "Power")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "More templates", exact: true })).toHaveCount(0);
  } finally {
    await asAdmin(browser, removeAccounts);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. Several top-level assets

test("5. with several top-level assets a card that follows says how many through the real server, a children card lists the roots and a breakdown looks at the whole site", async ({ page }) => {
  test.setTimeout(180_000);
  const w = await prepare(page);
  try {
    await createAsset(page.request, OTHER, null, "Site", 2);
    const roots = topLevelOf(await json<ApiAsset[]>(page.request, "/api/assets"));
    const n = roots.length;
    expect(n, "this spec's two roots are there").toBeGreaterThanOrEqual(2);
    const shown = Math.min(n, 20);
    await openFollow(page, null);
    await expectTrail(page, D_FOLLOW, null);

    await expect(frameOf(page, T_FOLLOW).locator(".widget-empty"), "the card draws no figure of its own").toHaveText(`This site has ${n} top-level assets: choose a focus to see this figure.`);
    await expect.poll(() => w.answers.length, { message: "the answers have come" }).toBeGreaterThanOrEqual(3);
    const answerOf = (type: string, scope: string) => w.answers.find((a) => a.body.type === type && a.body.config.scope === scope)?.answer;
    expect(answerOf("stat", "focus")?.focus, "the server asks for a focus").toEqual({ asset: null, state: "choose", children: null, top_level: n });
    for (const s of w.widget.filter(follows)) expect("focus" in s.body, "no focus was sent").toBe(false);

    // The children card lists the top-level assets, at most 20, and says so when it cuts.
    const rows = frameOf(page, T_CHILDREN).locator("table.widget-table tbody td:first-child");
    await expect(rows).toHaveCount(shown);
    expect(answerOf("table", "children")?.focus, "the server lists the roots").toEqual({ asset: null, state: "ok", children: { shown, count: n }, top_level: n });
    if (n <= 20) {
      const names = await rows.allTextContents();
      expect(names, "this spec's roots are among them").toEqual(expect.arrayContaining([SITE, OTHER]));
    } else {
      await expect(frameOf(page, T_CHILDREN).locator(".follow-note")).toHaveText(`20 of ${n} top-level assets shown`);
    }

    // The breakdown looks at the whole site: no root, the sentence or the chart says "under the site".
    const bars = answerOf("bar", "focus");
    expect(bars?.breakdown?.root, "the breakdown has no root").toBeNull();
    expect(bars?.focus, "and the server says the whole site is fine").toEqual({ asset: null, state: "ok", children: null, top_level: n });
    await expect(frameOf(page, T_BARS).locator(".widget-bars .widget-chart[aria-label*='under the site'], .widget-bars .widget-empty:has-text('under the site')")).toHaveCount(1);
    await expect(frameOf(page, T_FIXED), "the fixed card is the same as ever").not.toContainText("top-level");
  } finally {
    await removeTree(page.request, OTHER);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 6. Start from Power

const dialogNew = (page: Page) => page.getByRole("dialog", { name: "New dashboard", exact: true });

test("6. New dashboard, Start from Power: five widgets in view mode, the name Power for an empty name, a second one is refused in the dialog, the cards follow ?asset", async ({ page }) => {
  test.setTimeout(240_000);
  test.skip(powerTaken, "a dashboard called Power was already on the stack before this spec; the starter would be refused");
  const w = await prepare(page, LIGHT, /status of 409/);
  await page.goto("/dashboards");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboards", exact: true })).toBeVisible();
  await button(page, "New dashboard").click();
  const dialog = dialogNew(page);
  await expect(dialog).toBeVisible();
  // w27: the first step is the template gallery; a card opens the second step.
  await expect(dialog.getByRole("button", { name: "Blank", exact: true }), "Blank is the last card").toBeVisible();
  await dialog.getByRole("button", { name: "Power", exact: true }).click();
  await expect(dialog.getByLabel("Range", { exact: true }), "Power compares with last month, so it starts on this month").toHaveValue("this_month");
  await expect(dialog.getByLabel("Name", { exact: true }), "the name field offers the starter's name").toHaveAttribute("placeholder", "Power");
  await expect(dialog.getByText("Enter a name.", { exact: true }), "an empty name is fine for Power").toHaveCount(0);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboards\/\d+$/);
  const powerId = Number(new URL(page.url()).pathname.split("/").pop());
  powerIds.push(powerId);
  try {
    // View mode, under the default name; five widgets, all that can follow do.
    await expect(page.getByRole("heading", { level: 1, name: "Power", exact: true })).toBeVisible();
    await expect(button(page, "Edit"), "it opens in view mode").toBeVisible();
    await expect(button(page, "Save")).toHaveCount(0);
    const made = await json<ApiDashboard>(page.request, `/api/dashboards/${powerId}`);
    expect(made.range, "on this month").toBe("this_month");
    expect(made.widgets.map((x) => x.type), "a heading, two stats, a bar chart and a time series").toEqual(["text", "stat", "stat", "bar", "timeseries"]);
    // The titles are read back, not written here: the stat titles and the bar chart's kind spelling are the starter's to choose; their shape is what is pinned.
    const [heading, energy, cost, bars, chart] = made.widgets.map((x) => x.title);
    expect(heading, "the heading").toBe("Power use and cost");
    expect(energy, "the energy stat").toMatch(/^Energy\b/);
    expect(cost, "the cost stat").toMatch(/^Cost\b/);
    expect(bars, "the bar chart is named after its kind").toMatch(/^Energy by \S/);
    expect(chart, "the daily chart").toBe("Energy by day, against last month");
    expect(new Set([energy, cost, bars, chart]).size, "four different titles").toBe(4);
    for (const x of made.widgets.slice(1)) {
      expect(x.config.scope, `${x.title} follows the focus`).toBe("focus");
      expect(x.config.assets, `${x.title} names no asset`).toEqual([]);
    }
    expect(made.widgets.filter((x) => x.config.compare === COMPARE).map((x) => x.config.range), "the three comparisons carry their own range").toEqual(["this_month", "this_month", "this_month"]);
    await expect(page.getByRole("heading", { level: 2, name: "Power use and cost", exact: true })).toBeVisible();

    // A second one under the same (empty) name is refused, in the dialog, with the server's words.
    await page.goto("/dashboards");
    await button(page, "New dashboard").click();
    await dialogNew(page).getByRole("button", { name: "Power", exact: true }).click();
    await dialogNew(page).getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialogNew(page).getByRole("alert"), "the name is taken").toContainText(/already exists/i);
    await expect(dialogNew(page), "and the dialog stays").toBeVisible();
    await dialogNew(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialogNew(page)).toBeHidden();
    expect((await json<{ name: string }[]>(page.request, "/api/dashboards")).filter((d) => d.name === "Power"), "still one Power").toHaveLength(1);

    // Opened on an asset, the comparisons and the breakdown ask about it.
    w.widget.length = 0;
    await page.goto(`/dashboards/${powerId}?asset=${ids.hall1}`);
    await expect(page.getByRole("heading", { level: 1, name: "Power", exact: true })).toBeVisible();
    for (const title of [energy, cost, bars, chart]) await expect(frameOf(page, title)).toBeVisible();
    await expect.poll(() => w.widget.length, { message: "the four data cards asked" }).toBeGreaterThanOrEqual(4);
    await expectTrail(page, "Power", ids.hall1);
    const kinds = new Set(w.widget.map((s) => `${s.body.type}:${s.body.config.source}:${s.body.config.compare ?? s.body.config.bars}`));
    expect([...kinds].sort(), "a stat of energy, a stat of cost, a time series and a breakdown").toEqual(["bar:energy:kind", "stat:cost:same_days_last_month", "stat:energy:same_days_last_month", "timeseries:energy:same_days_last_month"]);
    for (const s of w.widget) expect(s.body.focus, `the ${s.body.type} of Power carries the focus`).toBe(ids.hall1);
  } finally {
    const gone = await page.request.delete(`/api/dashboards/${powerId}`);
    expect([200, 204, 404], `deleting Power: ${gone.status()}`).toContain(gone.status());
  }
});

test("6. on the empty Dashboards page the template cards open the dialog on its second step, with the template's range (w27)", async ({ page }) => {
  test.setTimeout(120_000);
  await prepare(page);
  await page.route((url) => url.pathname === "/api/dashboards", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: "[]" }) : route.fallback()));
  await page.goto("/dashboards");
  await expect(page.getByText("No dashboards yet. Create one to get started.", { exact: true })).toBeVisible();
  await button(page, "Power").click(); // the inline card, the dialog is not open yet
  const dialog = dialogNew(page);
  await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
  await expect(dialog.getByLabel("Range", { exact: true })).toHaveValue("this_month");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await button(page, "Blank").click();
  await expect(dialog.getByLabel("Range", { exact: true })).toHaveValue("24h");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 7. Drill-through

/** Three bars with a figure and a fourth without one (null): the site, which has children, so only its NAME can be clicked. */
const DRILL_BARS = (): [number, number | null][] => [[ids.row, 500], [ids.racks[0], 400], [ids.racks[1], 300], [ids.site, null]];

/** The answer of the breakdown, made up in the page: its bars are real asset ids (the row and the site have children, the racks have none). */
async function answerDrill(page: Page, names: Map<number, string>): Promise<void> {
  const pathOf = (id: number): string => names.get(id) ?? `Asset #${id}`;
  await page.route((url) => url.pathname === "/api/widget-data", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as WidgetRequest;
    const rootId = body.focus ?? (typeof body.config.root === "number" ? body.config.root : null); // the focus, or the root the card was saved with
    const root = rootId === null ? null : { id: rootId, name: pathOf(rootId) };
    const values = DRILL_BARS().map(([id, value]) => ({
      asset_id: id, name: pathOf(id), value, estimated: false, partial: false, point_id: null, no_data: value === null, ts: null, stale: false,
    }));
    const answer = {
      type: "bar", mode: "values", source: "energy", metric: null, unit: "kWh",
      range: { preset: "24h", start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z" }, tier: null, bucket: null,
      series: [], values, missing: [], no_metric: [], compare: null,
      breakdown: {
        kind: "Rack", root, count: 4, shown: 4, more: { count: 0, with_value: 0, value: null, estimated: false, partial: false },
        no_data: 1, inside_others: 0, kinds: [{ kind: "Rack", count: 3 }, { kind: "Row", count: 1 }],
      },
      focus: body.config.scope === undefined ? null : { asset: root === null ? null : { ...root, path: root.name }, state: "ok", children: null, top_level: root === null ? 1 : null },
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answer) }).catch(() => undefined); // the page may be gone by now
  });
}

const drillCard = (page: Page) => frameOf(page, T_DRILL);
const drillChart = (page: Page) => drillCard(page).locator(".widget-bars > .widget-chart");

async function openDrill(page: Page, search: string, plain = false): Promise<void> {
  await (plain ? openDashboard(page, plainId, D_PLAIN, [T_DRILL], search) : openDashboard(page, drillId, D_DRILL, [T_DRILL], search));
  await expect(drillChart(page).locator("canvas").first(), "the bars are drawn").toBeVisible();
  await settled(page);
}

interface BarShape { x0: number; x1: number; top: number; bottom: number }

/** The accent colour of the page (the colour of a chart with one series), read where a canvas cannot. */
const accentOf = (page: Page) => page.evaluate(() => {
  const probe = document.createElement("span");
  probe.style.color = "var(--accent)";
  document.body.appendChild(probe);
  const [r, g, b] = (getComputedStyle(probe).color.match(/\d+/g) ?? ["0", "0", "0"]).map(Number);
  probe.remove();
  return [r, g, b] as [number, number, number];
});

/** The bars of the chart, left to right, found by their colour in the canvas's pixels (CSS px from the canvas's top left). */
const scanBars = (canvas: Locator, rgb: [number, number, number]) => canvas.evaluate((el, want) => {
  const c = el as HTMLCanvasElement;
  const ctx = c.getContext("2d");
  if (!ctx) return [];
  const scale = c.getBoundingClientRect().width / c.width;
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  const near = (i: number) => Math.abs(data[i] - want[0]) <= 14 && Math.abs(data[i + 1] - want[1]) <= 14 && Math.abs(data[i + 2] - want[2]) <= 14 && data[i + 3] > 200;
  const tops: number[] = new Array(c.width).fill(-1);
  const bottoms: number[] = new Array(c.width).fill(-1);
  for (let x = 0; x < c.width; x++) {
    for (let y = 0; y < c.height; y++) {
      if (!near((y * c.width + x) * 4)) continue;
      if (tops[x] < 0) tops[x] = y;
      bottoms[x] = y;
    }
  }
  const runs: BarShape[] = [];
  let start = -1;
  for (let x = 0; x <= c.width; x++) {
    const on = x < c.width && tops[x] >= 0;
    if (on && start < 0) start = x;
    if (!on && start >= 0) {
      if (x - start >= 6) {
        const part = tops.slice(start, x);
        runs.push({ x0: start * scale, x1: x * scale, top: Math.min(...part) * scale, bottom: (Math.max(...bottoms.slice(start, x)) + 1) * scale });
      }
      start = -1;
    }
  }
  return runs;
}, rgb);

/** The row of text under a bar: its axis name. The first row of ink below the axis line, in the bar's own slot, and the middle of the ink in it. */
const scanName = (canvas: Locator, bar: BarShape, slot: number) => canvas.evaluate((el, [x0, x1, bottom, width]) => {
  const c = el as HTMLCanvasElement;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const scale = c.getBoundingClientRect().width / c.width;
  const left = Math.max(0, Math.floor(((x0 + x1) / 2 - width / 2 + 2) / scale));
  const right = Math.min(c.width, Math.ceil(((x0 + x1) / 2 + width / 2 - 2) / scale));
  const from = Math.ceil((bottom + 7) / scale);
  const to = Math.min(c.height, Math.ceil((bottom + 40) / scale));
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  for (let y = from; y < to; y++) {
    const columns: number[] = [];
    for (let x = left; x < right; x++) if (data[(y * c.width + x) * 4 + 3] > 80) columns.push(x);
    if (columns.length >= 2) return { x: ((columns[0] + columns[columns.length - 1]) / 2) * scale, y: (y + 4) * scale };
  }
  return null;
}, [bar.x0, bar.x1, bar.bottom, slot] as const);

/** The text of the chart's tooltip as it is now (the canvas has no text of its own). */
const tooltipText = (chart: Locator) => chart.evaluate((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());

/** Waits until the chart stands still (two reads agree) and returns its bars; the mouse is moved off the card first, because the hover line would cut a bar in two. */
async function stableBars(page: Page, expected: number): Promise<{ bars: BarShape[]; canvas: Locator; at: Box }> {
  const canvas = drillChart(page).locator("canvas").first();
  await canvas.scrollIntoViewIfNeeded();
  await page.mouse.move(2, 2);
  const rgb = await accentOf(page);
  let last = "";
  let bars: BarShape[] = [];
  await expect.poll(async () => {
    bars = await scanBars(canvas, rgb);
    const now = JSON.stringify(bars);
    const same = now === last && bars.length === expected;
    last = now;
    return same;
  }, { message: `the chart stands still with ${expected} bars (the accent is ${rgb.join(",")})`, timeout: 15_000 }).toBe(true);
  const at = await boxOf(canvas, "the canvas");
  return { bars, canvas, at };
}

/** Clicks the bar, or its axis name, of the `index`th asset: the pointer first waits on the bar until the tooltip says what a click does (the asset list has loaded then). */
async function clickDrill(page: Page, index: number, where: "bar" | "name", tip: string): Promise<void> {
  const { bars, canvas, at } = await stableBars(page, 3);
  const bar = bars[index];
  const slot = bars.length > 1 ? Math.min(...bars.slice(1).map((b, i) => (b.x0 + b.x1) / 2 - (bars[i].x0 + bars[i].x1) / 2)) : 120;
  const x = at.x + (bar.x0 + bar.x1) / 2;
  await page.mouse.move(x, at.y + (bar.top + bar.bottom) / 2, { steps: 4 });
  await expect.poll(() => tooltipText(drillChart(page)), { message: `the tooltip of bar ${index} says what a click does` }).toContain(tip);
  if (where === "bar") {
    await page.mouse.click(x, at.y + (bar.top + bar.bottom) / 2);
    return;
  }
  await page.mouse.move(2, 2);
  const label = await scanName(canvas, bar, slot);
  expect(label, `text is drawn under bar ${index}`).not.toBeNull();
  await page.mouse.move(at.x + label!.x, at.y + label!.y, { steps: 4 });
  await page.mouse.click(at.x + label!.x, at.y + label!.y);
}

async function drillNames(page: Page): Promise<Map<number, string>> {
  const names = new Map((await json<ApiAsset[]>(page.request, "/api/assets")).map((a) => [a.id, a.name] as const));
  return names;
}

const narrowTip = (name: string) => `Click to narrow the dashboard to ${name}`;
const openTip = (name: string) => `Click to open ${name}'s page`;

for (const where of ["bar", "name"] as const) {
  test(`7. a click on a ${where === "bar" ? "bar" : "bar's axis name"} narrows the focus to an asset with children and opens the page of a leaf`, async ({ page }) => {
    test.setTimeout(240_000);
    await prepare(page);
    await answerDrill(page, await drillNames(page));
    // The row has children: the focus moves to it, the address and the trail follow.
    await openDrill(page, `?asset=${ids.hall1}`);
    await clickDrill(page, 0, where, narrowTip(ROW));
    await expect.poll(() => askedAsset(page), { message: "the address names the row" }).toBe(String(ids.row));
    await expectTrail(page, D_DRILL, ids.row);
    await expect(openLink(page, ROW)).toBeVisible();
    expect(new URL(page.url()).pathname, "and the page is still the dashboard").toBe(`/dashboards/${drillId}`);
    // A rack is a leaf: its page opens.
    await openDrill(page, `?asset=${ids.hall1}`);
    await clickDrill(page, 1, where, openTip(RACKS[0]));
    await expect(page).toHaveURL(new RegExp(`/assets/${ids.racks[0]}$`));
  });
}

test("7. a bar with no data cannot be clicked, only its name can, and the tooltip says so", async ({ page }) => {
  test.setTimeout(240_000);
  await prepare(page);
  const soleRoot = topLevelOf(await json<ApiAsset[]>(page.request, "/api/assets")).length === 1; // the only top-level asset is no focus at all (R5)
  await answerDrill(page, await drillNames(page));
  await openDrill(page, `?asset=${ids.hall1}`);
  const { bars, canvas, at } = await stableBars(page, 3);
  const centre = (b: BarShape) => (b.x0 + b.x1) / 2;
  const slot = centre(bars[1]) - centre(bars[0]);
  // The fourth slot has no bar: its place is one slot after the third.
  const empty: BarShape = { x0: centre(bars[2]) + slot - 1, x1: centre(bars[2]) + slot + 1, top: bars[0].top, bottom: bars[0].bottom };
  const y = at.y + (bars[0].top + bars[0].bottom) / 2;
  await page.mouse.move(at.x + centre(empty), y, { steps: 4 });
  await expect.poll(() => tooltipText(drillChart(page)), { message: "the tooltip of the empty slot says only its name narrows" }).toContain(`Click its name to narrow the dashboard to ${SITE}`);
  await page.mouse.click(at.x + centre(empty), y);
  await settled(page);
  expect(askedAsset(page), "a click where the bar would be does nothing").toBe(String(ids.hall1));
  await page.mouse.move(2, 2);
  const label = await scanName(canvas, empty, slot);
  expect(label, "the name is drawn under the empty slot").not.toBeNull();
  await page.mouse.move(at.x + label!.x, at.y + label!.y, { steps: 4 });
  await page.mouse.click(at.x + label!.x, at.y + label!.y);
  await expect.poll(() => askedAsset(page), { message: "a click on the name narrows" }).toBe(soleRoot ? null : String(ids.site));
});

test("7. by keyboard: Details lists the bars, Tab reaches Narrow to the row (the racks have none), Enter narrows, closes the panel and leaves the focus on that card's Details button", async ({ page }) => {
  test.setTimeout(180_000);
  await prepare(page);
  await answerDrill(page, await drillNames(page));
  await openDrill(page, `?asset=${ids.hall1}`);
  const details = detailsButton(drillCard(page), T_DRILL);
  await details.focus();
  await page.keyboard.press("Enter");
  const drawer = drawerOf(page, T_DRILL);
  await expect(drawer).toBeVisible();
  const narrow = drawer.getByRole("button", { name: `Narrow to ${ROW}`, exact: true });
  await expect(narrow, "the row has children").toBeVisible();
  await expect(narrow).toHaveText("Narrow");
  await expect(drawer.getByRole("button", { name: `Narrow to ${RACKS[0]}`, exact: true }), "a leaf has no such button").toHaveCount(0);
  let reached = false;
  for (let i = 0; i < 30 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = (await focusedName(page)) === `Narrow to ${ROW}`;
  }
  expect(reached, "Tab reaches Narrow to the row").toBe(true);
  await page.keyboard.press("Enter");
  await expect.poll(() => askedAsset(page)).toBe(String(ids.row));
  await expect(drawer, "the panel closes").toBeHidden();
  await expect(details, "and the focus is on the Details button of this card").toBeFocused();
  await expectTrail(page, D_DRILL, ids.row);
});

test("7. on a dashboard where no widget follows the focus a click on a bar opens the asset's page, and Details has no Narrow to", async ({ page }) => {
  test.setTimeout(180_000);
  await prepare(page);
  await answerDrill(page, await drillNames(page));
  // Narrowing would change nothing on this page, so even an asset with children opens its page, and the tooltip says so.
  await openDrill(page, `?asset=${ids.hall1}`, true);
  const details = detailsButton(drillCard(page), T_DRILL);
  await details.focus();
  await page.keyboard.press("Enter");
  const drawer = drawerOf(page, T_DRILL);
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("link", { name: ROW, exact: true }), "the bars are listed with links to the pages").toBeVisible();
  await expect(drawer.getByRole("button", { name: /^Narrow to / }), "no Narrow to on a page nothing follows the focus on").toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await clickDrill(page, 0, "bar", openTip(ROW));
  await expect(page).toHaveURL(new RegExp(`/assets/${ids.row}$`));
});

test("7. in edit mode a click on a bar does nothing and there is no Narrow to", async ({ page }) => {
  test.setTimeout(180_000);
  await prepare(page);
  await answerDrill(page, await drillNames(page));
  await openDrill(page, `?asset=${ids.hall1}`);
  await button(page, "Edit").click();
  await expect(button(page, "Save")).toBeVisible();
  await expect(drillChart(page).locator("canvas").first()).toBeVisible();
  await expect(detailsButton(drillCard(page), T_DRILL), "edit mode has no Details button").toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Narrow to / })).toHaveCount(0);
  const { bars, at } = await stableBars(page, 3);
  await page.mouse.click(at.x + (bars[0].x0 + bars[0].x1) / 2, at.y + (bars[0].top + bars[0].bottom) / 2);
  await settled(page);
  expect(askedAsset(page), "the focus did not move").toBe(String(ids.hall1));
  expect(new URL(page.url()).pathname, "and nothing opened").toBe(`/dashboards/${drillId}`);
  await expect(page.getByText(narrowTip(ROW)), "no tooltip invites a click").toHaveCount(0);
  await button(page, "Cancel").click();
  await expect(button(page, "Edit")).toBeVisible();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 8. The editor

const addButton = (page: Page) => button(page, "Add widget");
const addDialog = (page: Page) => page.getByRole("dialog", { name: "Add widget", exact: true });
const fieldOf = (dialog: Locator, label: string) => dialog.getByLabel(label, { exact: true });
const saveWidget = (dialog: Locator) => dialog.getByRole("button", { name: "Save widget", exact: true });

test("8. in edit mode: no Focus button, the quiet line; a stat on the focus asset and a breakdown under it save with scope focus, no assets and no root; a fixed widget is unchanged", async ({ page }) => {
  test.setTimeout(300_000);
  await prepare(page);
  const read = async (): Promise<ApiDashboard> => json<ApiDashboard>(page.request, `/api/dashboards/${editId}`);
  const before = (await read()).widgets.find((x) => x.title === "W25 own stat")!;
  expect(before.config.scope, "the stored fixed widget has no scope").toBeUndefined();

  await page.goto(`/dashboards/${editId}?asset=${ids.hall1}`);
  await expect(page.getByRole("heading", { level: 1, name: D_EDIT, exact: true })).toBeVisible();
  await expect(button(page, "Focus")).toBeVisible();
  await button(page, "Edit").click();
  await expect(button(page, "Save")).toBeVisible();
  await expect(addButton(page)).toBeEnabled(); // it waits for the asset list
  await expect(button(page, "Focus"), "edit mode has no Focus button").toHaveCount(0);
  await expect(page.getByText(`Widgets that follow the focus show ${HALL1}.`, { exact: true }), "the quiet line names the focus asset").toBeVisible();
  await expectTrail(page, D_EDIT, ids.hall1);

  // A stat that shows the focus asset: the picker is gone, the choice is one radio of a group named Show.
  await addButton(page).click();
  let dialog = addDialog(page);
  await expect(dialog).toBeVisible();
  await fieldOf(dialog, "Type").selectOption({ value: "stat" });
  await fieldOf(dialog, "Source").selectOption({ value: "energy" });
  await fieldOf(dialog, "Title").fill("W25 stat follows");
  const show = dialog.getByRole("group", { name: "Show", exact: true });
  await expect(show.getByRole("radio", { name: "Assets chosen here", exact: true }), "the old way is the default").toBeChecked();
  await show.getByRole("radio", { name: "The focus asset", exact: true }).check();
  await expect(dialog.getByRole("group", { name: "Asset", exact: true }), "the picker is gone").toHaveCount(0);
  await expect(saveWidget(dialog), "nothing else to choose").toBeEnabled();
  await saveWidget(dialog).click();
  await expect(dialog).toBeHidden();

  // A breakdown under the focus asset: The focus asset beside Whole site, and the live line says so.
  await addButton(page).click();
  dialog = addDialog(page);
  await fieldOf(dialog, "Type").selectOption({ value: "bar" });
  await fieldOf(dialog, "Source").selectOption({ value: "energy" });
  await fieldOf(dialog, "Title").fill("W25 bars follow");
  await fieldOf(dialog, "Bars").selectOption("kind");
  await fieldOf(dialog, "One bar for each").fill("Rack");
  await dialog.getByRole("button", { name: "The focus asset", exact: true }).click();
  await expect(dialog.getByText("Under: The focus asset", { exact: true })).toBeVisible();
  await expect(saveWidget(dialog)).toBeEnabled();
  await saveWidget(dialog).click();
  await expect(dialog).toBeHidden();

  // The fixed widget goes through its own dialog and is saved untouched: a trip through the form must not add a scope.
  await page.getByRole("button", { name: "Edit W25 own stat", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Edit widget", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Show", exact: true }).getByRole("radio", { name: "Assets chosen here", exact: true })).toBeChecked();
  await fieldOf(dialog, "Title").fill("W25 own stat");
  await saveWidget(dialog).click();
  await expect(dialog).toBeHidden();

  await button(page, "Save").click();
  await expect(button(page, "Edit"), "the dashboard is saved and back in view mode").toBeVisible();
  const saved = await read();
  const byTitle = (title: string): ApiWidget => {
    const found = saved.widgets.find((x) => x.title === title);
    expect(found, `the saved dashboard has ${title}`).toBeTruthy();
    return found!;
  };
  const stat = byTitle("W25 stat follows");
  expect(stat.config.scope, "the stat follows the focus").toBe("focus");
  expect(stat.config.assets, "and names no asset").toEqual([]);
  const bars = byTitle("W25 bars follow");
  expect(bars.config).toMatchObject({ scope: "focus", bars: "kind", kind: "Rack", assets: [] });
  expect("root" in bars.config, "a breakdown under the focus has no root").toBe(false);
  expect(JSON.stringify(byTitle("W25 own stat").config), "the fixed widget's config is byte for byte what it was").toBe(JSON.stringify(before.config));

  // Reopened, the choices are still made.
  await page.goto(`/dashboards/${editId}?asset=${ids.hall1}`);
  await button(page, "Edit").click();
  await expect(addButton(page)).toBeEnabled();
  await page.getByRole("button", { name: "Edit W25 stat follows", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Edit widget", exact: true });
  await expect(dialog.getByRole("group", { name: "Show", exact: true }).getByRole("radio", { name: "The focus asset", exact: true })).toBeChecked();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit W25 bars follow", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Edit widget", exact: true });
  await expect(dialog.getByText("Under: The focus asset", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await button(page, "Cancel").click();
  await expect(button(page, "Edit")).toBeVisible();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 9. Look and size

async function sidebar(page: Page, want: "expanded" | "minimized"): Promise<void> {
  const shell = page.locator(".shell");
  if ((await shell.getAttribute("data-sidebar")) !== want) await page.locator(".side-toggle").click();
  await expect(shell).toHaveAttribute("data-sidebar", want);
  await settled(page);
}

const LAYOUTS = [
  { width: 1440, height: 900, bar: "expanded" },
  { width: 1024, height: 768, bar: "minimized" },
  { width: 1024, height: 768, bar: "expanded" },
] as const;

for (const layout of LAYOUTS) {
  test(`9. ${layout.width} px, sidebar ${layout.bar}: Focus, Open page and Edit stay in the window and apart, with a very long dashboard name and a very long asset name, light and dark`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await prepare(page);
    for (const look of [LIGHT, DARK]) {
      const where = `${layout.width} px ${layout.bar} ${look.mode}`;
      await setLook(page, look);
      await openDashboard(page, longId, D_LONG, [T_FOLLOW], `?asset=${ids.long}`);
      await sidebar(page, layout.bar);
      await expect(page.locator("html")).toHaveAttribute("data-mode", look.mode === "dark" ? /dark/ : /light/);
      const link = openLink(page, LONG_ASSET);
      await expect(link, `${where}: the link to the long-named asset`).toBeVisible();
      const parts: [string, Locator][] = [
        ["the title", page.getByRole("heading", { level: 1, name: D_LONG, exact: true })], ["Dashboard range", page.getByLabel("Dashboard range")],
        ["Focus", button(page, "Focus")], ["Open page", link], ["Edit", button(page, "Edit")],
      ];
      const boxes: [string, Box][] = [];
      for (const [what, target] of parts) boxes.push([what, await boxOf(target, `${where}: ${what}`)]);
      for (let i = 0; i < boxes.length; i++) {
        expect(inside(boxes[i][1], { x: 0, y: 0, width: layout.width, height: 100_000 }), `${where}: ${boxes[i][0]} lies inside the window`).toBe(true);
        for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i][1], boxes[j][1]), `${where}: ${boxes[i][0]} and ${boxes[j][0]} do not overlap`).toBe(false);
      }
      const heights = [boxes[2][1].height, boxes[3][1].height, boxes[4][1].height];
      expect(Math.max(...heights) - Math.min(...heights), `${where}: Focus, Open page and Edit are one height`).toBeLessThanOrEqual(1);
      await expectNoSidewaysScroll(page, where);
      await expect(crumbsNav(page), `${where}: one trail`).toHaveCount(1);
    }
  });
}

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 640 },
  { width: 800, height: 600 },
] as const;

/** Show and Cancel are on the screen and what a click at their centres reaches; the dialog is inside the window; and its body is the box that scrolls, so the buttons do not move. */
async function expectDialogFits(page: Page, dialog: Locator, where: string): Promise<void> {
  const view = page.viewportSize()!;
  const frame = { x: 0, y: 0, width: view.width, height: view.height };
  expect(inside(await boxOf(dialog, `${where}: the dialog`), frame), `${where}: the dialog lies inside the window`).toBe(true);
  for (const name of ["Show", "Cancel"]) {
    const target = dialog.getByRole("button", { name, exact: true });
    expect(inside(await boxOf(target, `${where}: ${name}`), frame), `${where}: ${name} lies inside the window`).toBe(true);
    const reached = await target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit === el || el.contains(hit);
    });
    expect(reached, `${where}: nothing covers ${name}`).toBe(true);
  }
  expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth), `${where}: the dialog has no horizontal scroll`).toBeLessThanOrEqual(1);
  const body = dialog.locator(".focus-body");
  expect(await body.evaluate((el) => getComputedStyle(el).overflowY), `${where}: the picker's box is the one that scrolls`).toBe("auto");
  const show = await boxOf(dialog.getByRole("button", { name: "Show", exact: true }), `${where}: Show`);
  await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await settled(page);
  const after = await boxOf(dialog.getByRole("button", { name: "Show", exact: true }), `${where}: Show after the picker scrolled`);
  expect(Math.abs(after.y - show.y), `${where}: Show does not move when the picker scrolls`).toBeLessThanOrEqual(1);
}

test("9. the Focus dialog keeps Show and Cancel inside the window at 1440 x 900, 1024 x 640 and 800 x 600, light and dark", async ({ page }) => {
  test.setTimeout(240_000);
  await prepare(page);
  for (const size of SIZES) {
    await page.setViewportSize(size);
    for (const look of [LIGHT, DARK]) {
      const where = `${size.width} x ${size.height} ${look.mode}`;
      await setLook(page, look);
      await openFollow(page, ids.hall1);
      await button(page, "Focus").click();
      const dialog = dialogOf(page);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("group", { name: "Focus asset", exact: true })).toBeVisible();
      await settled(page);
      await expectDialogFits(page, dialog, where);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(button(page, "Focus"), `${where}: the focus goes back to the Focus button`).toBeFocused();
    }
  }
});

test("9. a card that follows keeps its old figures dimmed and busy while the answer for the new focus is held, and the others stay as they were", async ({ page }) => {
  test.setTimeout(180_000);
  await prepare(page);
  let hold: number | null = null;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === "/api/widget-data", async (route) => {
    const body = route.request().postDataJSON() as WidgetRequest;
    if (hold !== null && body.focus === hold) await gate;
    await route.continue().catch(() => undefined); // the page may be gone by now
  });
  try {
    await openFollow(page, ids.row);
    await expect(page.locator('.widget-body[aria-busy="true"]')).toHaveCount(0);
    hold = ids.hall1; // a focus this visit has not seen yet
    await crumbsNav(page).getByRole("link", { name: HALL1, exact: true }).click();
    await expect.poll(() => askedAsset(page)).toBe(String(ids.hall1));
    await expectTrail(page, D_FOLLOW, ids.hall1);
    for (const title of [T_FOLLOW, T_BARS, T_CHILDREN]) {
      const body = frameOf(page, title).locator(".widget-body");
      await expect(body, `${title} is busy while its answer is held`).toHaveAttribute("aria-busy", "true");
      expect(await body.evaluate((el) => Number(getComputedStyle(el).opacity)), `${title} is dimmed`).toBeLessThan(1);
      await expect(detailsButton(frameOf(page, title), title), `${title}: Details waits for the real answer`).toHaveAttribute("aria-disabled", "true");
    }
    const fixed = frameOf(page, T_FIXED).locator(".widget-body");
    await expect(fixed, "the fixed card is not busy").not.toHaveAttribute("aria-busy", "true");
    expect(await fixed.evaluate((el) => Number(getComputedStyle(el).opacity)), "and not dimmed").toBe(1);
  } finally {
    hold = null;
    release();
  }
  await expect(page.locator('.widget-body[aria-busy="true"]'), "the answers land and the cards are plain again").toHaveCount(0);
  await expect(frameOf(page, T_CHILDREN).locator("table.widget-table tbody td:first-child")).toHaveText([ROW]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 5 (last). One top-level asset

test("5. with ONE top-level asset it is the focus without being chosen: the cards that follow show it, its own id in the address is dropped without a line, and the trail does not repeat it", async ({ page }) => {
  test.setTimeout(240_000);
  const w = await prepare(page);
  // This spec's own roots do not count. One other root: it is THE top-level asset once W25 Site is gone. None: W25 Site is.
  const others = topLevelOf(await json<ApiAsset[]>(page.request, "/api/assets")).filter((a) => !a.name.startsWith("W25 "));
  test.skip(others.length > 1, `needs a stack with at most one top-level asset besides this spec's own; this one has ${others.length}`);
  if (others.length === 1) await removeTree(page.request, SITE);
  const assets = await json<ApiAsset[]>(page.request, "/api/assets");
  const roots = topLevelOf(assets);
  expect(roots.length, "exactly one top-level asset is left").toBe(1);
  const sole = roots[0];
  const children = assets.filter((a) => a.parent_id === sole.id);
  expect(children.length, "and it has something below it").toBeGreaterThan(0);

  await openFollow(page, null);
  await expect.poll(() => w.answers.length, { message: "the answers have come" }).toBeGreaterThanOrEqual(3);
  const answerOf = (type: string, scope: string) => w.answers.find((a) => a.body.type === type && a.body.config.scope === scope)?.answer;
  expect(answerOf("stat", "focus")?.focus, "the card that follows shows the only top-level asset").toMatchObject({ asset: { id: sole.id, name: sole.name }, state: "ok", top_level: 1 });
  expect(answerOf("table", "children")?.focus?.children, "the table lists its children").toEqual({ shown: Math.min(children.length, 20), count: children.length });
  expect(answerOf("bar", "focus")?.breakdown?.root, "the breakdown looks under it").toMatchObject({ id: sole.id });
  await expect(frameOf(page, T_FOLLOW), "no card asks for a focus").not.toContainText("choose a focus");
  await expectTrail(page, D_FOLLOW, null);

  // Its own id in the address is no focus at all: dropped, with no line.
  await page.goto(`/dashboards/${followId}?asset=${sole.id}`);
  await expect(page.getByRole("heading", { level: 1, name: D_FOLLOW, exact: true })).toBeVisible();
  await expect.poll(() => askedAsset(page), { message: "the sole root's id is dropped" }).toBeNull();
  await settled(page);
  await expect(page.getByText(GONE, { exact: true })).toHaveCount(0);
  await expect(page.getByText(DENIED, { exact: true })).toHaveCount(0);
  await expectTrail(page, D_FOLLOW, null);

  // A child of it: the trail starts at the child.
  await page.goto(`/dashboards/${followId}?asset=${children[0].id}`);
  await expect(openLink(page, children[0].name)).toBeVisible();
  await expect(crumbItems(page)).toHaveText(["Dashboards", D_FOLLOW, children[0].name]);
});
