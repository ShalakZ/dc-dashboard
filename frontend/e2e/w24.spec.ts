import { execFileSync } from "node:child_process";
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { markGuideSeen } from "./shell";

test.beforeEach(({ page }) => markGuideSeen(page)); // w27: the dashboard guide is not what this spec looks at

// W24 (the power dashboard, part 3a): a stat and a daily chart that set this month so far against the same days of last month, and a bar chart with one bar per asset of a kind ("Split by" on the
// card). Admin `admin` / `correct-horse`, as in the earlier projects. The contract is the plan docs/superpowers/plans/2026-10-19-w24-power-compare-and-breakdown.md ("API contract" and the last section).
//
// THE MOCKED CASES (1 to 6) NEVER DEPEND ON TODAY'S DATE. beforeAll makes `W24 Site` > `W24 Hall 1` > `W24 Rack 01`..`03` through POST /api/assets and two dashboards through POST
// /api/dashboards: `w24 <run>` (a compare stat of energy, a compare stat of cost, a compare daily chart and a breakdown by Rack, saved with PUT) that the cases only OPEN, and `w24 <run> edit` (empty) that
// the editor cases add widgets to. Every `POST /api/widget-data` (and its CSV) is answered through page.route from the fixtures below, with a fixed window ("1 to 17 Oct" against "1 to 17 Sep"), so the
// words, marks and layout are tested without a seed. Each case stores its own look (PUT /api/me/preferences) before the page opens and afterAll puts the account's own look back. Writes the case does
// not expect are refused with a 500 and fail it (case 4 allows none; case 5 lets the one dashboard save through). Names are matched by SUBSTRING, so every lookup is `exact: true`. The words are
// written here again, as literals (src/lib/compare.ts, src/lib/breakdown.ts), so a change of wording shows up as a failure.
//   1   the compare STAT of energy: the figure for days 1 to 17, the two window labels, "Same days last month", the change in words and sign ("up 12.4 % (+124.00 kWh)"), `~` on an estimated
//       side, a fall and "no change", the reserved note line keeps its place (and the card its rows) when notes come and go, the Details table; light and dark.
//   2   the compare STAT of cost: a partial cost (`*`) withholds the percentage and says why, the rate note, the closed-month note, several notes ("+3 more in Details" and all four in Details),
//       the `last_state` texts (not in the closed figures, another zone), no readings last month, another currency, and "Nothing to compare yet" on the 1st.
//   3   the compare DAILY CHART: read through its text alternative (the legend is canvas) and the hover tooltip, which names both dates of a day and leaves out a day with no readings; light and
//       dark; the Details table.
//   4   the BREAKDOWN: "and 107 more Racks: 1,234.50 kWh in all", the marks (`~`, "with no data", "inside other Racks"), "Split by" (accessible name, "Rack (117)"), a choice sends a request whose
//       config has that kind, keeps the focus, saves nothing; "None of the 8 Panels under W24 Hall 1 has energy readings."; "No Racks under W24 Hall 1. Choose another kind in Split by.".
//   5   the EDITOR: the comparison box locks Widget range and turns the picker single; Bars gains "One bar per asset of a kind" with Look under, One bar for each, Bars to show and Whole site; the
//       saved configs hold compare, kind, root and top only when they are not the default (read back with GET /api/dashboards/<id>); keyboard only; Escape closes the innermost layer.
//   6   PLACEMENT at 1440 x 900, 1024 x 640 and 800 x 600, light and dark: the card's new parts and the editor's new fields do not overlap, nothing scrolls, Save widget stays inside the window;
//       and a skeleton draws the rows of the loaded card.
// CASE R needs the scratch stack: it runs only when COMPOSE_PROJECT_NAME starts with `dcdash_e2e_` (like w11 and w21) and is skipped with its message otherwise. beforeAll raises the raw retention to 90
// days (the old value goes back in afterAll), seeds the pilot hall INSIDE the stack, makes a site-wide rate when there is none and a dashboard `w24 <run> real`. The expected numbers come from
// Billing's own API (GET /api/billing/costs: the day cells 1 to D of this month and of last month, D and N read from the widget-data answer, never from the browser's clock), never from fixed values.
//   R1  the compare stats equal the sums of Billing's day cells (kWh and cost, both windows) to the digits shown, also in the Details table; on the 1st the cards say "Nothing to compare yet".
//   R2  a breakdown by Rack under Hall 1 says "and 59 - top more Racks"; one under the whole pilot hall splits by Panel and says "None of the 8 Panels under Seeded pilot hall has energy readings.".
//   R3  last month is closed through the API, the rack's rate is changed, and after a reload the card's last side did not move and says "Last month is closed"; the month is reopened afterwards.
// afterAll puts the stack back: last month open, the site rate and the rack's rate deleted, the seeded subtree and its source deleted, the retention as it was.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const SCRATCH = (process.env.COMPOSE_PROJECT_NAME ?? "").startsWith("dcdash_e2e_");
const SKIP_MESSAGE = "needs the scratch stack's COMPOSE_PROJECT_NAME (dcdash_e2e_*); the seeder refuses anything else";

interface Look { mode: "light" | "dark"; theme: string }
interface Box { x: number; y: number; width: number; height: number }
const LIGHT: Look = { mode: "light", theme: "navy-gold" };
const DARK: Look = { mode: "dark", theme: "desert-gold" };

const RUN = Date.now().toString(36);
const D_CARDS = `w24 ${RUN}`;
const D_EDIT = `w24 ${RUN} edit`;
const D_REAL = `w24 ${RUN} real`;
/** What an earlier run that stopped half way may have left behind: `w24 ` and a run id (Date.now() in base 36 is 8 characters until 2059), nothing a person named. */
const LEFTOVER = /^w24 [0-9a-z]{8}( edit| real)?$/;

const SITE = "W24 Site";
const HALL = "W24 Hall 1";
const RACKS = ["W24 Rack 01", "W24 Rack 02", "W24 Rack 03"] as const;

const T_KWH = "W24 energy so far";
const T_COST = "W24 cost so far";
const T_CHART = "W24 daily energy";
const T_BARS = "W24 racks";

const COMPARE = "same_days_last_month";
const COMPARE_LABEL = "Compare with the same days of last month";
const COMPARE_NOTE = "A comparison always looks at this month so far, against the same days of last month.";
const KIND_TIP = "Choose the level that carries the meters, for example Panels or Racks.";
const CURRENCY = "USD";
const NOTHING_YET = "Nothing to compare yet";
const CLOSED_NOTE = "Last month is closed: these are its closed figures.";
const OLD_KEYS = ["aggregation", "assets", "bars", "max", "metric", "min", "range", "source"]; // a widget config before w24

test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------------------------------------------------------------
// The data, the dashboards and the look

const ids = { site: 0, hall: 0, racks: [0, 0, 0] };
let cardsId = 0;
let editId = 0;
/** The look the account had before this spec (read from GET /api/me in beforeAll); afterAll stores exactly this one. */
let originalLook: Look = LIGHT;

interface ApiAsset { id: number; parent_id: number | null; name: string; kind: string }
interface ApiSource { id: number; name: string }

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

/** Deletes every top-level asset called `name` with everything below it. */
async function removeTree(request: APIRequestContext, name: string): Promise<void> {
  for (const old of (await json<ApiAsset[]>(request, "/api/assets")).filter((a) => a.parent_id === null && a.name === name)) {
    const gone = await request.delete(`/api/assets/${old.id}?confirm=true`);
    expect([200, 204, 404], `deleting ${name} (${old.id}): ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
}

interface WidgetBody { title: string; type: string; x: number; y: number; w: number; h: number; config: Record<string, unknown> }
interface ApiWidget extends WidgetBody { id: number }
interface ApiDashboard { id: number; name: string; range: string; updated_at: string; widgets: ApiWidget[] }

/** The config the API stores for a data widget; the w24 keys are added by the caller, and only when they are not their default. */
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

/** The four cards of the mocked cases: a compare stat of energy and one of cost (3 x 3), a compare daily chart and a breakdown by Rack under the hall (default top). */
function cardWidgets(): WidgetBody[] {
  const rack = [ids.racks[0]];
  return [
    { title: T_KWH, type: "stat", x: 0, y: 0, w: 3, h: 3, config: config({ assets: rack, range: "this_month", compare: COMPARE }) },
    { title: T_COST, type: "stat", x: 3, y: 0, w: 3, h: 3, config: config({ assets: rack, source: "cost", range: "this_month", compare: COMPARE }) },
    { title: T_CHART, type: "timeseries", x: 6, y: 0, w: 6, h: 5, config: config({ assets: rack, range: "this_month", compare: COMPARE }) },
    { title: T_BARS, type: "bar", x: 0, y: 3, w: 6, h: 5, config: config({ bars: "kind", kind: "Rack", root: ids.hall }) },
  ];
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  await asAdmin(browser, async (request) => {
    const me = await json<{ preferences: Look }>(request, "/api/me");
    originalLook = { mode: me.preferences.mode, theme: me.preferences.theme }; // what the account had before this spec; afterAll puts exactly this back
    const prefs = await request.put("/api/me/preferences", { data: LIGHT });
    expect(prefs.ok(), `starting from the light look: ${prefs.status()} ${await prefs.text()}`).toBe(true);
    for (const old of (await json<{ id: number; name: string }[]>(request, "/api/dashboards")).filter((d) => LEFTOVER.test(d.name))) await request.delete(`/api/dashboards/${old.id}`);
    await removeTree(request, SITE);

    // One at a time: the server serialises the sibling-name check.
    ids.site = await createAsset(request, SITE, null, "Site", 1);
    ids.hall = await createAsset(request, HALL, ids.site, "Hall", 1);
    for (const [i, name] of RACKS.entries()) ids.racks[i] = await createAsset(request, name, ids.hall, "Rack", i + 1);
    cardsId = await createDashboard(request, D_CARDS, cardWidgets());
    editId = await createDashboard(request, D_EDIT, []);
  });
});

test.afterAll(async ({ browser }) => {
  test.setTimeout(300_000);
  await asAdmin(browser, async (request) => {
    await request.put("/api/me/preferences", { data: originalLook });
    for (const id of [cardsId, editId]) if (id) await request.delete(`/api/dashboards/${id}`);
    await removeTree(request, SITE); // the whole subtree, whether or not beforeAll got to the end
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The fixtures (the answers of POST /api/widget-data, from the plan's API contract)

interface Side { kwh: number; cost: number | null; estimated: boolean; partial: boolean; no_data_days: number }
type Why = null | "currency" | "no_cost" | "no_previous" | "no_current" | "missing_days" | "partial" | "previous_zero";
interface Change { abs: number | null; percent: number | null; why_none: Why }
interface Point { ts: string; value: number | null; min: null; max: null; estimated: boolean; partial: boolean; no_data: boolean }
interface CompareAsset {
  asset_id: number; name: string; this: Side | null; last: Side | null; last_state: "ok" | "no_readings" | "not_in_closed" | "other_zone";
  kwh: Change; cost: Change; rate_change: { date: string } | null; last_points: Point[];
}
interface Window { from: string; to: string }
interface Compare {
  mode: string; state: "ok" | "nothing_yet"; elapsed_days: number; days: number; this_window: Window | null; last_window: Window | null;
  left_out_days: string[]; last_month: { month: string; closed: boolean }; currency: string | null; assets: CompareAsset[];
}
interface Breakdown {
  kind: string; root: { id: number; name: string } | null; count: number; shown: number;
  more: { count: number; with_value: number; value: number | null; estimated: boolean; partial: boolean };
  no_data: number; inside_others: number; kinds: { kind: string; count: number }[];
}
interface WidgetRequest { type: string; config: { assets: number[]; source: string; bars: string; range: string | null; compare?: string; kind?: string; root?: number; top?: number }; range: string }

const side = (kwh: number, cost: number | null, over: Partial<Side> = {}): Side => ({ kwh, cost, estimated: false, partial: false, no_data_days: 0, ...over });
const change = (abs: number | null, percent: number | null, why: Why = null): Change => ({ abs, percent, why_none: why });

/** October against September, 17 days each: this month 1124.00 kWh and 168.60, last month 1000.00 kWh and 150.00, up 12.4 % on both. Nothing is estimated, partial or missing. */
function compareBlock(): Compare {
  return {
    mode: COMPARE, state: "ok", elapsed_days: 17, days: 17,
    this_window: { from: "2026-10-01", to: "2026-10-17" }, last_window: { from: "2026-09-01", to: "2026-09-17" },
    left_out_days: [], last_month: { month: "2026-09", closed: false }, currency: CURRENCY,
    assets: [{
      asset_id: ids.racks[0], name: RACKS[0], this: side(1124, 168.6), last: side(1000, 150), last_state: "ok",
      kwh: change(124, 12.4), cost: change(18.6, 12.4), rate_change: null, last_points: [],
    }],
  };
}

/** March against February: 28 days each, the 29th and 30th have no matching day, last month closed, last month has no readings on 3 days. */
function marchBlock(): Compare {
  const c = compareBlock();
  c.elapsed_days = 30;
  c.days = 28;
  c.this_window = { from: "2026-03-01", to: "2026-03-28" };
  c.last_window = { from: "2026-02-01", to: "2026-02-28" };
  c.left_out_days = ["2026-03-29", "2026-03-30"];
  c.last_month = { month: "2026-02", closed: false };
  return c;
}

function nothingYet(): Compare {
  const c = compareBlock();
  c.state = "nothing_yet";
  c.elapsed_days = 0;
  c.days = 0;
  c.this_window = null;
  c.last_window = null;
  c.assets = [];
  return c;
}

const dayStamp = (month: string, day: number): string => `${month}-${String(day).padStart(2, "0")}T00:00:00Z`;
function dayPoints(month: string, count: number, valueOf: (day: number) => number, over: (day: number) => Partial<Point> = () => ({})): Point[] {
  return Array.from({ length: count }, (_, i): Point => {
    const day = i + 1;
    const point: Point = { ts: dayStamp(month, day), value: valueOf(day), min: null, max: null, estimated: false, partial: false, no_data: false };
    const changed = { ...point, ...over(day) };
    return changed.no_data ? { ...changed, value: null } : changed;
  });
}

/**
 * The days of the daily chart: October 1 to 17 at 61 to 77 kWh with NO readings on the 5th, September 1 to 17 at 56 to 72 kWh with no readings on the 9th and the 12th estimated.
 */
function defaultPoints(): { now: Point[]; last: Point[] } {
  return {
    now: dayPoints("2026-10", 17, (d) => 60 + d, (d) => (d === 5 ? { no_data: true } : {})),
    last: dayPoints("2026-09", 17, (d) => 55 + d, (d) => (d === 9 ? { no_data: true } : d === 12 ? { estimated: true } : {})),
  };
}

function breakdownBlock(over: Partial<Breakdown> = {}): Breakdown {
  return {
    kind: "Rack", root: { id: ids.hall, name: HALL }, count: 117, shown: 10,
    more: { count: 107, with_value: 107, value: 1234.5, estimated: false, partial: false }, no_data: 0, inside_others: 0,
    kinds: [{ kind: "Rack", count: 117 }, { kind: "Panel", count: 8 }, { kind: "Row", count: 4 }], ...over,
  };
}

function defaultBreakdown(kind: string): { block: Breakdown; noData: boolean } {
  if (kind === "Panel") {
    return { block: breakdownBlock({ kind: "Panel", count: 8, shown: 8, more: { count: 0, with_value: 0, value: null, estimated: false, partial: false }, no_data: 8 }), noData: true };
  }
  return { block: breakdownBlock({ kind }), noData: false };
}

/** The whole answer of POST /api/widget-data: every key of WidgetData, `compare` and `breakdown` null where unused. */
function envelope(type: string, source: string, over: Record<string, unknown>): Record<string, unknown> {
  return {
    type, mode: "values", source, metric: null, unit: source === "cost" ? CURRENCY : "kWh",
    range: { preset: "this_month", start: "2026-10-01T00:00:00Z", end: "2026-10-18T00:00:00Z" }, tier: null, bucket: null,
    series: [], values: [], missing: [], no_metric: [], compare: null, breakdown: null, ...over,
  };
}

function statAnswer(source: string, compare: Compare): Record<string, unknown> {
  const asset = compare.assets[0];
  const now = asset?.this ?? null;
  const row = asset === undefined ? [] : [{
    asset_id: asset.asset_id, name: asset.name, value: now === null ? null : source === "cost" ? now.cost : now.kwh, estimated: now?.estimated ?? false,
    partial: source === "cost" && (now?.partial ?? false), point_id: null, no_data: now === null, ts: null, stale: false,
  }];
  return envelope("stat", source, { values: row, compare });
}

function chartAnswer(source: string, compare: Compare, points: { now: Point[]; last: Point[] }): Record<string, unknown> {
  if (compare.assets[0]) compare.assets[0].last_points = points.last;
  const series = compare.assets[0] ? [{ asset_id: compare.assets[0].asset_id, name: compare.assets[0].name, points: points.now, estimated: false, partial: false }] : [];
  return envelope("timeseries", source, { mode: "series", bucket: "day", series, compare });
}

function breakdownAnswer(source: string, block: Breakdown, noData: boolean): Record<string, unknown> {
  const values = Array.from({ length: block.shown }, (_, i) => ({
    asset_id: 9000 + i, name: `${block.kind} ${String(i + 1).padStart(2, "0")}`, value: noData ? null : 500 - i * 10, estimated: false, partial: false,
    point_id: null, no_data: noData, ts: null, stale: false,
  }));
  return envelope("bar", source, { values, breakdown: block });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The stub: the answers of one case, the requests it saw, the writes it refused

interface Stub {
  requests: WidgetRequest[]; // every POST /api/widget-data
  csv: WidgetRequest[]; // every POST /api/widget-data/csv
  stray: string[]; // the writes the case does not expect (the page got a 500 for each)
  errors: string[]; // console errors and uncaught exceptions of the page
  compare: () => Compare; // the comparison block each compare widget is answered with: change it, then reload
  points: () => { now: Point[]; last: Point[] }; // the days of the daily chart
  breakdown: (kind: string) => { block: Breakdown; noData: boolean }; // the breakdown for the kind asked for
  gate: Promise<void> | null; // while set, every widget-data answer waits for it
  releases: (() => void)[];
}
let current: Stub | null = null;

test.afterEach(() => {
  const stub = current;
  current = null;
  if (!stub) return;
  for (const release of stub.releases) release();
  expect(stub.stray, "the case writes nothing it does not expect: these requests were refused").toEqual([]);
  expect(stub.errors, "the page logged no console error and no exception").toEqual([]);
});

const ALWAYS_OK = [/^POST \/api\/login$/, /^PUT \/api\/me\/preferences$/, /^POST \/api\/widget-data(\/csv)?$/];

/** Holds the widget-data answers back until the returned function is called (also called after the case, so the page is never left waiting). */
function hold(stub: Stub): () => void {
  let release!: () => void;
  stub.gate = new Promise<void>((resolve) => { release = resolve; });
  stub.releases.push(release);
  return () => { stub.gate = null; release(); };
}

function answerFor(stub: Stub, body: WidgetRequest): Record<string, unknown> {
  const c = body.config;
  if (c.bars === "kind") {
    const { block, noData } = stub.breakdown(c.kind ?? "");
    return breakdownAnswer(c.source, block, noData);
  }
  if (c.compare === COMPARE) return body.type === "timeseries" ? chartAnswer(c.source, stub.compare(), stub.points()) : statAnswer(c.source, stub.compare());
  const row = body.type === "stat" && c.assets.length > 0
    ? [{ asset_id: c.assets[0], name: "an asset", value: 12.5, estimated: false, partial: false, point_id: null, no_data: false, ts: null, stale: false }] : [];
  return envelope(body.type, c.source, { values: row });
}

/** Signs in, stores the look, answers the widget queries from the fixtures, refuses every write that is not expected, and listens for errors. */
async function prepare(page: Page, look: Look = LIGHT, allow: RegExp[] = []): Promise<Stub> {
  const stub: Stub = { requests: [], csv: [], stray: [], errors: [], compare: compareBlock, points: defaultPoints, breakdown: defaultBreakdown, gate: null, releases: [] };
  current = stub;
  page.on("console", (message) => {
    if (message.type() !== "error" || /net::ERR_ABORTED/.test(message.text())) return;
    stub.errors.push(`console: ${message.text()} (${message.location().url})`);
  });
  page.on("pageerror", (error) => stub.errors.push(`pageerror: ${error.message}`));
  // Registered FIRST, so it is asked last: a write that is neither listed nor allowed by the case is refused and written down.
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    if (method === "GET" || method === "HEAD") return route.fallback();
    const line = `${method} ${path}`;
    if ([...ALWAYS_OK, ...allow].some((pattern) => pattern.test(line))) return route.fallback();
    stub.stray.push(line);
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "w24: this case does not expect this write" }) });
  });
  await page.route((url) => url.pathname === "/api/widget-data", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as WidgetRequest;
    stub.requests.push(body);
    if (stub.gate) await stub.gate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answerFor(stub, body)) }).catch(() => undefined); // the page may be gone by now
  });
  await page.route((url) => url.pathname === "/api/widget-data/csv", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    stub.csv.push(route.request().postDataJSON() as WidgetRequest);
    await route.fulfill({ status: 200, contentType: "text/csv", headers: { "content-disposition": 'attachment; filename="w24.csv"' }, body: "path,ts,value\n" }).catch(() => undefined);
  });
  await signIn(page, look);
  return stub;
}

/** Signs in and stores the look the case needs (the account's saved look wins over the browser's mirror, so it is set through the API before a page opens). */
async function signIn(page: Page, look: Look): Promise<void> {
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in: ${login.status()} ${await login.text()}`).toBe(true);
  await setLook(page, look);
}

async function setLook(page: Page, look: Look): Promise<void> {
  const saved = await page.request.put("/api/me/preferences", { data: look });
  expect(saved.ok(), `storing ${JSON.stringify(look)}: ${saved.status()} ${await saved.text()}`).toBe(true);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Locators and readings

const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
/** A card of the dashboard, by its title (every card is a region named by its title). */
const frameOf = (page: Page, title: string) => page.getByRole("region", { name: title, exact: true });
const detailsButton = (card: Locator, title: string) => card.getByRole("button", { name: `Details for ${title}`, exact: true });
const drawerOf = (page: Page, title: string) => page.getByRole("dialog", { name: `Details: ${title}`, exact: true });

/** The rows of a comparing stat. */
const statOf = (card: Locator) => ({
  big: card.locator(".stat .big"), name: card.locator(".stat-name"), windows: card.locator(".stat-window"), lastLabel: card.locator(".stat-last-label"),
  lastFig: card.locator(".stat-last-fig"), change: card.locator(".stat-change"), note: card.locator(".stat-note"), nothing: card.locator(".stat-nothing"),
});
/** The parts of a breakdown card. */
const barsOf = (card: Locator) => ({
  chart: card.locator(".widget-bars > .widget-chart"), empty: card.locator(".widget-bars > .widget-empty"), note: card.locator(".bars-note"),
  split: card.getByLabel("Split by", { exact: true }), row: card.locator(".bars-split"),
});

/** Opens a dashboard and waits until every named card is drawn, no skeleton is left and the page has stopped moving. */
async function openDashboard(page: Page, id: number, name: string, titles: string[]): Promise<void> {
  await page.goto(`/dashboards/${id}`);
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
  for (const title of titles) await expect(frameOf(page, title)).toBeVisible();
  await expect(page.locator(".sk-region, .widget-sk"), "no skeleton is left (the charts load their chunk after the answer)").toHaveCount(0);
  await settled(page);
}
const openCards = (page: Page) => openDashboard(page, cardsId, D_CARDS, [T_KWH, T_COST, T_CHART, T_BARS]);

/** The box of what an element holds (its checkbox and its words), not of the row it stretches across: a label spans the whole row and its tip button sits at the row's right end. */
async function contentBoxOf(target: Locator, what: string): Promise<Box> {
  const box = await target.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  expect(box.width * box.height, `${what} has a box`).toBeGreaterThan(0);
  return box;
}

async function boxOf(target: Locator, what: string): Promise<Box> {
  const box = await target.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  expect(box.width * box.height, `${what} has a box`).toBeGreaterThan(0);
  return box;
}
function expectSame(got: Box, want: Box, what: string, tolerance = 1): void {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(got[key] - want[key]), `${what}: ${key} is ${got[key]}, it was ${want[key]}`).toBeLessThanOrEqual(tolerance);
  }
}
const overlap = (a: Box, b: Box): boolean =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;
const inside = (inner: Box, outer: Box, slack = 1): boolean =>
  inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;

/** Each named part has a box, none overlaps another, and (when `within` is given) each lies inside it. */
async function expectApart(parts: [string, Locator, boolean?][], where: string, within?: Box): Promise<void> {
  const boxes: [string, Box][] = [];
  for (const [what, target, content] of parts) boxes.push([what, content ? await contentBoxOf(target, `${where}: ${what}`) : await boxOf(target, `${where}: ${what}`)]);
  for (let i = 0; i < boxes.length; i++) {
    if (within) expect(inside(boxes[i][1], within), `${where}: ${boxes[i][0]} lies inside its box`).toBe(true);
    for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i][1], boxes[j][1]), `${where}: ${boxes[i][0]} and ${boxes[j][0]} do not overlap`).toBe(false);
  }
}

/** The card's body does not scroll either way (a 3 x 3 stat holds all its rows). */
async function expectNoScroll(card: Locator, where: string): Promise<void> {
  const over = await card.locator(".widget-body").evaluate((el) => ({ y: el.scrollHeight - el.clientHeight, x: el.scrollWidth - el.clientWidth }));
  expect(over.y, `${where}: the card's body does not scroll down`).toBeLessThanOrEqual(1);
  expect(over.x, `${where}: the card's body does not scroll sideways`).toBeLessThanOrEqual(1);
}

async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, `${where}: the page does not scroll sideways`).toBeLessThanOrEqual(0);
}

/** Where the rows that move when notes come and go stand, and the card's own box. */
async function geometryOf(card: Locator): Promise<{ frame: Box; note: Box; change: Box; last: Box }> {
  const s = statOf(card);
  return {
    frame: await boxOf(card, "the card"), note: await boxOf(s.note, "the note line"), change: await boxOf(s.change, "the change line"),
    last: await boxOf(card.locator(".stat-last"), "the last-month row"),
  };
}
type Geometry = Awaited<ReturnType<typeof geometryOf>>;
function expectGeometry(now: Geometry, base: Geometry, what: string): void {
  for (const part of ["frame", "note", "change", "last"] as const) expectSame(now[part], base[part], `${what}: the ${part}`);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. The compare stat of energy

/** What the first card says with the default fixture. */
async function expectEnergyStat(page: Page, where: string): Promise<void> {
  const card = frameOf(page, T_KWH);
  const s = statOf(card);
  await expect(s.big, `${where}: the headline is the figure of days 1 to 17`).toHaveText("1,124.00 kWh");
  await expect(s.name).toHaveText(RACKS[0]);
  await expect(s.windows, `${where}: this month's window, then last month's`).toHaveText(["1 to 17 Oct", "1 to 17 Sep"]);
  await expect(s.lastLabel).toHaveText("Same days last month");
  await expect(s.lastFig).toHaveText("1,000.00 kWh");
  await expect(s.change, `${where}: the change in words and sign`).toHaveText("up 12.4 % (+124.00 kWh)");
  await expect(s.note, `${where}: no note, and the line is still there`).toHaveText("");
  await expect(card.locator(".widget-hint"), `${where}: nothing is estimated`).toHaveCount(0);
  await expect(card, `${where}: an energy card never draws a *`).not.toContainText("*");
  await expect(card.locator(".stat-compare > *"), `${where}: the headline, the name, two windows, last month's row, the change and the note`).toHaveCount(7);
}

test("1. light: the energy stat shows days 1 to 17, the two windows, last month's same days and the change in words and sign", async ({ page }) => {
  test.setTimeout(120_000);
  const stub = await prepare(page);
  await openCards(page);
  await expectEnergyStat(page, "light");
  const asked = stub.requests.filter((r) => r.type === "stat" && r.config.source === "energy");
  expect(asked.length, "the card asked for its answer").toBeGreaterThan(0);
  expect(asked[0].config.compare, "and told the server it compares").toBe(COMPARE);
  expect(asked[0].config.range, "over this month").toBe("this_month");
});

test("1. dark: the same words in the dark look", async ({ page }) => {
  test.setTimeout(120_000);
  await prepare(page, DARK);
  await openCards(page);
  await expect(page.locator("html")).toHaveAttribute("data-mode", /dark/);
  await expectEnergyStat(page, "dark");
});

test("1. the note line keeps its place and the card keeps its rows when notes come and go; the first note shows and the rest wait in Details", async ({ page }) => {
  test.setTimeout(120_000);
  const stub = await prepare(page);
  await openCards(page);
  const card = frameOf(page, T_KWH);
  const without = await geometryOf(card);
  expect(without.note.height, "the empty note line has a box of its own").toBeGreaterThan(10);

  // March against February: no percentage (last month has no readings on 3 days) and the 29th and 30th have no matching day.
  stub.compare = () => {
    const c = marchBlock();
    c.assets[0].last = side(1000, 150, { no_data_days: 3 });
    c.assets[0].kwh = change(124, null, "missing_days");
    c.assets[0].cost = change(18.6, null, "missing_days");
    return c;
  };
  await openCards(page);
  const s = statOf(card);
  await expect(s.windows).toHaveText(["1 to 28 Mar", "1 to 28 Feb"]);
  await expect(s.change, "without a percentage the amount is still said").toHaveText("up 124.00 kWh");
  await expect(s.note).toHaveText("No percentage: last month has no readings on 3 of the 28 days. (+1 more in Details)");
  await expect(s.note, "the whole text is the line's tooltip").toHaveAttribute("title", "No percentage: last month has no readings on 3 of the 28 days. 29 and 30 March have no matching day in February.");
  expectGeometry(await geometryOf(card), without, "with notes");

  await detailsButton(card, T_KWH).click();
  const drawer = drawerOf(page, T_KWH);
  await expect(drawer).toBeVisible();
  await expect(drawer.locator("ul.wd-markers > li"), "both notes in full, said once").toHaveText([
    "No percentage: last month has no readings on 3 of the 28 days.", "29 and 30 March have no matching day in February.",
  ]);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  // Back to no notes: the same box again.
  stub.compare = compareBlock;
  await openCards(page);
  expectGeometry(await geometryOf(card), without, "without notes again");
});

test("1. an estimated side keeps its ~ (and the footer says what it means); a fall and an unchanged figure are said in words", async ({ page }) => {
  test.setTimeout(120_000);
  const stub = await prepare(page);
  stub.compare = () => {
    const c = compareBlock();
    c.assets[0].this = side(1124, 168.6, { estimated: true });
    c.assets[0].last = side(1000, 150, { estimated: true });
    return c;
  };
  await openCards(page);
  const card = frameOf(page, T_KWH);
  const s = statOf(card);
  await expect(s.big).toHaveText("~1,124.00 kWh");
  await expect(s.lastFig).toHaveText("~1,000.00 kWh");
  await expect(card.locator(".widget-hint")).toHaveText("~ estimated");

  stub.compare = () => {
    const c = compareBlock();
    c.assets[0].this = side(900, 135);
    c.assets[0].kwh = change(-100, -10);
    c.assets[0].cost = change(-15, -10);
    return c;
  };
  await openCards(page);
  await expect(s.big).toHaveText("900.00 kWh");
  await expect(s.change, "a fall says down and carries the minus sign").toHaveText("down 10.0 % (-100.00 kWh)");

  stub.compare = () => {
    const c = compareBlock();
    c.assets[0].this = side(1000, 150);
    c.assets[0].kwh = change(0, 0);
    c.assets[0].cost = change(0, 0);
    return c;
  };
  await openCards(page);
  await expect(s.change).toHaveText("no change");
});

test("1. Details lists both measures for both windows by date, with the change of each", async ({ page }) => {
  test.setTimeout(120_000);
  await prepare(page);
  await openCards(page);
  await detailsButton(frameOf(page, T_KWH), T_KWH).click();
  const drawer = drawerOf(page, T_KWH);
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { level: 3, name: "Comparison", exact: true })).toBeVisible();
  const table = drawer.locator("table.wd-table").filter({ has: page.locator("caption", { hasText: RACKS[0] }) });
  await expect(table.locator("thead th")).toHaveText(["Period", "Dates", "Energy (kWh)", `Cost (${CURRENCY})`]);
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator("tbody tr").nth(0).locator("td")).toHaveText(["This month so far", "2026-10-01 to 2026-10-17", "1,124.00", "168.60"]);
  await expect(table.locator("tbody tr").nth(1).locator("td")).toHaveText(["Same days last month", "2026-09-01 to 2026-09-17", "1,000.00", "150.00"]);
  await expect(table.locator("tbody tr").nth(2).locator("td")).toHaveText(["Change", "", "up 12.4 % (+124.00 kWh)", `up 12.4 % (+18.60 ${CURRENCY})`]);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. The compare stat of cost

interface Variant {
  name: string;
  make: (c: Compare) => void;
  head: string; last: string; change: string; note: string;
  /** The tooltip of the note line, when it holds more than the line shows. */
  title?: string;
  /** What the energy card says when it differs from the cost card's note. */
  energyNote?: string;
}

const NOT_IN_CLOSED = "Not in last month's closed figures.";
const OTHER_ZONE = "Last month was closed in another time zone, so it cannot be compared day by day.";

const VARIANTS: Variant[] = [
  { name: "a plain cost", make: () => undefined, head: `168.60 ${CURRENCY}`, last: `150.00 ${CURRENCY}`, change: `up 12.4 % (+18.60 ${CURRENCY})`, note: "" },
  {
    name: "a partial cost (*) withholds the percentage and says why",
    make: (c) => { c.assets[0].this = side(1124, 168.6, { partial: true }); c.assets[0].cost = change(18.6, null, "partial"); },
    head: `168.60* ${CURRENCY}`, last: `150.00 ${CURRENCY}`, change: `up 18.60* ${CURRENCY}`, note: "No percentage: some of the cost has no rate.", energyNote: "",
  },
  {
    name: "a rate that changed inside the windows is said on the cost card only",
    make: (c) => { c.assets[0].rate_change = { date: "2026-10-05" }; },
    head: `168.60 ${CURRENCY}`, last: `150.00 ${CURRENCY}`, change: `up 12.4 % (+18.60 ${CURRENCY})`, note: "A rate changed on 5 Oct, so the cost change is not only usage.", energyNote: "",
  },
  {
    name: "a closed last month says so",
    make: (c) => { c.last_month.closed = true; },
    head: `168.60 ${CURRENCY}`, last: `150.00 ${CURRENCY}`, change: `up 12.4 % (+18.60 ${CURRENCY})`, note: CLOSED_NOTE,
  },
  {
    name: "four notes show the first and count the other three",
    make: (c) => {
      Object.assign(c, marchBlock(), { assets: c.assets });
      c.last_month.closed = true;
      c.assets[0].this = side(1124, 168.6, { partial: true });
      c.assets[0].cost = change(18.6, null, "partial");
      c.assets[0].rate_change = { date: "2026-03-05" };
    },
    head: `168.60* ${CURRENCY}`, last: `150.00 ${CURRENCY}`, change: `up 18.60* ${CURRENCY}`,
    note: "No percentage: some of the cost has no rate. (+3 more in Details)",
    title: `No percentage: some of the cost has no rate. A rate changed on 5 Mar, so the cost change is not only usage. 29 and 30 March have no matching day in February. ${CLOSED_NOTE}`,
    energyNote: `29 and 30 March have no matching day in February. (+1 more in Details)`,
  },
  {
    name: "an asset that is not in the closed figures has no comparison",
    make: (c) => {
      c.last_month.closed = true;
      Object.assign(c.assets[0], { last: null, last_state: "not_in_closed", kwh: change(null, null, "no_previous"), cost: change(null, null, "no_previous") });
    },
    head: `168.60 ${CURRENCY}`, last: "—", change: "—", note: NOT_IN_CLOSED,
  },
  {
    name: "a month closed in another time zone cannot be compared day by day",
    make: (c) => {
      c.last_month.closed = true;
      Object.assign(c.assets[0], { last: null, last_state: "other_zone", kwh: change(null, null, "no_previous"), cost: change(null, null, "no_previous") });
    },
    head: `168.60 ${CURRENCY}`, last: "—", change: "—", note: OTHER_ZONE,
  },
  {
    name: "no readings last month",
    make: (c) => {
      Object.assign(c.assets[0], { last: null, last_state: "no_readings", kwh: change(null, null, "no_previous"), cost: change(null, null, "no_previous") });
    },
    head: `168.60 ${CURRENCY}`, last: "—", change: "—", note: "No readings last month.",
  },
  {
    name: "another currency gives no cost comparison but keeps the energy",
    make: (c) => {
      c.last_month.closed = true;
      c.assets[0].last = side(1000, null);
      c.assets[0].cost = change(null, null, "currency");
    },
    head: `168.60 ${CURRENCY}`, last: "—", change: "—", note: "No cost comparison: the currency changed since last month closed. (+1 more in Details)",
    title: `No cost comparison: the currency changed since last month closed. ${CLOSED_NOTE}`, energyNote: CLOSED_NOTE,
  },
];

for (const variant of VARIANTS) {
  test(`2. the cost stat, ${variant.name}`, async ({ page }) => {
    test.setTimeout(120_000);
    const stub = await prepare(page);
    const card = frameOf(page, T_COST);
    const s = statOf(card);
    // The plain answer first: where the rows stand with no note at all.
    await openCards(page);
    const base = await geometryOf(card);
    stub.compare = () => { const c = compareBlock(); variant.make(c); return c; };
    await openCards(page);
    await expect(s.big, "the headline is the cost").toHaveText(variant.head);
    await expect(s.lastFig).toHaveText(variant.last);
    await expect(s.change).toHaveText(variant.change);
    await expect(s.note).toHaveText(variant.note);
    await expect(s.note, "the tooltip of the line holds every note").toHaveAttribute("title", variant.title ?? variant.note);
    // Whatever the note says, the rows stand where they stood with no note.
    expectGeometry(await geometryOf(card), base, variant.name);
    // The energy card of the same answer: kWh never takes the cost's marks or its rate note.
    const energy = statOf(frameOf(page, T_KWH));
    await expect(energy.note, "the energy card's own note").toHaveText(variant.energyNote ?? variant.note);
    await expect(frameOf(page, T_KWH)).not.toContainText("*");
  });
}

test("2. the 1st of the month: every comparing card says Nothing to compare yet and draws no figure", async ({ page }) => {
  test.setTimeout(120_000);
  const stub = await prepare(page);
  stub.compare = nothingYet;
  await openCards(page);
  for (const title of [T_KWH, T_COST]) {
    const s = statOf(frameOf(page, title));
    await expect(s.nothing, `${title} says it`).toHaveText(NOTHING_YET);
    await expect(s.big, `${title} draws no figure`).toHaveCount(0);
    await expect(s.change).toHaveCount(0);
  }
  await expect(frameOf(page, T_CHART).locator(".widget-empty"), "so does the daily chart").toHaveText(NOTHING_YET);
  await expect(frameOf(page, T_CHART).locator("canvas")).toHaveCount(0);
  await detailsButton(frameOf(page, T_COST), T_COST).click();
  await expect(drawerOf(page, T_COST).locator(".wd-note").filter({ hasText: NOTHING_YET })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("2. Details of a cost stat with several notes lists all of them: what is true of both measures first, then Energy and Cost", async ({ page }) => {
  test.setTimeout(120_000);
  const stub = await prepare(page);
  stub.compare = () => {
    const c = marchBlock();
    c.last_month.closed = true;
    c.assets[0].this = side(1124, 168.6, { partial: true });
    c.assets[0].cost = change(18.6, null, "partial");
    c.assets[0].rate_change = { date: "2026-03-05" };
    return c;
  };
  await openCards(page);
  await detailsButton(frameOf(page, T_COST), T_COST).click();
  const drawer = drawerOf(page, T_COST);
  const notes = drawer.locator("ul.wd-markers").first(); // the comparison's notes come before "What the markers mean here"
  await expect(notes.locator("li").first()).toBeVisible();
  await expect(notes.locator("li")).toHaveText([
    "29 and 30 March have no matching day in February.", CLOSED_NOTE,
    "Cost: No percentage: some of the cost has no rate.", "Cost: A rate changed on 5 Mar, so the cost change is not only usage.",
  ]);
  await expect(drawer.locator("table.wd-table tbody tr").first().locator("td").nth(3), "the cost column of this month carries the *").toHaveText("168.60*");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. The daily chart

const chartOf = (page: Page) => frameOf(page, T_CHART).locator(".widget-chart");
const CHART_LABEL = `Line chart comparing October with September, day by day for ${RACKS[0]}. Energy in kWh. Open Details for the figures.`;

/** The text of the chart's tooltip as it is now (the canvas has no text of its own). */
const tooltipText = (chart: Locator) => chart.evaluate((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());

/** Puts the pointer on the middle of day `day` (1 based) of a chart of `days` slots; the grid has 60 px at its left and 20 at its right. */
async function pointAtDay(page: Page, chart: Locator, day: number, days: number): Promise<void> {
  const box = await boxOf(chart, "the chart");
  await page.mouse.move(box.x + 60 + ((box.width - 80) * (day - 0.5)) / days, box.y + box.height / 2, { steps: 4 });
}

async function expectDailyChart(page: Page, where: string): Promise<void> {
  const chart = chartOf(page);
  await expect(chart).toHaveAttribute("role", "img");
  await expect(chart, `${where}: the text alternative names both months`).toHaveAttribute("aria-label", CHART_LABEL);
  await expect(chart.locator("canvas").first()).toBeVisible();
  // Day 17 of both months in one slot: the tooltip names BOTH dates, each with its figure.
  await pointAtDay(page, chart, 17, 17);
  await expect.poll(() => tooltipText(chart), { message: `${where}: the 17th of both months` }).toMatch(/17 Oct.*77\.00 kWh.*17 Sep.*72\.00 kWh/);
  // Day 5: no readings in October (no row, a gap), September has its row.
  await pointAtDay(page, chart, 5, 17);
  await expect.poll(() => tooltipText(chart), { message: `${where}: the 5th has only September` }).toMatch(/5 Sep.*60\.00 kWh/);
  expect(await tooltipText(chart), `${where}: October has no row on a day with no readings`).not.toMatch(/(^|\D)5 Oct/);
  // Day 9: no readings in September; October has its row.
  await pointAtDay(page, chart, 9, 17);
  await expect.poll(() => tooltipText(chart), { message: `${where}: the 9th has only October` }).toMatch(/9 Oct.*69\.00 kWh/);
  expect(await tooltipText(chart)).not.toMatch(/(^|\D)9 Sep/);
  // Day 12: September is an estimate: its figure carries ~ and the word.
  await pointAtDay(page, chart, 12, 17);
  await expect.poll(() => tooltipText(chart), { message: `${where}: the 12th of September is estimated` }).toMatch(/12 Oct.*72\.00 kWh.*12 Sep.*~67\.00 kWh.*estimated/);
}

test("3. light: the daily chart is read through its text alternative and its tooltip, which names both dates and leaves a day with no readings out", async ({ page }) => {
  test.setTimeout(120_000);
  const stub = await prepare(page);
  await openCards(page);
  await expectDailyChart(page, "light");
  const asked = stub.requests.filter((r) => r.type === "timeseries");
  expect(asked.length).toBeGreaterThan(0);
  expect(asked[0].config.compare).toBe(COMPARE);
});

test("3. dark: the same chart in the dark look", async ({ page }) => {
  test.setTimeout(120_000);
  await prepare(page, DARK);
  await openCards(page);
  await expectDailyChart(page, "dark");
});

test("3. Details of the chart lists the windows by date and the change of both measures", async ({ page }) => {
  test.setTimeout(120_000);
  await prepare(page);
  await openCards(page);
  await detailsButton(frameOf(page, T_CHART), T_CHART).click();
  const drawer = drawerOf(page, T_CHART);
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { level: 3, name: "Comparison", exact: true })).toBeVisible();
  const rows = drawer.locator("table.wd-table").filter({ has: page.locator("caption", { hasText: RACKS[0] }) }).locator("tbody tr");
  await expect(rows.nth(0).locator("td")).toHaveText(["This month so far", "2026-10-01 to 2026-10-17", "1,124.00", "168.60"]);
  await expect(rows.nth(1).locator("td")).toHaveText(["Same days last month", "2026-09-01 to 2026-09-17", "1,000.00", "150.00"]);
  await page.keyboard.press("Escape");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. The breakdown by kind

const MORE_LINE = "and 107 more Racks: 1,234.50 kWh in all";

test("4. a breakdown by Rack: the line under the chart, Split by with its kinds, a choice sends that kind, keeps the focus and saves nothing", async ({ page }) => {
  test.setTimeout(150_000);
  const stub = await prepare(page); // no write is allowed: a PUT of the dashboard would be refused and fail the case
  const before = await json<ApiDashboard>(page.request, `/api/dashboards/${cardsId}`);
  await openCards(page);
  const card = frameOf(page, T_BARS);
  const b = barsOf(card);
  await expect(b.chart, "the text alternative says how many of how many").toHaveAttribute("aria-label", `Bar chart of 10 of 117 Racks under ${HALL}. Energy in kWh. Open Details for the figures.`);
  await expect(b.note).toHaveText(MORE_LINE);
  await expect(b.note, "the whole line is its tooltip").toHaveAttribute("title", MORE_LINE);
  await expect(b.split, "Split by is a named select").toHaveAccessibleName("Split by");
  await expect(b.split).toBeEnabled();
  await expect(b.split).toHaveValue("Rack");
  await expect(b.split.locator("option")).toHaveText(["Rack (117)", "Panel (8)", "Row (4)"]);
  const first = stub.requests.filter((r) => r.config.bars === "kind")[0];
  expect(first.config.kind, "the card asked for the stored kind").toBe("Rack");
  expect(first.config.root, "under the stored root").toBe(ids.hall);

  // The same select, another kind: the card keeps its three parts and the focus, a request carries the kind, and the dashboard is not saved.
  const reserved = { note: await boxOf(b.note, "the line"), split: await boxOf(b.row, "the select's row") };
  await b.split.focus();
  await b.split.selectOption("Panel");
  await expect.poll(() => stub.requests.some((r) => r.config.bars === "kind" && r.config.kind === "Panel"), { message: "a request asks for Panel" }).toBe(true);
  const sent = stub.requests.filter((r) => r.config.bars === "kind" && r.config.kind === "Panel").at(-1)!;
  expect(sent.config.root, "under the same root").toBe(ids.hall);
  expect(sent.config.top ?? 10, "with the same number of bars").toBe(10);
  await expect(b.empty, "every Panel is without a figure: a sentence takes the chart's place").toHaveText(`None of the 8 Panels under ${HALL} has energy readings.`);
  await expect(b.split).toBeFocused();
  await expect(b.split, "the select shows the visit's choice").toHaveValue("Panel");
  expectSame(await boxOf(b.note, "the line"), reserved.note, "the line under the chart");
  expectSame(await boxOf(b.row, "the select's row"), reserved.split, "the select's row");
  await expect(b.note).toHaveText("");

  // Details and the CSV follow the choice too.
  await detailsButton(card, T_BARS).click();
  const drawer = drawerOf(page, T_BARS);
  await expect(drawer.locator("dl.wd-kv > div").filter({ has: page.locator("dt", { hasText: /^Kind$/ }) }).locator("dd")).toHaveText("Panel");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await card.getByRole("button", { name: `Download CSV for ${T_BARS}`, exact: true }).click();
  await expect.poll(() => stub.csv.length, { message: "the CSV request went out" }).toBeGreaterThan(0);
  expect(stub.csv[0].config.kind, "and asked for the visit's kind").toBe("Panel");

  // Back to Rack: the bars and the line come back; nothing was saved (a write would have been refused above).
  await b.split.focus(); // selectOption does not move the focus, and the CSV button had it
  await b.split.selectOption("Rack");
  await expect(b.note).toHaveText(MORE_LINE);
  await expect(b.split).toBeFocused();
  expect(await json<ApiDashboard>(page.request, `/api/dashboards/${cardsId}`), "the saved dashboard is exactly as it was").toEqual(before);

  // The choice lasts for the visit only: a new visit starts from the stored kind again, and the address never held it.
  await b.split.selectOption("Panel");
  await expect(b.empty).toBeVisible();
  await openCards(page);
  await expect(b.split).toHaveValue("Rack");
  expect(page.url(), "the address does not carry the kind").not.toMatch(/Panel|kind/);
});

test("4. the marks travel: ~ on the sum of the rest, how many of them had no figure, and how many Racks are inside other Racks; one line, nothing moves", async ({ page }) => {
  test.setTimeout(120_000);
  const stub = await prepare(page);
  await openCards(page);
  const card = frameOf(page, T_BARS);
  const b = barsOf(card);
  const plain = { note: await boxOf(b.note, "the line"), row: await boxOf(b.row, "the select's row"), chart: await boxOf(b.chart, "the chart") };

  // The longest line with no estimate in it: three of the rest have no figure and three Racks are inside others. The line is one line, and every part stands where it stood.
  stub.breakdown = () => ({
    block: breakdownBlock({ more: { count: 107, with_value: 104, value: 1234.5, estimated: false, partial: false }, inside_others: 3 }), noData: false,
  });
  await openCards(page);
  const long = "and 107 more Racks: 1,234.50 kWh in all (3 with no data) 3 Racks are inside other Racks and are counted there.";
  await expect(b.note).toHaveText(long);
  await expect(b.note).toHaveAttribute("title", long);
  await expect(b.note, "one line, not two").toHaveCSS("white-space", "nowrap");
  expectSame(await boxOf(b.note, "the line"), plain.note, "the line with its full text");
  expectSame(await boxOf(b.row, "the select's row"), plain.row, "the select's row");
  expectSame(await boxOf(b.chart, "the chart"), plain.chart, "the chart");

  // An estimated sum keeps its ~, and the footer says what it means. The footer line takes room from the body, so the parts move together: their sizes and their distances do not change.
  stub.breakdown = () => ({
    block: breakdownBlock({ more: { count: 107, with_value: 107, value: 1234.5, estimated: true, partial: false } }), noData: false,
  });
  await openCards(page);
  await expect(b.note).toHaveText("and 107 more Racks: ~1,234.50 kWh in all");
  await expect(card.locator(".widget-hint"), "the footer explains the ~").toHaveText("~ estimated");
  const marked = { note: await boxOf(b.note, "the line"), row: await boxOf(b.row, "the select's row") };
  expect(marked.note.height, "the line keeps its height").toBeCloseTo(plain.note.height, 0);
  expect(marked.row.height, "the select's row keeps its height").toBeCloseTo(plain.row.height, 0);
  expect(marked.row.y - marked.note.y, "and the distance between them").toBeCloseTo(plain.row.y - plain.note.y, 0);

  // One Rack inside another: a single sentence of its own.
  stub.breakdown = () => ({ block: breakdownBlock({ inside_others: 1 }), noData: false });
  await openCards(page);
  await expect(b.note).toHaveText(`${MORE_LINE} 1 Rack is inside another Rack and is counted there.`);
});

test("4. no Racks at all, and one Rack without a figure: a sentence in the chart's place, the select still lists the kind", async ({ page }) => {
  test.setTimeout(120_000);
  const stub = await prepare(page);
  const none = { more: { count: 0, with_value: 0, value: null, estimated: false, partial: false } };
  stub.breakdown = () => ({ block: breakdownBlock({ count: 0, shown: 0, ...none, kinds: [{ kind: "Panel", count: 8 }] }), noData: false });
  await openCards(page);
  const b = barsOf(frameOf(page, T_BARS));
  await expect(b.empty, "under a hall that holds other kinds, the sentence says where to choose one (w25)").toHaveText(`No Racks under ${HALL}. Choose another kind in Split by.`);
  await expect(b.chart).toHaveCount(0);
  await expect(b.split.locator("option"), "the kind being shown is listed even with none under the root").toHaveText(["Rack (0)", "Panel (8)"]);
  await expect(b.split).toHaveValue("Rack");
  await expect(b.note).toHaveText("");

  stub.breakdown = () => ({ block: breakdownBlock({ count: 1, shown: 1, ...none, no_data: 1, kinds: [{ kind: "Rack", count: 1 }] }), noData: true });
  await openCards(page);
  await expect(b.empty).toHaveText(`The Rack under ${HALL} has no energy readings.`);
  await expect(b.split.locator("option")).toHaveText(["Rack (1)"]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. The editor

const addButton = (page: Page) => button(page, "Add widget");
const addDialog = (page: Page) => page.getByRole("dialog", { name: "Add widget", exact: true });
const fieldOf = (dialog: Locator, label: string) => dialog.getByLabel(label, { exact: true });
const saveWidget = (dialog: Locator) => dialog.getByRole("button", { name: "Save widget", exact: true });
const compareBox = (dialog: Locator) => dialog.getByRole("checkbox", { name: COMPARE_LABEL, exact: true });
const pickerOf = (dialog: Locator, name: string) => dialog.getByRole("group", { name, exact: true });
const chipsOf = (picker: Locator) => picker.locator('ul[aria-label="Picked assets"] > li');
const issuesOf = (dialog: Locator) => dialog.locator("ul.issues > li");

/** Opens the dashboard in edit mode and waits until Add widget can be used (it waits for the asset list). */
async function openEditor(page: Page, id = editId, name = D_EDIT): Promise<void> {
  await page.goto(`/dashboards/${id}`);
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
  await button(page, "Edit").click();
  await expect(button(page, "Save")).toBeVisible();
  await expect(addButton(page)).toBeEnabled();
  await settled(page);
}

/** The Add widget dialog on the type and source given. */
async function openAddDialog(page: Page, type: "stat" | "timeseries" | "bar", source: "energy" | "cost" | "metric"): Promise<Locator> {
  await addButton(page).click();
  const dialog = addDialog(page);
  await expect(dialog).toBeVisible();
  await fieldOf(dialog, "Type").selectOption({ value: type });
  await fieldOf(dialog, "Source").selectOption({ value: source });
  await settled(page);
  return dialog;
}

/** Finds an asset by typing its name in the picker named `group` and picks it (a radio in a single picker, a checkbox in the other). */
async function pickAsset(dialog: Locator, group: string, name: string): Promise<void> {
  const picker = pickerOf(dialog, group);
  await picker.getByLabel("Search assets", { exact: true }).fill(name);
  await picker.getByRole(group === "Assets" ? "checkbox" : "radio", { name, exact: true }).check();
}

/**
 * The comparison box sits BESIDE its words: its right edge is at or left of where the label's text starts (whole-wave review I-1: a global rule once pulled the
 * words under the box, which a measurement of the label as one box cannot see), a few px apart; and, on one line, the "?" tip follows the words (it does not
 * sit at the column's edge). The text is measured with a Range over the label's own text node.
 */
async function expectBoxBesideWords(dialog: Locator, where: string): Promise<void> {
  const label = dialog.locator(".compare-field > label.inline");
  await expect(label, `${where}: the comparison box's label`).toHaveCount(1);
  const m = await label.evaluate((el) => {
    const box = el.querySelector('input[type="checkbox"]')!.getBoundingClientRect();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !(node.textContent ?? "").trim()) node = walker.nextNode();
    const range = document.createRange();
    range.selectNodeContents(node!);
    const text = range.getBoundingClientRect();
    const tip = el.parentElement!.querySelector("button")!.getBoundingClientRect();
    return { boxRight: box.right, textLeft: text.left, textRight: text.right, lines: range.getClientRects().length, tipLeft: tip.left };
  });
  expect(m.boxRight, `${where}: the box's right edge (${m.boxRight}) is at or left of its words (${m.textLeft})`).toBeLessThanOrEqual(m.textLeft);
  expect(m.textLeft - m.boxRight, `${where}: the gap between the box and its words`).toBeLessThanOrEqual(16);
  if (m.lines === 1) {
    expect(m.tipLeft, `${where}: the tip is after the words`).toBeGreaterThanOrEqual(m.textRight);
    expect(m.tipLeft - m.textRight, `${where}: the tip follows the words, not the column's edge`).toBeLessThanOrEqual(12);
  }
}

test("5. ticking the comparison on a time series locks Widget range on This month, turns the picker from checkboxes to radios, and unticking gives the range back", async ({ page }) => {
  test.setTimeout(150_000);
  const stub = await prepare(page);
  await openEditor(page);
  const dialog = await openAddDialog(page, "timeseries", "energy");
  const range = fieldOf(dialog, "Widget range");
  const box = compareBox(dialog);
  const note = dialog.locator("p.field-help");
  await expect(box, "a time series of energy offers the comparison").toBeVisible();
  await expect(box).not.toBeChecked();
  await expectBoxBesideWords(dialog, "the editor");
  await expect(note, "the sentence's room is kept, hidden until the box is ticked").toBeHidden();
  await expect(pickerOf(dialog, "Assets"), "several assets are allowed before the box is ticked").toBeVisible();
  await range.selectOption("24h");
  await pickAsset(dialog, "Assets", RACKS[0]);
  await pickAsset(dialog, "Assets", RACKS[1]);
  await expect(chipsOf(pickerOf(dialog, "Assets"))).toHaveCount(2);

  await box.check();
  await expect(range, "the range is locked").toBeDisabled();
  await expect(range).toHaveValue("this_month");
  await expect(note).toBeVisible();
  await expect(note).toHaveText(COMPARE_NOTE);
  await expect(range, "and the lock is explained to assistive technology").toHaveAccessibleDescription(COMPARE_NOTE);
  await expect(pickerOf(dialog, "Assets"), "the picker is single now").toHaveCount(0);
  const single = pickerOf(dialog, "Asset");
  await expect(single).toBeVisible();
  await expect(single.getByRole("checkbox"), "no checkbox: radios").toHaveCount(0);
  await expect(chipsOf(single), "the first asset is kept").toHaveCount(1);
  await expect(chipsOf(single).first()).toContainText(RACKS[0]);
  // The preview asks for exactly the comparison of that one asset (once the form is complete: it needs a title).
  await fieldOf(dialog, "Title").fill("W24 compare");
  await expect.poll(
    () => stub.requests.some((r) => r.type === "timeseries" && r.config.compare === COMPARE && r.config.range === "this_month" && r.config.assets.length === 1 && r.config.assets[0] === ids.racks[0]),
    { message: "the preview asks for the comparison of one asset over this month" },
  ).toBe(true);

  await box.uncheck();
  await expect(range).toBeEnabled();
  await expect(range, "the range the form had before the tick comes back").toHaveValue("24h");
  await expect(note).toBeHidden();

  // The box follows the type and the source: it stays for cost, goes for a metric and is unticked when the source comes back.
  await box.check();
  await fieldOf(dialog, "Source").selectOption("cost");
  await expect(box).toBeChecked();
  await expect(range).toBeDisabled();
  await fieldOf(dialog, "Source").selectOption("metric");
  await expect(compareBox(dialog), "a metric cannot be compared").toHaveCount(0);
  await expect(range).toBeEnabled();
  await fieldOf(dialog, "Source").selectOption("energy");
  await expect(compareBox(dialog)).not.toBeChecked();
  await fieldOf(dialog, "Type").selectOption("bar");
  await expect(compareBox(dialog), "a bar chart has no comparison").toHaveCount(0);
});

test("5. Bars gains One bar per asset of a kind, which asks Look under, One bar for each and Bars to show, and offers Whole site", async ({ page }) => {
  test.setTimeout(150_000);
  const stub = await prepare(page);
  await openEditor(page);
  const dialog = await openAddDialog(page, "bar", "energy");
  const bars = fieldOf(dialog, "Bars");
  await expect(bars.locator("option")).toHaveText(["One bar per asset", "One bar per time bucket", "One bar per asset of a kind"]);
  await expect(pickerOf(dialog, "Assets")).toBeVisible();
  await expect(dialog.getByLabel("Search assets", { exact: true }), "one picker").toHaveCount(1);

  await bars.selectOption("kind");
  await expect(pickerOf(dialog, "Assets"), "the Assets picker is replaced").toHaveCount(0);
  await expect(pickerOf(dialog, "Look under")).toBeVisible();
  await expect(dialog.getByLabel("Search assets", { exact: true }), "still one picker, one search box").toHaveCount(1);
  await expect(dialog.getByLabel("Filter by kind", { exact: true })).toHaveCount(1);
  await expect(fieldOf(dialog, "One bar for each")).toBeVisible();
  await expect(fieldOf(dialog, "Bars to show")).toHaveValue("10");
  await expect(dialog.getByText("Under: Whole site", { exact: true }), "the whole site is the default").toBeVisible();
  const whole = dialog.getByRole("button", { name: "Whole site", exact: true });
  await expect(whole).toHaveAttribute("aria-disabled", "true");
  expect(await whole.evaluate((el) => (el as HTMLButtonElement).disabled), "the button is aria-disabled, never disabled: a disabled button that has the focus drops it").toBe(false);
  expect(await whole.evaluate((el) => getComputedStyle(el).opacity), "and it looks disabled while the whole site is chosen").not.toBe("1");
  await expect(saveWidget(dialog)).toBeDisabled();
  await fieldOf(dialog, "Title").fill("W24 bars");
  await expect(issuesOf(dialog)).toHaveText(["Enter the kind of asset to draw one bar for."]);

  await fieldOf(dialog, "One bar for each").fill("Rack");
  await expect(issuesOf(dialog)).toHaveCount(0);
  await expect(saveWidget(dialog)).toBeEnabled();
  for (const wrong of ["2", "51", "4.5", ""]) {
    await fieldOf(dialog, "Bars to show").fill(wrong);
    await expect(issuesOf(dialog), `${wrong || "nothing"} is not a number of bars`).toHaveText(["Bars to show must be a whole number from 3 to 50."]);
    await expect(saveWidget(dialog)).toBeDisabled();
  }
  await fieldOf(dialog, "Bars to show").fill("5");
  await expect(saveWidget(dialog)).toBeEnabled();

  await pickAsset(dialog, "Look under", HALL);
  await expect(dialog.getByText(`Under: ${HALL}`, { exact: true })).toBeVisible();
  await expect(whole).not.toHaveAttribute("aria-disabled", "true");
  expect(await whole.evaluate((el) => getComputedStyle(el).opacity), "a live Whole site is drawn in full").toBe("1");
  // The preview asks for the breakdown, with no assets, the kind, the root and the number of bars; and its Split by is shown but cannot be used.
  await expect.poll(
    () => stub.requests.some((r) => r.config.bars === "kind" && r.config.kind === "Rack" && r.config.root === ids.hall && r.config.top === 5 && r.config.assets.length === 0 && r.config.compare === undefined),
    { message: "the preview asks for the breakdown" },
  ).toBe(true);
  const preview = dialog.locator(".widget-preview");
  await expect(preview.getByLabel("Split by", { exact: true })).toBeDisabled();
  await whole.click();
  await expect(dialog.getByText("Under: Whole site", { exact: true })).toBeVisible();
  await expect(whole).toHaveAttribute("aria-disabled", "true");
  expect(await whole.evaluate((el) => getComputedStyle(el).opacity), "a Whole site that does nothing looks disabled").not.toBe("1");

  // Back to one bar per asset: the Assets picker returns and the kind fields go.
  await bars.selectOption("asset");
  await expect(pickerOf(dialog, "Assets")).toBeVisible();
  await expect(fieldOf(dialog, "One bar for each")).toHaveCount(0);
  await expect(fieldOf(dialog, "Bars to show")).toHaveCount(0);
});

interface Added { title: string; type: "stat" | "bar"; source: "energy" | "cost"; assets?: string[]; compare?: boolean; kind?: string; under?: string; top?: string }

/** Adds a widget through the dialog and saves it into the page's draft. */
async function addWidget(page: Page, spec: Added): Promise<void> {
  const dialog = await openAddDialog(page, spec.type, spec.source);
  await fieldOf(dialog, "Title").fill(spec.title);
  if (spec.compare) await compareBox(dialog).check();
  if (spec.kind !== undefined) {
    await fieldOf(dialog, "Bars").selectOption("kind");
    await fieldOf(dialog, "One bar for each").fill(spec.kind);
    if (spec.under) await pickAsset(dialog, "Look under", spec.under);
    if (spec.top) await fieldOf(dialog, "Bars to show").fill(spec.top);
  } else {
    for (const name of spec.assets ?? []) await pickAsset(dialog, spec.type === "bar" ? "Assets" : "Asset", name);
  }
  await expect(saveWidget(dialog)).toBeEnabled();
  await saveWidget(dialog).click();
  await expect(dialog).toBeHidden();
}

test("5. the saved configs hold compare, kind, root and top only when they are not the default, and a comparing stat starts 3 x 3", async ({ page }) => {
  test.setTimeout(240_000);
  await prepare(page, LIGHT, [new RegExp(`^PUT /api/dashboards/${editId}$`)]);
  await openEditor(page);
  await addWidget(page, { title: "W24 s1", type: "stat", source: "energy", assets: [RACKS[0]], compare: true });
  await addWidget(page, { title: "W24 b1", type: "bar", source: "energy", kind: "Rack", under: HALL });
  await addWidget(page, { title: "W24 b2", type: "bar", source: "cost", kind: "Rack", top: "5" });
  await addWidget(page, { title: "W24 s2", type: "stat", source: "energy", assets: [RACKS[1]] });
  await button(page, "Save").click();
  await expect(button(page, "Edit"), "the dashboard is saved and back in view mode").toBeVisible();

  const saved = await json<ApiDashboard>(page.request, `/api/dashboards/${editId}`);
  const byTitle = (title: string) => {
    const found = saved.widgets.find((w) => w.title === title);
    expect(found, `the saved dashboard has ${title}`).toBeTruthy();
    return found!;
  };
  const keysOf = (w: ApiWidget) => Object.keys(w.config).sort();
  const s1 = byTitle("W24 s1");
  expect(keysOf(s1), "a comparing stat adds compare and nothing else").toEqual([...OLD_KEYS, "compare"].sort());
  expect(s1.config.compare).toBe(COMPARE);
  expect(s1.config.range, "its range is locked on this month").toBe("this_month");
  expect(s1.config.assets).toEqual([ids.racks[0]]);
  expect({ w: s1.w, h: s1.h }, "a new comparing stat starts 3 x 3").toEqual({ w: 3, h: 3 });
  const b1 = byTitle("W24 b1");
  expect(keysOf(b1), "a breakdown with the default number of bars adds kind and root").toEqual([...OLD_KEYS, "kind", "root"].sort());
  expect(b1.config).toMatchObject({ bars: "kind", kind: "Rack", root: ids.hall, assets: [] });
  const b2 = byTitle("W24 b2");
  expect(keysOf(b2), "a breakdown of the whole site with 5 bars adds kind and top").toEqual([...OLD_KEYS, "kind", "top"].sort());
  expect(b2.config).toMatchObject({ bars: "kind", kind: "Rack", top: 5, source: "cost", assets: [] });
  const s2 = byTitle("W24 s2");
  expect(keysOf(s2), "a plain stat has exactly the keys it always had").toEqual(OLD_KEYS);
  expect({ w: s2.w, h: s2.h }, "and keeps its size").toEqual({ w: 3, h: 2 });
});

test("5. by keyboard: Tab runs through the comparison box and its tip, Space ticks it, Whole site keeps the focus, and Escape closes one layer at a time", async ({ page }) => {
  test.setTimeout(150_000);
  await prepare(page);
  await openEditor(page);
  await addButton(page).focus();
  await page.keyboard.press("Enter");
  const dialog = addDialog(page);
  await expect(dialog).toBeVisible();
  await fieldOf(dialog, "Type").selectOption("stat");
  await fieldOf(dialog, "Source").selectOption("energy");
  await settled(page);

  // Tab from Title through the fields to the comparison box, its tip, the tip of the Show group (w27), the scope radios (one stop: the checked one) and the picker.
  await fieldOf(dialog, "Title").focus();
  const seen: string[] = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    seen.push(await focusedName(page));
  }
  expect(seen, "the Tab order").toEqual(["Source", "Aggregation", "Widget range", COMPARE_LABEL, "What does this mean?", "What does this mean?", "Assets chosen here", "Search assets"]);

  // Space on the box ticks it; the focus stays on the box; unticking by Space restores the range.
  await compareBox(dialog).focus();
  await page.keyboard.press("Space");
  await expect(compareBox(dialog)).toBeChecked();
  await expect(compareBox(dialog)).toBeFocused();
  await expect(fieldOf(dialog, "Widget range")).toBeDisabled();
  await page.keyboard.press("Space");
  await expect(compareBox(dialog)).not.toBeChecked();
  await expect(compareBox(dialog)).toBeFocused();
  await expect(fieldOf(dialog, "Widget range")).toBeEnabled();

  // Bars by a kind: Look under comes right after the field, and Whole site never lets the focus fall to the page.
  await fieldOf(dialog, "Type").selectOption("bar");
  await fieldOf(dialog, "Bars").selectOption("kind");
  await fieldOf(dialog, "Bars").focus();
  await page.keyboard.press("Tab");
  expect(await focusedName(page), "Tab from Bars goes to the picker's search box").toBe("Search assets");
  await page.keyboard.press("Tab");
  expect(await focusedName(page)).toBe("Filter by kind");
  await pickerOf(dialog, "Look under").getByLabel("Search assets", { exact: true }).fill(HALL);
  const radio = pickerOf(dialog, "Look under").getByRole("radio", { name: HALL, exact: true });
  await radio.focus();
  await page.keyboard.press("Space");
  await expect(radio).toBeChecked();
  await expect(dialog.getByText(`Under: ${HALL}`, { exact: true })).toBeVisible();
  const whole = dialog.getByRole("button", { name: "Whole site", exact: true });
  await whole.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByText("Under: Whole site", { exact: true })).toBeVisible();
  await expect(whole).toBeFocused();
  expect(await focusedName(page), "the focus did not fall to the page").not.toBe("<body>");
  await page.keyboard.press("Enter");
  await expect(whole, "Enter again changes nothing and the focus stays").toBeFocused();

  // Escape closes the innermost layer: the tip first, then the dialog (the page stays in edit mode).
  const tip = fieldOf(dialog, "One bar for each").locator("..").getByRole("button", { name: "What does this mean?", exact: true });
  await tip.focus();
  await page.keyboard.press("Enter");
  const bubble = page.getByRole("note");
  await expect(bubble).toContainText(KIND_TIP);
  await page.keyboard.press("Escape");
  await expect(bubble, "the first Escape closes the tip").toBeHidden();
  await expect(dialog, "and only the tip").toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog, "the second closes the dialog").toBeHidden();
  await expect(button(page, "Save"), "the page is still in edit mode").toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(await focusedName(page), "the focus is back on the page's own control").not.toBe("<body>");
});

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
// 6. Placement

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 640 },
  { width: 800, height: 600 },
] as const;

/** Three notes at once on a comparing card and the longest line under a breakdown: the fullest the cards get. */
function fullStub(stub: Stub): void {
  stub.compare = () => {
    const c = marchBlock();
    c.last_month.closed = true;
    c.assets[0].this = side(1124, 168.6, { partial: true, estimated: true });
    c.assets[0].cost = change(18.6, null, "partial");
    c.assets[0].rate_change = { date: "2026-03-05" };
    return c;
  };
  stub.breakdown = () => ({ block: breakdownBlock({ more: { count: 107, with_value: 104, value: 1234.5, estimated: true, partial: false }, inside_others: 3 }), noData: false });
}

for (const size of SIZES) {
  test(`6. ${size.width} x ${size.height}: the cards' new rows do not overlap or scroll, and the editor's new fields stay apart with Save widget in the window, light and dark`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(size);
    const stub = await prepare(page);
    fullStub(stub);
    for (const look of [LIGHT, DARK]) {
      const where = `${size.width} x ${size.height} ${look.mode}`;
      await setLook(page, look);
      await openCards(page);
      await expectNoSidewaysScroll(page, where);
      for (const title of [T_KWH, T_COST]) {
        const card = frameOf(page, title);
        const s = statOf(card);
        const body = await boxOf(card.locator(".widget-body"), `${where}: ${title} body`);
        await expectApart([
          ["the headline", s.big], ["the name", s.name], ["this month's window", s.windows.nth(0)], ["last month's row", card.locator(".stat-last")],
          ["last month's window", s.windows.nth(1)], ["the change line", s.change], ["the note line", s.note],
        ], `${where}: ${title}`, body);
        await expectNoScroll(card, `${where}: ${title}`);
        expect(inside(await boxOf(card, `${where}: ${title}`), { x: 0, y: 0, width: size.width, height: 100_000 })).toBe(true);
      }
      const bars = frameOf(page, T_BARS);
      const b = barsOf(bars);
      await expectApart([["the chart", b.chart], ["the line under it", b.note], ["Split by", b.row]], `${where}: the breakdown`, await boxOf(bars.locator(".widget-body"), `${where}: breakdown body`));
      await expectNoScroll(bars, `${where}: the breakdown`);
      await expect(chartOf(page).locator("canvas").first(), `${where}: the daily chart is drawn`).toBeVisible();

      // The editor: the comparison fields of a stat, then the kind fields of a bar chart.
      await openEditor(page);
      const dialog = await openAddDialog(page, "stat", "energy");
      await compareBox(dialog).check();
      await expectBoxBesideWords(dialog, `${where}: the stat dialog`);
      await expectApart([
        ["Widget range", fieldOf(dialog, "Widget range")], ["its sentence", dialog.locator("p.field-help")], ["the comparison box and its words", dialog.locator("label.inline"), true],
        ["its tip", dialog.locator(".compare-field").getByRole("button", { name: "What does this mean?", exact: true })], ["the picker", pickerOf(dialog, "Asset")],
      ], `${where}: the stat dialog`);
      await expectDialogFits(dialog, where);
      await fieldOf(dialog, "Type").selectOption("bar");
      await fieldOf(dialog, "Bars").selectOption("kind");
      await expectApart([
        ["Look under", pickerOf(dialog, "Look under")], ["Whole site", dialog.getByRole("button", { name: "Whole site", exact: true })],
        ["One bar for each", fieldOf(dialog, "One bar for each")], ["Bars to show", fieldOf(dialog, "Bars to show")],
        ["Preview", dialog.getByRole("heading", { name: "Preview", exact: true })],
      ], `${where}: the bar dialog`);
      await expectDialogFits(dialog, where);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toBeHidden();
      await button(page, "Cancel").click();
    }
  });
}

/** Save widget is on the screen and what a click at its centre reaches; the dialog does not scroll sideways. */
async function expectDialogFits(dialog: Locator, where: string): Promise<void> {
  const save = saveWidget(dialog);
  await save.scrollIntoViewIfNeeded();
  const reading = await save.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { onScreen: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth, reached: hit === el || el.contains(hit) };
  });
  expect(reading.onScreen, `${where}: Save widget is inside the window`).toBe(true);
  expect(reading.reached, `${where}: nothing covers Save widget`).toBe(true);
  const over = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(over, `${where}: the dialog has no horizontal scroll`).toBeLessThanOrEqual(1);
}

test("6. while the answer is held, the skeleton of a comparing stat and of a breakdown draws the rows of the loaded card", async ({ page }) => {
  test.setTimeout(120_000);
  const stub = await prepare(page);
  const release = hold(stub);
  await page.goto(`/dashboards/${cardsId}`);
  await expect(page.getByRole("heading", { level: 1, name: D_CARDS, exact: true })).toBeVisible();
  const stat = page.getByRole("status").filter({ hasText: `Loading ${T_KWH}` });
  const bars = page.getByRole("status").filter({ hasText: `Loading ${T_BARS}` });
  await expect(stat).toBeVisible();
  await expect(bars).toBeVisible();
  const skeletonRows = { stat: await stat.locator(":scope > :not(.sr-only)").count(), bars: await bars.locator(":scope > :not(.sr-only)").count() };
  release();
  await expect(page.locator(".sk-region, .widget-sk")).toHaveCount(0);
  await settled(page);
  expect(skeletonRows.stat, "the stat's skeleton draws as many rows as the loaded card").toBe(await frameOf(page, T_KWH).locator(".stat-compare > *").count());
  expect(skeletonRows.bars, "so does the breakdown's").toBe(await frameOf(page, T_BARS).locator(".widget-bars > *").count());
});

// ---------------------------------------------------------------------------------------------------------------------------------
// R. The real endpoint on the scratch stack

const SEED_ROOT = "Seeded pilot hall";
const SEED_SOURCE = "seeded-pilot-hall";
const TOP = 5;
const R_KWH = "W24 real energy";
const R_COST = "W24 real cost";
const R_HALL = "W24 real racks under Hall 1";
const R_SITE = "W24 real racks under the pilot hall";

interface Entry { kwh: number; cost: number | null; estimated: boolean; partial: boolean; no_data: boolean }
interface CostsAsset { asset_id: number; name: string; path: string; rate_per_kwh: number | null; days: (Entry | null)[]; total: Entry | null }
interface Costs { month: string; timezone: string; currency: string | null; days: string[]; assets: CostsAsset[]; closed: { closed_at: string } | null }
interface ApiCompare { state: string; elapsed_days: number; days: number; this_window: Window | null; last_window: Window | null; assets: { kwh: { abs: number | null; percent: number | null }; cost: { abs: number | null; percent: number | null } }[] }
interface StorageSettings { raw_retention_days: number; compress_after_days: number; rollup_1m_retention_days: number; disk_capacity_gb: number; warn_threshold_pct: number }
interface ApiTariff { id: number; asset_id: number | null }

const real = {
  zone: "", thisMonth: "", lastMonth: "",
  rootId: 0, hallId: 0, racksHall: [] as ApiAsset[], racksAll: [] as ApiAsset[], panels: [] as ApiAsset[],
  rackId: 0, rackName: "", elapsed: 0, days: 0,
  dashboardId: 0, oldStorage: null as StorageSettings | null, siteTariffId: 0, rackTariffId: 0, rackRate: 0,
};

/** The site-local month `back` months ago (`2026-09`), from the site's time zone like the page does. */
function siteMonth(timezone: string, back = 0, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const index = year * 12 + (month - 1) - back;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/**
 * Runs the seeder inside the api container of the scratch stack, as w11.spec.ts and w21.spec.ts do, for the pilot hall. A second run finds `seeded-pilot-hall` and exits 1 with "already exists": the
 * caller removes any earlier seed first (an old one has no readings after the day it ran), so that is a failure here. Any other failure fails the suite with the seeder's own words.
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

const costsOf = (request: APIRequestContext, month: string) => json<Costs>(request, `/api/billing/costs?month=${month}`);

function descendantsOf(assets: ApiAsset[], rootId: number): ApiAsset[] {
  const out: ApiAsset[] = [];
  let level = [rootId];
  while (level.length > 0) {
    const next = assets.filter((a) => a.parent_id !== null && level.includes(a.parent_id));
    out.push(...next);
    level = next.map((a) => a.id);
  }
  return out;
}
const isKind = (a: ApiAsset, kind: string): boolean => a.kind.trim().toLowerCase() === kind.toLowerCase();

interface Sum { kwh: number; cost: number | null; estimated: boolean; noData: boolean }
/** Billing's day cells 1 to `n` added the way the comparison adds them: kWh and cost of the cells that exist; nothing at all when every cell has no readings. */
function sumDays(row: CostsAsset, n: number): Sum {
  const shown = row.days.slice(0, n).filter((e): e is Entry => e !== null);
  const costs = shown.flatMap((e) => (e.cost === null ? [] : [e.cost]));
  return {
    kwh: shown.reduce((total, e) => total + e.kwh, 0), cost: costs.length > 0 ? costs.reduce((total, c) => total + c, 0) : null,
    estimated: shown.some((e) => e.estimated), noData: shown.length === 0 || shown.every((e) => e.no_data),
  };
}
const rowOf = (costs: Costs, assetId: number): CostsAsset => {
  const row = costs.assets.find((a) => a.asset_id === assetId);
  expect(row, `Billing has a row for asset ${assetId}`).toBeTruthy();
  return row!;
};

/**
 * The first figure in the text of a card or a cell ("~1,124.00 kWh", "275.43 MWh", "33,052 kWh", "168.60* USD", "275.43k* QAR", "-562.82"), read back in the BASE unit (kWh, or the
 * currency), with `half`: half a unit of its last printed digit in that same unit. A card prints a figure in the scale it shares with its neighbour (kWh, MWh or GWh after the
 * number; a cost with k or M right behind the digits), grouped, with two decimals and none from 10,000 up; a table cell is the exact face (grouped, two decimals, no unit).
 * Null when the text holds no digit.
 */
function figureIn(text: string): { value: number; half: number } | null {
  const found = /(-?)(\d[\d,]*)(?:\.(\d+))?([kM])?\*?(?:\s*(kWh|MWh|GWh))?/.exec(text);
  if (!found) return null;
  const [, sign, whole, fraction = "", letter = "", unit = ""] = found;
  const times = (letter === "k" ? 1_000 : letter === "M" ? 1_000_000 : 1) * (unit === "MWh" ? 1_000 : unit === "GWh" ? 1_000_000 : 1);
  const value = Number(`${whole.replace(/,/g, "")}${fraction ? `.${fraction}` : ""}`) * times * (sign ? -1 : 1);
  return { value, half: (0.5 / 10 ** fraction.length) * times };
}
/** The figure shown equals the expected one to within half a unit of its last digit, in the scale the card chose (plus rounding noise in the sum). */
function expectFigure(text: string, expected: number | null, what: string): void {
  if (expected === null) {
    expect(text.trim(), `${what}: no figure is a dash`).toBe("—");
    return;
  }
  const shown = figureIn(text);
  expect(shown, `${what}: "${text}" holds no figure`).not.toBeNull();
  expect(Math.abs(shown!.value - expected), `${what}: the card says ${text}, Billing's day cells add up to ${expected}`).toBeLessThanOrEqual(shown!.half + 0.0001);
}
/** A number as the card prints it: a comma every three digits of the whole part ("1,234.6"). */
const grouped = (digits: string): string => digits.replace(/^(-?\d+)/, (whole) => whole.replace(/\B(?=(\d{3})+$)/g, ","));

async function widgetCompare(request: APIRequestContext, assetId: number, source: string): Promise<ApiCompare> {
  const response = await request.post("/api/widget-data", { data: { type: "stat", config: config({ assets: [assetId], source, range: "this_month", compare: COMPARE }), range: "this_month" } });
  expect(response.ok(), `POST /api/widget-data (compare): ${response.status()} ${await response.text()}`).toBe(true);
  return ((await response.json()) as { compare: ApiCompare }).compare;
}

const openReal = (page: Page) => openDashboard(page, real.dashboardId, D_REAL, [R_KWH, R_COST, R_HALL, R_SITE]);

test.describe("W24 case R: the real comparison and breakdown on the seeded pilot hall", () => {
  test.skip(!SCRATCH, SKIP_MESSAGE);

  test.beforeAll(async ({ browser }) => {
    if (!SCRATCH) return;
    test.setTimeout(1_500_000);
    await asAdmin(browser, async (request) => {
      real.zone = (await json<{ timezone: string }>(request, "/api/site")).timezone;
      real.thisMonth = siteMonth(real.zone, 0);
      real.lastMonth = siteMonth(real.zone, 1);
      expect((await costsOf(request, real.lastMonth)).closed, "last month is open (w11, w18 and w21 leave it so)").toBeNull();
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
      // A site-wide rate, when the stack has none.
      const tariffs = await json<ApiTariff[]>(request, "/api/tariffs");
      if (!tariffs.some((t) => t.asset_id === null)) {
        const made = await request.post("/api/tariffs", { data: { asset_id: null, rate_per_kwh: 0.15, effective_from: "2020-01-01" } });
        expect(made.status(), `a site-wide rate: ${made.status()} ${await made.text()}`).toBe(201);
        real.siteTariffId = ((await made.json()) as { id: number }).id;
      }
    });
    seedPilotHall();
    await asAdmin(browser, async (request) => {
      const assets = await json<ApiAsset[]>(request, "/api/assets");
      const root = assets.find((a) => a.parent_id === null && a.name === SEED_ROOT);
      expect(root, `the seeder made "${SEED_ROOT}"`).toBeTruthy();
      real.rootId = root!.id;
      const hall = assets.find((a) => a.parent_id === real.rootId && a.name === "Hall 1");
      expect(hall, "the seeder made Hall 1").toBeTruthy();
      real.hallId = hall!.id;
      real.racksHall = descendantsOf(assets, real.hallId).filter((a) => isKind(a, "Rack"));
      real.racksAll = descendantsOf(assets, real.rootId).filter((a) => isKind(a, "Rack"));
      real.panels = descendantsOf(assets, real.rootId).filter((a) => isKind(a, "Panel"));
      expect(real.racksHall.length, "Hall 1 has Rack 01 to 59").toBe(59);
      expect(real.racksAll.length, "the pilot hall has 117 racks").toBe(117);
      expect(real.panels.length, "and 8 panels").toBe(8);

      // N and D come from the answer, never from the browser's clock; the figures come from Billing's day cells.
      const probe = await widgetCompare(request, real.racksHall[0].id, "energy");
      real.elapsed = probe.elapsed_days;
      real.days = probe.days;
      const [now, last] = [await costsOf(request, real.thisMonth), await costsOf(request, real.lastMonth)];
      // The rack: one of Hall 1 with a reading on every one of the D days of both months, so a percentage can show.
      const full = (row: CostsAsset) => row.days.slice(0, real.days).filter((e) => e !== null && !e.no_data && e.cost !== null).length === real.days;
      const chosen = real.days === 0 ? real.racksHall[0] : real.racksHall.find((r) => full(rowOf(now, r.id)) && full(rowOf(last, r.id)));
      expect(chosen, `a rack of Hall 1 has readings on all ${real.days} days of both months`).toBeTruthy();
      real.rackId = chosen!.id;
      real.rackName = chosen!.name;
      const rack = [real.rackId];
      real.dashboardId = await createDashboard(request, D_REAL, [
        { title: R_KWH, type: "stat", x: 0, y: 0, w: 3, h: 3, config: config({ assets: rack, range: "this_month", compare: COMPARE }) },
        { title: R_COST, type: "stat", x: 3, y: 0, w: 3, h: 3, config: config({ assets: rack, source: "cost", range: "this_month", compare: COMPARE }) },
        { title: R_HALL, type: "bar", x: 0, y: 3, w: 6, h: 5, config: config({ bars: "kind", kind: "Rack", root: real.hallId, top: TOP, range: "last_month" }) },
        { title: R_SITE, type: "bar", x: 6, y: 3, w: 6, h: 5, config: config({ bars: "kind", kind: "Rack", root: real.rootId, top: TOP, range: "last_month" }) },
      ]);
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
    // Last month first: the other projects expect it open.
    await step("reopening last month", async (request) => {
      if ((await costsOf(request, real.lastMonth)).closed === null) return;
      const reopened = await request.post(`/api/billing/months/${real.lastMonth}/reopen`, { data: { note: "w24 puts the month back" } });
      expect(reopened.status(), `reopening ${real.lastMonth}: ${await reopened.text()}`).toBe(200);
    });
    await step("deleting the rack's rate", async (request) => {
      if (real.rackTariffId) await request.delete(`/api/tariffs/${real.rackTariffId}`);
    });
    await step("deleting the site-wide rate", async (request) => {
      if (real.siteTariffId) await request.delete(`/api/tariffs/${real.siteTariffId}`);
    });
    await step("deleting the dashboard", async (request) => {
      if (real.dashboardId) await request.delete(`/api/dashboards/${real.dashboardId}`);
    });
    await step("deleting the seed", removeSeed);
    await step("putting the retention back", async (request) => {
      if (!real.oldStorage || real.oldStorage.raw_retention_days >= 90) return;
      const back = await request.put("/api/settings/storage?confirm=true", { data: real.oldStorage });
      expect(back.ok(), `putting the retention back: ${back.status()} ${await back.text()}`).toBe(true);
    });
    expect(failures, "the clean-up put the stack back").toEqual([]);
  });

  test("R1. the compare stats equal the sums of Billing's day cells 1 to D, in kWh and in cost, to the digits shown (the 1st says Nothing to compare yet)", async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, LIGHT);
    const cards = { kwh: frameOf(page, R_KWH), cost: frameOf(page, R_COST) };
    await openReal(page);
    if (real.elapsed === 0) {
      for (const card of Object.values(cards)) await expect(statOf(card).nothing, "on the 1st there is nothing to compare yet").toHaveText(NOTHING_YET);
      return;
    }
    const [now, last] = [await costsOf(page.request, real.thisMonth), await costsOf(page.request, real.lastMonth)];
    expect(real.days, "D is the elapsed days or the length of last month").toBeLessThanOrEqual(real.elapsed);
    const compare = await widgetCompare(page.request, real.rackId, "energy");
    expect(compare.this_window, "this month's window runs from the 1st to day D").toEqual({ from: now.days[0], to: now.days[real.days - 1] });
    expect(compare.last_window, "and last month's too").toEqual({ from: last.days[0], to: last.days[real.days - 1] });
    const thisSum = sumDays(rowOf(now, real.rackId), real.days);
    const lastSum = sumDays(rowOf(last, real.rackId), real.days);
    expect(thisSum.noData || lastSum.noData, "the chosen rack has readings on every day").toBe(false);

    const [kwh, cost] = [statOf(cards.kwh), statOf(cards.cost)];
    expectFigure((await kwh.big.textContent()) ?? "", thisSum.kwh, "this month's kWh");
    expectFigure((await kwh.lastFig.textContent()) ?? "", lastSum.kwh, "last month's kWh");
    expectFigure((await cost.big.textContent()) ?? "", thisSum.cost, "this month's cost");
    expectFigure((await cost.lastFig.textContent()) ?? "", lastSum.cost, "last month's cost");
    await expect(kwh.name).toHaveText(real.rackName);
    // The change line says what the server's block says (amount to two decimals, percentage to one).
    for (const [s, block, expectedAbs] of [[kwh, compare.assets[0].kwh, thisSum.kwh - lastSum.kwh], [cost, compare.assets[0].cost, (thisSum.cost ?? 0) - (lastSum.cost ?? 0)]] as const) {
      expect(block.abs, "the server's amount is this minus last").not.toBeNull();
      expect(Math.abs(block.abs! - expectedAbs), "and equals the difference of Billing's sums").toBeLessThanOrEqual(0.0051);
      // The amount is printed in a scale of its own (kWh or MWh, a cost with k or M), so it is read back the way a card figure is: the part in brackets, or the one after up/down.
      const changeText = (await s.change.textContent()) ?? "";
      const amount = figureIn(/\(([^)]*)\)/.exec(changeText)?.[1] ?? changeText.replace(/^(?:up|down)\s+/, ""));
      expect(amount, `the change line "${changeText}" holds an amount`).not.toBeNull();
      expect(Math.abs(Math.abs(amount!.value) - Math.abs(block.abs!)), `the change line says ${changeText}; the server's amount is ${block.abs}`).toBeLessThanOrEqual(amount!.half + 0.0001);
      if (block.percent !== null) await expect(s.change).toContainText(`${grouped(Math.abs(block.percent).toFixed(1))} %`);
    }
    // Details shows both measures for both windows, with their dates.
    await detailsButton(cards.kwh, R_KWH).click();
    const drawer = drawerOf(page, R_KWH);
    await expect(drawer).toBeVisible();
    const rows = drawer.locator("table.wd-table").first().locator("tbody tr");
    await expect(rows.nth(0).locator("td").nth(1)).toHaveText(`${now.days[0]} to ${now.days[real.days - 1]}`);
    await expect(rows.nth(1).locator("td").nth(1)).toHaveText(`${last.days[0]} to ${last.days[real.days - 1]}`);
    expectFigure((await rows.nth(0).locator("td").nth(2).textContent()) ?? "", thisSum.kwh, "Details: this month's kWh");
    expectFigure((await rows.nth(0).locator("td").nth(3).textContent()) ?? "", thisSum.cost, "Details: this month's cost");
    expectFigure((await rows.nth(1).locator("td").nth(2).textContent()) ?? "", lastSum.kwh, "Details: last month's kWh");
    expectFigure((await rows.nth(1).locator("td").nth(3).textContent()) ?? "", lastSum.cost, "Details: last month's cost");
    await page.keyboard.press("Escape");
  });

  test("R2. a breakdown by Rack under Hall 1 says and 59 - top more; the one under the pilot hall splits by Panel and says none has readings", async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, LIGHT);
    await openReal(page);
    const last = await costsOf(page.request, real.lastMonth);
    const hall = barsOf(frameOf(page, R_HALL));
    // Expected: the racks of Hall 1 by last month's kWh in Billing, highest first; the sum of those after the top ones that have a figure.
    const ranked = real.racksHall.map((r) => ({ id: r.id, sum: sumDays(rowOf(last, r.id), last.days.length) })).filter((r) => !r.sum.noData).sort((a, b) => b.sum.kwh - a.sum.kwh);
    const rest = ranked.slice(TOP).reduce((total, r) => total + r.sum.kwh, 0);
    const left = real.racksHall.length - TOP; // 59 - top
    await expect(hall.note).toHaveText(new RegExp(`^and ${left} more Racks: ~?[\\d,]+(?:\\.\\d\\d)? (?:kWh|MWh|GWh) in all(?: \\(\\d+ with no data\\))?$`));
    expectFigure(((await hall.note.textContent()) ?? "").replace(/^.*Racks: /, ""), rest, "the sum of the Racks left out");
    await expect(hall.chart).toHaveAttribute("aria-label", `Bar chart of ${TOP} of ${real.racksHall.length} Racks under Hall 1. Energy in kWh. Open Details for the figures.`);
    await expect(hall.split.locator("option").filter({ hasText: `Rack (${real.racksHall.length})` })).toHaveCount(1);

    const site = barsOf(frameOf(page, R_SITE));
    await expect(site.note).toHaveText(new RegExp(`^and ${real.racksAll.length - TOP} more Racks: `));
    await expect(site.split.locator("option").filter({ hasText: `Panel (${real.panels.length})` }), "the panels sit under the pilot hall").toHaveCount(1);
    await site.split.focus();
    await site.split.selectOption("Panel");
    await expect(site.empty, "the panels carry no meter in this layout").toHaveText(`None of the ${real.panels.length} Panels under ${SEED_ROOT} has energy readings.`);
    await expect(site.split).toBeFocused();
    await site.split.selectOption("Rack");
    await expect(site.chart).toBeVisible();
  });

  test("R3. a closed last month is read from its closed figures: after a change of the rack's rate the last side did not move and the card says Last month is closed", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page, LIGHT);
    const request = page.request;
    if (real.elapsed === 0) {
      // On the 1st there is nothing to compare, but the closed month still must reopen cleanly (afterAll does it).
      return;
    }
    const cards = { kwh: statOf(frameOf(page, R_KWH)), cost: statOf(frameOf(page, R_COST)) };
    await openReal(page);
    const live = {
      kwh: (await cards.kwh.lastFig.textContent()) ?? "", cost: (await cards.cost.lastFig.textContent()) ?? "",
      head: (await cards.kwh.big.textContent()) ?? "", costHead: (await cards.cost.big.textContent()) ?? "",
    };
    await expect(cards.cost.note, "an open month does not say it is closed").not.toHaveAttribute("title", /closed/);

    const closed = await request.post(`/api/billing/months/${real.lastMonth}/close`, { data: { note: "w24 closes last month" } });
    expect(closed.status(), `closing ${real.lastMonth}: ${await closed.text()}`).toBe(201);
    const snapshot = await costsOf(request, real.lastMonth);
    expect(snapshot.closed, "Billing serves the closed figures").not.toBeNull();
    const frozen = sumDays(rowOf(snapshot, real.rackId), real.days);

    await openReal(page);
    await expect(cards.cost.note, "the card says the month is closed").toHaveAttribute("title", new RegExp(CLOSED_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect((await cards.kwh.lastFig.textContent()) ?? "", "closing changed no figure").toBe(live.kwh);
    expect((await cards.cost.lastFig.textContent()) ?? "").toBe(live.cost);
    expectFigure(live.kwh, frozen.kwh, "the closed kWh");
    expectFigure(live.cost, frozen.cost, "the closed cost");

    // Change the rack's rate for every day: the live months follow it, the closed one does not.
    const row = rowOf(await costsOf(request, real.thisMonth), real.rackId);
    real.rackRate = Math.round(((row.rate_per_kwh ?? 0.15) + 0.25) * 100) / 100;
    const made = await request.post("/api/tariffs", { data: { asset_id: real.rackId, rate_per_kwh: real.rackRate, effective_from: "2020-01-01" } });
    expect(made.status(), `a rate for the rack: ${made.status()} ${await made.text()}`).toBe(201);
    real.rackTariffId = ((await made.json()) as { id: number }).id;

    await openReal(page);
    expect((await cards.kwh.lastFig.textContent()) ?? "", "the kWh of last month did not move").toBe(live.kwh);
    expect((await cards.cost.lastFig.textContent()) ?? "", "the cost of last month did not move").toBe(live.cost);
    expect((await cards.kwh.big.textContent()) ?? "", "the kWh of this month did not move").toBe(live.head);
    await expect(cards.cost.note).toHaveAttribute("title", new RegExp(CLOSED_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // This month is live: its cost follows the new rate and is again the sum of Billing's day cells.
    const now = sumDays(rowOf(await costsOf(request, real.thisMonth), real.rackId), real.days);
    expectFigure((await cards.cost.big.textContent()) ?? "", now.cost, "this month's cost under the new rate");
    if (now.kwh > 0) expect((await cards.cost.big.textContent()) ?? "", "and it moved").not.toBe(live.costHead);
    // Billing still serves the same closed figures.
    const again = sumDays(rowOf(await costsOf(request, real.lastMonth), real.rackId), real.days);
    expect(again, "Billing's closed cells did not move either").toEqual(frozen);
  });
});
