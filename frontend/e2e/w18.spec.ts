import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { costsFor, type ApiCosts } from "./billingModel";

// W18 (one control-height scale, limits on the note box, plain words about removing assets): a guard that MEASURES the real pages, so a later patch that makes one control 4 px taller than the
// one beside it fails here. Admin `admin` / `correct-horse`, the account the earlier projects use.
//
// What it makes and what it writes. It never moves, edits or deletes a mapping that was there before it. beforeAll reads the stack for an asset that already has a mapped metric (not named `w18 `): the
// asset page of a real asset shows the "live" chip, so the header cases use it and NO asset and NO mapping is made (read only). Only a stack with no such asset gets `w18 <run>` and ONE mapping of a FREE
// point of any source (its custom_unit `w18-spec` marks it as the spec's own; a stack with no free point fails the run with a message). The remove cases pick two top-level rows of the Assets Tree
// (they are only picked, never deleted); a stack with fewer than two gets an unmapped `w18 <run> b`. A dashboard `w18 <run>` is made for the dashboard cases. afterAll deletes only what this run made
// (also after a failed case) and puts the look back to Light and Navy and gold; sweep() takes away what a stopped run left, and refuses (throws) to delete a `w18 ` asset that holds a mapping the spec
// did not make, so a mapping an older version of this spec moved is never deleted with it. Every Billing case
// answers GET /api/billing/costs, /api/billing/months and /api/billing/costs.csv through page.route from e2e/billingModel.ts (an open month, a month closed with a note) and the remove dialogs get
// GET /api/assets/{id}/impact from page.route; the confirming buttons (Close month, Reopen month, Delete) are never pressed, and any other write the page tries is refused with a 500 and fails the
// case (the sign-in and the look's save are the only ones allowed). The look is the admin's saved preference, set through PUT /api/me/preferences before a page opens.
//
// The checker. `measureRows` reads the page in one page.evaluate: every visible control that has an EDGE at rest (a border with a colour, a background with alpha, or an inset ring: the Live
// chip) and two of them on one line (centres within 6 px, neither inside the other, their lowest common ancestor no taller than the taller one plus 56 px, room for the labels above a form row: a bar, not a section) must be within
// 1 px of each other in height. A control without an edge (an icon button, a quiet text button, a tab, the profile button) is not compared: its hover box is drawn only when asked. The mouse is
// parked and the focus dropped first, because a hovered `.icon-btn` gains a tint. ALLOWED lists, with the reason, what is not compared; nothing else is exempt. It also returns `pairs`, how
// many pairs it compared, `pagePairs`, how many of those have neither control inside the top bar (the page's own: the top bar's Find field and Live chip are one pair on every page, so a page's
// floor counts `pagePairs` only), and `edged`, every control that counted as having an edge.
//
// Locators. Playwright matches a name by case-insensitive SUBSTRING, so every button and dialog is looked up with `exact: true` ("Close month…" is also the start of the dialog's "Close month").
//
// The cases (1440 x 900 light unless said):
//   1   the checker bites: a bordered 22 px box beside the Previous month button is reported; a borderless 22 px box is not.
//   1b  the same on the real pages: the Live chip put back to 28 px, the Billing selects to 38 px and the asset header chip to 22 px (a style tag) are each reported.
//   2   the top bar at 1920, 1440, 1024 and 800: the Find field and the Live chip are 34 px (within 1 px), and the asset page's "live" chip is as tall as its Edit button.
//   3   every page, at 1440 and at 1024: Assets Tree, an asset page, Asset kinds, Dashboards, a dashboard (view and edit), Billing (an open month, a closed month, the Close month dialog),
//       Sources, Scans, Users, Roles, Settings, Tariffs, Storage, Audit, Diagnostics, Password: no pair of controls on one line differs in height, the page's named controls are there and at
//       least its floor of pairs was compared.
//   4   the same in dark + desert gold for Billing (a closed month), Audit, an asset page and the top bar (Assets Tree): the Live chip and the Find field still count as having an edge.
//   5   the note box: the Close month dialog and the Reopen month dialog at 1440 x 900, 1024 x 640 and 800 x 600: at least 4 lines, at most the smaller of 12 lines and 40% of the window, a drag
//       of 900 px down and up stays inside, Cancel and the confirming button are reachable at both ends, 40 typed lines move the count and the buttons by nothing and scroll inside the box.
//   6   the remove dialogs: an asset with energy data (the asset page's header button) keeps its sentence and adds the note (months not closed lose the figures, close first, the figures come back
//       when the same points are mapped again) inside the dialog's description, with the focus on Cancel; a leaf has no note; the bulk dialog of the Assets Tree's pick bar (two top-level rows) shows the note too.
//   7   Storage: the retention card says that removing assets keeps their readings, and while its settings are held back its skeleton has the same paragraphs above the form.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const RUN = Date.now().toString();
const ASSET = `w18 ${RUN}`;
const SECOND = `w18 ${RUN} b`;
const DASHBOARD = `w18 ${RUN}`;
/** What a stopped run of this spec left: `w18 <digits>` and `w18 <digits> b`. */
const LEFTOVER = /^w18 \d+( b)?$/;
/** The custom_unit of the one mapping this spec makes (on a free point): the mark that it is the spec's own, so sweep() knows what it may delete with a leftover asset. */
const SPEC_UNIT = "w18-spec";
/** The standard control height in px (`--ctl-h`): the Find field, the Live chip and the buttons. */
const CTL_H = 34;

interface Look { mode: "light" | "dark"; theme: string }
const LIGHT: Look = { mode: "light", theme: "navy-gold" };
const DARK: Look = { mode: "dark", theme: "desert-gold" };

interface ApiAsset { id: number; parent_id: number | null; name: string }
interface ApiNamed { id: number; name: string }
interface ApiPoint { id: number; address: string; mapping: { id: number; asset_id: number } | null }
interface ApiSummary { metrics: { mapping_id: number }[] }
interface ApiMapping { id: number; custom_unit: string | null }
interface Box { x: number; y: number; width: number; height: number }

// ---------------------------------------------------------------------------------------------------------------------------------
// What the cases need from the stack

/** The asset whose page shows the "live" chip: a real asset that already has a mapped metric, else the `w18 <run>` asset this run made. */
let assetId = 0;
let assetName = ASSET;
let dashboardId = 0;
/** The assets this run made (none on a stack that has a mapped asset and two top-level assets): afterAll deletes exactly these. */
const made: number[] = [];

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

async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

async function createAsset(request: APIRequestContext, name: string): Promise<number> {
  const made = await request.post("/api/assets", { data: { name, parent_id: null, kind: "generic", sort_order: -100 } });
  expect(made.status(), `creating the asset ${name}: ${await made.text()}`).toBe(201);
  return ((await made.json()) as ApiAsset).id;
}

/**
 * Takes away what a stopped run left (assets, dashboards). A `w18 ` asset is deleted only when every mapping it holds carries the spec's mark (custom_unit `w18-spec`): a mapping without it is a real one
 * (an older version of this spec moved real mappings onto its asset), and deleting the asset would delete it, so the run stops with a message instead.
 */
async function sweep(request: APIRequestContext): Promise<void> {
  for (const asset of (await getJson<ApiAsset[]>(request, "/api/assets")).filter((a) => LEFTOVER.test(a.name))) {
    for (const metric of (await getJson<ApiSummary>(request, `/api/assets/${asset.id}/summary`)).metrics) {
      const mapping = await getJson<ApiMapping>(request, `/api/mappings/${metric.mapping_id}`);
      if (mapping.custom_unit !== SPEC_UNIT) {
        throw new Error(`w18: refusing to delete the leftover asset "${asset.name}" (id ${asset.id}): it holds mapping ${mapping.id}, which this spec did not make (no custom_unit "${SPEC_UNIT}"). Move that mapping back to its own asset, then run again.`);
      }
    }
    await request.delete(`/api/assets/${asset.id}?confirm=true`);
  }
  for (const dashboard of (await getJson<ApiNamed[]>(request, "/api/dashboards")).filter((d) => LEFTOVER.test(d.name))) await request.delete(`/api/dashboards/${dashboard.id}`);
}

/** Every point of every source, read only. */
async function allPoints(request: APIRequestContext): Promise<ApiPoint[]> {
  const points: ApiPoint[] = [];
  for (const source of await getJson<ApiNamed[]>(request, "/api/sources")) points.push(...(await getJson<ApiPoint[]>(request, `/api/sources/${source.id}/points`)));
  return points;
}

/** The first asset (not a `w18 ` one) whose summary lists a mapped metric, so its page shows the "live" chip; null when the stack has none. Reads only. */
async function findMappedAsset(request: APIRequestContext, assets: ApiAsset[], points: ApiPoint[]): Promise<ApiAsset | null> {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const tried = new Set<number>();
  for (const point of points) {
    const asset = point.mapping === null ? undefined : byId.get(point.mapping.asset_id);
    if (asset === undefined || asset.name.startsWith("w18 ") || tried.has(asset.id)) continue;
    tried.add(asset.id);
    if ((await getJson<ApiSummary>(request, `/api/assets/${asset.id}/summary`)).metrics.length > 0) return asset;
  }
  return null;
}

test.beforeAll(async ({ browser }) => {
  await asAdmin(browser, async (request) => {
    const saved = await request.put("/api/me/preferences", { data: LIGHT });
    expect(saved.ok(), `starting from the light look: ${saved.status()} ${await saved.text()}`).toBe(true);
    await sweep(request);
    const assets = await getJson<ApiAsset[]>(request, "/api/assets");
    const points = await allPoints(request);
    let tops = assets.filter((a) => a.parent_id === null).length;
    const existing = await findMappedAsset(request, assets, points);
    if (existing) {
      assetId = existing.id;
      assetName = existing.name;
    } else {
      // Only a stack with no mapped asset: the asset of the run and ONE mapping of a free point (a point that is mapped is never touched).
      const free = points.find((p) => p.mapping === null);
      expect(free, "the stack has no mapped asset and no free point: w18 needs one or the other so an asset page shows its live chip, and it never moves a mapping").toBeDefined();
      assetId = await createAsset(request, ASSET);
      made.push(assetId);
      tops++;
      const mapped = await request.post("/api/mappings", { data: { point_id: free!.id, asset_id: assetId, metric: "active_power_kw", scale: 1, interval_seconds: null, custom_unit: SPEC_UNIT } });
      expect(mapped.status(), `mapping the free point ${free!.address} to the asset: ${await mapped.text()}`).toBe(201);
    }
    if (tops < 2) made.push(await createAsset(request, SECOND)); // the bulk remove case picks two top-level rows
    const dashboard = await request.post("/api/dashboards", { data: { name: DASHBOARD, range: "24h" } });
    expect(dashboard.ok(), `creating the dashboard: ${dashboard.status()} ${await dashboard.text()}`).toBe(true);
    dashboardId = ((await dashboard.json()) as ApiNamed).id;
  });
});

test.afterAll(async ({ browser }) => {
  await asAdmin(browser, async (request) => {
    const failures: string[] = [];
    for (const id of made.splice(0)) {
      const gone = await request.delete(`/api/assets/${id}?confirm=true`);
      if (![200, 204, 404].includes(gone.status())) failures.push(`deleting asset ${id}: ${gone.status()}`);
    }
    if (dashboardId !== 0) {
      const gone = await request.delete(`/api/dashboards/${dashboardId}`);
      if (![200, 204, 404].includes(gone.status())) failures.push(`deleting dashboard ${dashboardId}: ${gone.status()}`);
    }
    await request.put("/api/me/preferences", { data: LIGHT });
    expect(failures, "afterAll took away everything the spec made").toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The page: sign-in, the Billing answers, and a refusal of every other write

interface Stub {
  /** Writes the spec does not expect; the page got a 500 for each. */
  stray: string[];
}
const stubs: Stub[] = [];

test.afterEach(() => {
  for (const stub of stubs.splice(0)) expect(stub.stray, "the spec writes nothing to the stack: these requests were refused").toEqual([]);
});

const two = (n: number) => String(n).padStart(2, "0");

interface Opening {
  /** Every month the page asks for is an open one (`open`) or a closed one (`closed`, with a note). */
  billing?: "open" | "closed";
}

/** Signs in, answers the Billing routes of the case from the model and refuses every other write. */
async function prepare(page: Page, opening: Opening = {}): Promise<Stub> {
  const stub: Stub = { stray: [] };
  stubs.push(stub);
  // Registered FIRST, so it is asked last: a write that is not the sign-in or the look's save is refused and written down.
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    if (method === "GET" || method === "HEAD") return route.fallback();
    if (path === "/api/login" || (method === "PUT" && path === "/api/me/preferences")) return route.fallback();
    stub.stray.push(`${method} ${path}`);
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "w18: this spec writes nothing" }) });
  });
  if (opening.billing) {
    const closed = opening.billing === "closed";
    const answer = (path: string, body: (url: URL) => string, contentType = "application/json", headers?: Record<string, string>) =>
      page.route((url) => url.pathname === path, async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({ status: 200, contentType, headers, body: body(new URL(route.request().url())) }).catch(() => undefined); // the page may be gone by now
      });
    await answer("/api/billing/costs", (url) => {
      const body: ApiCosts = costsFor(url.searchParams.get("month") ?? "", { closed });
      if (body.closed) body.closed = { ...body.closed, closed_name: "w18 spec", note: "Closed for the w18 guard." };
      return JSON.stringify(body);
    });
    await answer("/api/billing/months", () => {
      const now = new Date();
      return JSON.stringify({ first_month: `${now.getUTCFullYear() - 1}-${two(now.getUTCMonth() + 1)}` }); // a year back, so Previous month has somewhere to go
    });
    await answer("/api/billing/costs.csv", () => "asset,total\r\nSite,1\r\n", "text/csv", { "content-disposition": 'attachment; filename="billing.csv"' });
  }
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in: ${login.status()} ${await login.text()}`).toBe(true);
  return stub;
}

async function setLook(page: Page, look: Look): Promise<void> {
  const saved = await page.request.put("/api/me/preferences", { data: look });
  expect(saved.ok(), `storing ${JSON.stringify(look)}: ${saved.status()} ${await saved.text()}`).toBe(true);
}

/** Answers GET /api/assets/{id}/impact of the dialogs, so a remove dialog says what the case wants it to say. It is never confirmed. */
async function answerImpact(page: Page, id: number, impact: { assets: number; mappings: number; tariffs: number }): Promise<void> {
  await page.route((url) => url.pathname === `/api/assets/${id}/impact`, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(impact) });
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Locators and small readings

const btn = (scope: Page | Locator, name: string) => scope.getByRole("button", { name, exact: true });
const html = (page: Page) => page.locator("html");
const bodyRows = (page: Page) => page.locator("table.billing tbody tr");
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

async function boxOf(target: Locator, what: string): Promise<Box> {
  const box = await target.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  return box!;
}

/** The page has finished loading: no skeleton is drawn and the top bar is there. */
async function loaded(page: Page): Promise<void> {
  await expect(page.locator(".sk-region")).toHaveCount(0);
  await expect(page.locator(".navbar .live")).toBeVisible();
  await settled(page);
}

async function openBilling(page: Page): Promise<void> {
  await page.goto("/billing");
  await expect(bodyRows(page).first()).toBeVisible();
  await expect(page.locator(".billing-page .billing-tools:not(.is-idle) .tools-count")).toHaveText(/\S/);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The checker

/** Every kind of control the checker looks at, and the non-button boxes that stand in a row of controls. */
const CANDIDATES = [
  "button", "input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=range])", "select", "[role=tab]", ".chip", ".live", ".filter-chip", "[role=combobox]",
  ".audit-page .range-sep", ".trend-bar > span", ".report-mask",
].join(", ");

/**
 * What is not compared, each with its reason. Anything else that has an edge is: the Live chip, the asset header chip, the Billing closed chip, selects, inputs and filter chips are the pairs this
 * wave fixed.
 */
const ALLOWED: readonly { inside?: string; self?: string; reason: string }[] = [
  { inside: "td, th", reason: "a data row packs small selects and status chips into a cell, so the row sets the size (the Users row select is 32 and its Active chip 22); the bars above the tables are compared" },
  { self: ".tip-btn, .twisty", reason: "a hit area drawn without an edge at rest: the visible mark is a glyph, whatever the box is" },
  { self: ".chip:not(.actions > .chip, .month-state > .chip)", reason: "a chip in running text or beside a title is --chip-h (22) by design; only a chip that stands in a row of controls (the asset header's actions, Billing's month state) is --ctl-h" },
];

/** What the checker does not look inside: hidden and inert boxes (the idle copy of Billing's tools bar is `visibility: hidden`), the graph canvas, the tree's rows and skeletons. */
const SKIPPED_INSIDE = "[inert], [hidden], .react-flow, .tree-scroll, .sk-shell, [aria-busy='true'], .sr-only";

interface RowsReport {
  /** The pairs on one line that both have an edge and are not allowed to differ: the pairs compared. */
  pairs: number;
  /** Of those, the pairs with neither control inside the top bar (`.navbar`): the page's own. */
  pagePairs: number;
  /** One line per compared pair whose heights differ by more than 1 px. */
  violations: string[];
  /** Every control that counted as having an edge (the allow-list left out), named as the violations name them. */
  edged: string[];
}

/** Measures the page as it is now: the controls on one line that have a visible edge must be as tall as each other (within 1 px). */
async function measureRows(page: Page): Promise<RowsReport> {
  await page.mouse.move(0, 0);
  await page.evaluate(() => { const at = document.activeElement; if (at instanceof HTMLElement) at.blur(); });
  await page.waitForTimeout(350); // a control that was hovered fades its tint out over the 150 ms motion
  return page.evaluate(({ candidates, allowed, skipped }) => {
    const alphaOf = (color: string): number => {
      if (color === "" || color === "transparent") return 0;
      const channels = color.match(/^rgba?\((.+)\)$/);
      if (channels) {
        const parts = channels[1].split(/[,/\s]+/).filter(Boolean);
        return parts.length < 4 ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      }
      const slash = color.match(/\/\s*([\d.]+%?)\s*\)$/);
      if (slash) return slash[1].endsWith("%") ? parseFloat(slash[1]) / 100 : parseFloat(slash[1]);
      return 1;
    };
    /** A border with a colour, a background with alpha, or an inset ring (`.live`, `.chip-off`): something that draws the control's box at rest. */
    const hasEdge = (el: Element): boolean => {
      const style = getComputedStyle(el);
      for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
        const sideStyle = style[`border${side}Style`];
        if (parseFloat(style[`border${side}Width`]) > 0 && sideStyle !== "none" && sideStyle !== "hidden" && alphaOf(style[`border${side}Color`]) > 0) return true;
      }
      if (alphaOf(style.backgroundColor) > 0) return true;
      if (style.boxShadow === "none" || !/inset/.test(style.boxShadow)) return false;
      const colour = style.boxShadow.match(/rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]+/i);
      return colour === null || alphaOf(colour[0]) > 0;
    };
    const isShown = (el: Element): boolean => {
      const box = el.getBoundingClientRect();
      if (box.width < 4 || box.height < 4) return false;
      if (getComputedStyle(el).visibility === "hidden") return false;
      for (let n: Element | null = el; n; n = n.parentElement) {
        const style = getComputedStyle(n);
        if (style.display === "none" || parseFloat(style.opacity) === 0) return false;
      }
      return el.closest(skipped) === null;
    };
    const isAllowed = (el: Element): boolean => allowed.some((rule) => (rule.inside !== undefined && el.closest(rule.inside) !== null) || (rule.self !== undefined && el.matches(rule.self)));
    const describe = (el: Element): string => {
      const classes = [...el.classList].slice(0, 3).join(".");
      const named = el.getAttribute("aria-label") || el.getAttribute("placeholder") || (el.textContent ?? "").trim().slice(0, 24) || (el instanceof HTMLInputElement ? el.type : "");
      return `${el.tagName.toLowerCase()}${classes ? `.${classes}` : ""} "${named}"`;
    };
    const lowestCommon = (a: Element, b: Element): Element => {
      const up = new Set<Element>();
      for (let n: Element | null = a; n; n = n.parentElement) up.add(n);
      for (let n: Element | null = b; n; n = n.parentElement) if (up.has(n)) return n;
      return document.body;
    };
    const controls = [...document.querySelectorAll(candidates)].filter(isShown).filter((el) => !isAllowed(el)).filter(hasEdge);
    const violations: string[] = [];
    let pairs = 0;
    let pagePairs = 0;
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i];
        const b = controls[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        if (Math.abs((ra.top + ra.bottom) / 2 - (rb.top + rb.bottom) / 2) > 6) continue;
        if (lowestCommon(a, b).getBoundingClientRect().height > Math.max(ra.height, rb.height) + 56) continue;
        pairs++;
        if (a.closest(".navbar") === null && b.closest(".navbar") === null) pagePairs++;
        if (Math.abs(ra.height - rb.height) > 1) violations.push(`${describe(a)} is ${ra.height}px high beside ${describe(b)} at ${rb.height}px`);
      }
    }
    return { pairs, pagePairs, violations, edged: controls.map(describe) };
  }, { candidates: CANDIDATES, allowed: ALLOWED, skipped: SKIPPED_INSIDE });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. The checker bites

test("1. the checker bites: a bordered 22 px box beside a button is reported, a borderless one is not", async ({ page }) => {
  await prepare(page, { billing: "open" });
  await openBilling(page);
  const clean = await measureRows(page);
  expect(clean.violations, "the Billing page itself has no pair of different heights").toEqual([]);
  expect(clean.pairs, "the Billing bar has pairs to compare").toBeGreaterThanOrEqual(8);

  // A span that the checker's selector list knows (`.filter-chip`), 22 px high, beside the Previous month button in its row.
  await btn(page, "Previous month").evaluate((button) => {
    const probe = document.createElement("span");
    probe.id = "w18-probe";
    probe.className = "filter-chip";
    probe.textContent = "probe";
    probe.setAttribute("style", "display:inline-flex;align-items:center;align-self:center;height:22px;min-height:0;border:1px solid #000;background:#fff");
    button.after(probe);
  });
  const bitten = await measureRows(page);
  expect(bitten.violations.filter((v) => v.includes('"probe"')), `a bordered 22 px box beside a 34 px button is reported (${bitten.violations.join(" | ")})`).not.toEqual([]);
  expect(bitten.pairs, "the probe made pairs").toBeGreaterThan(clean.pairs);

  await page.locator("#w18-probe").evaluate((probe) => probe.setAttribute("style", "display:inline-flex;align-items:center;align-self:center;height:22px;min-height:0;border:0;background:none"));
  const quiet = await measureRows(page);
  expect(quiet.violations, "a borderless 22 px box has no edge at rest and is not compared").toEqual([]);
  expect(quiet.pairs, "and it makes no pair").toBe(clean.pairs);
});

// The three pairs this wave levelled, put back to their old heights through a style tag: each is reported, so the pages' own cases below would fail the same way.
const BREAKAGES = [
  { what: "the Live chip at 28 px beside the Find field", at: "billing", css: ".navbar .live { height: 28px !important; }", reported: ["span.live", "Find an asset or page"] },
  { what: "the Year and Month selects at 38 px beside the month buttons", at: "billing", css: ".billing-page select { min-height: 38px !important; }", reported: ["select", "38px"] },
  { what: "the asset header chip at 22 px beside the Edit button", at: "asset", css: ".page-head .actions > .chip { height: 22px !important; }", reported: ["span.chip", '"Edit"'] },
] as const;

for (const breakage of BREAKAGES) {
  test(`1b. the checker reports ${breakage.what}`, async ({ page }) => {
    await prepare(page, { billing: breakage.at === "billing" ? "open" : undefined });
    if (breakage.at === "billing") await openBilling(page);
    else await page.goto(`/assets/${assetId}`);
    await loaded(page);
    await expect(page.locator(".page-head .actions > .chip, .billing-bar").first(), "the page is the one the breakage is about").toBeVisible();
    expect((await measureRows(page)).violations, "the page is clean before the breakage").toEqual([]);
    await page.addStyleTag({ content: breakage.css });
    const report = await measureRows(page);
    expect(report.violations.length, `the checker reports the breakage (${report.violations.join(" | ")})`).toBeGreaterThan(0);
    for (const word of breakage.reported) expect(report.violations.join(" | "), `a report names ${word}`).toContain(word);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. The top bar and the asset header

for (const width of [1920, 1440, 1024, 800]) {
  test(`2. the Find field and the Live chip are ${CTL_H} px high at ${width}, and the asset header's chip is as tall as its Edit button`, async ({ page }) => {
    await prepare(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/assets/${assetId}`);
    await loaded(page);
    const find = page.locator(".navbar .qf input[type=search]");
    const live = page.locator(".navbar .live");
    const chip = page.locator(".page-head .actions > .chip");
    const edit = btn(page.locator(".page-head .actions"), "Edit");
    await expect(find, "the Find field").toBeVisible();
    await expect(chip, "the asset header's live chip (the asset has a mapped point)").toBeVisible();
    await expect(edit, "the Edit button").toBeVisible();
    const heights = {
      find: (await boxOf(find, "the Find field")).height,
      live: (await boxOf(live, "the Live chip")).height,
      chip: (await boxOf(chip, "the asset header chip")).height,
      edit: (await boxOf(edit, "the Edit button")).height,
    };
    expect(Math.abs(heights.find - CTL_H), `the Find field is ${heights.find}`).toBeLessThanOrEqual(1);
    expect(Math.abs(heights.live - CTL_H), `the Live chip is ${heights.live}`).toBeLessThanOrEqual(1);
    expect(Math.abs(heights.live - heights.find), `the Live chip (${heights.live}) and the Find field (${heights.find}) are level`).toBeLessThanOrEqual(1);
    expect(Math.abs(heights.chip - heights.edit), `the asset header chip (${heights.chip}) and the Edit button (${heights.edit}) are level`).toBeLessThanOrEqual(1);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. The pages

interface PageCase {
  name: string;
  billing?: "open" | "closed";
  /** Opens the page (and the dialog or mode the case is about). */
  open: (page: Page) => Promise<void>;
  /** Two or three controls of the page by name: the page is the one it should be, and loaded. */
  named: (page: Page) => Locator[];
  /** At least this many of the PAGE'S OWN pairs were compared (`pagePairs`: neither control in the top bar, whose Find field and Live chip are one pair on every page). Why a page's floor is what it is: see PAGES. */
  floor: number;
}

const goTo = (path: string | (() => string)) => async (page: Page) => { await page.goto(typeof path === "string" ? path : path()); };

async function openCloseDialog(page: Page): Promise<void> {
  await openBilling(page);
  await btn(page, "Previous month").click();
  await btn(page, "Close month…").click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

// The floors count the page's own pairs (`pagePairs`), read from the pages at 1440 and 1024 on the look stack (the largest count in brackets) and set to what holds on any stack: a bar that is the page's
// own (a Billing answer is mocked, the dashboard is the spec's own) is counted from its controls; a count that depends on the stack's data is kept lower. A floor of 0 says why on the line above it:
// the page has no bar of two edged controls on one line, so its case checks the heights of what is there and the named controls, nothing more.
const PAGES: readonly PageCase[] = [
  // floor 0: the Filter box sits in the tree column and Add asset in the page header, never on one line (the tree's own buttons have no edge at rest).
  { name: "Assets Tree", open: goTo("/assets"), floor: 0, named: (p) => [btn(p, "Add asset"), p.getByPlaceholder("Filter by name or kind")] },
  // 6: the header's four edged controls on one line (the live chip, Edit, Delete, Add asset); the page brings more (16: the trend's metric select and range buttons, the tree's Move to...).
  { name: "an asset page", open: goTo(() => `/assets/${assetId}`), floor: 6, named: (p) => [p.locator(".page-head .actions > .chip"), btn(p.locator(".page-head .actions"), "Edit"), btn(p.locator(".page-head .actions"), "Add asset")] },
  // 6: the four filter chips (All, Starter, Yours, Unused) on one line (7 with the page header's two buttons).
  { name: "Asset kinds", open: goTo("/assets/kinds"), floor: 6, named: (p) => [btn(p, "New kind"), p.getByRole("button", { name: /^All \d+$/ })] },
  // floor 0: New dashboard is the only control on the page with an edge at rest.
  { name: "Dashboards", open: goTo("/dashboards"), floor: 0, named: (p) => [btn(p, "New dashboard")] },
  // 1: the range select beside Edit.
  { name: "a dashboard", open: goTo(() => `/dashboards/${dashboardId}`), floor: 1, named: (p) => [btn(p, "Edit"), p.getByLabel("Dashboard range")] },
  {
    // 10: name, range, Add widget, Save and Cancel on one line (10).
    name: "a dashboard in edit mode",
    open: async (p) => { await p.goto(`/dashboards/${dashboardId}`); await btn(p, "Edit").click(); },
    floor: 10,
    named: (p) => [p.getByLabel("Dashboard name"), btn(p, "Add widget"), btn(p, "Save"), btn(p, "Cancel")],
  },
  // 10: the month bar (Previous, Next, Year, Month) and the tools bar (filter, Collapse all, Expand all, Show levels) with Download CSV (12).
  { name: "Billing, an open month", billing: "open", open: openBilling, floor: 10, named: (p) => [btn(p, "Previous month"), btn(p, "Next month"), p.getByLabel("Year", { exact: true }), p.getByLabel("Month", { exact: true }), btn(p, "Expand all")] },
  {
    // 14: the same bars with the Closed chip and Reopen month (17).
    name: "Billing, a closed month",
    billing: "closed",
    open: openBilling,
    floor: 14,
    named: (p) => [p.locator(".month-state .chip"), btn(p, "Previous month"), btn(p, "Next month"), btn(p, "Reopen month…"), btn(p, "Expand all")],
  },
  // 12: the bars of the page behind the dialog (14 with the dialog's Cancel and Close month).
  { name: "Billing, the Close month dialog", billing: "open", open: openCloseDialog, floor: 12, named: (p) => [btn(p.getByRole("dialog"), "Cancel"), btn(p.getByRole("dialog"), "Close month")] },
  // 1: Test all beside Add source (the stack has a source: w18 needs a point of one).
  { name: "Sources", open: goTo("/sources"), floor: 1, named: (p) => [btn(p, "Test all"), btn(p, "Add source")] },
  // floor 0: New scope is the only control on the page with an edge at rest.
  { name: "Scans", open: goTo("/scans"), floor: 0, named: (p) => [btn(p, "New scope")] },
  // 6: Username, Password, Role and Create user on one line (the form is 84 px high with its labels above, so the bar limit of 34 + 56 is what lets it count).
  { name: "Users", open: goTo("/users"), floor: 6, named: (p) => [p.getByLabel("Username", { exact: true }), btn(p, "Create user")] },
  // floor 0: New role is the only edged control on its line (the Users and Roles tabs above it are on a line of their own).
  { name: "Roles", open: goTo("/users/roles"), floor: 0, named: (p) => [btn(p, "New role")] },
  // floor 0: the two cards stack their fields one under another and each keeps its Save at its foot, so no two edged controls of one card share a line.
  { name: "Settings", open: goTo("/settings"), floor: 0, named: (p) => [p.getByLabel("Timezone", { exact: true }), btn(p, "Save sign-in protection")] },
  // 1: the Currency field beside its Save button (the rate rows, with their labels and tips above the fields, are taller than the checker's bar limit and are not counted).
  { name: "Tariffs", open: goTo("/tariffs"), floor: 1, named: (p) => [p.getByLabel("Currency", { exact: true }), btn(p, "Add rate").first()] },
  // 2: the date fields and the retention card's buttons.
  { name: "Storage", open: goTo("/storage"), floor: 2, named: (p) => [p.getByLabel("Rows from day", { exact: true }), p.getByLabel("Raw retention (days)", { exact: true }), btn(p, "Set as default")] },
  // 20: the filter bar and the pager (52 at 1440, 40 at 1024); kept well under what they give, so a wrap at another width does not fail it.
  { name: "Audit", open: goTo("/audit"), floor: 20, named: (p) => [btn(p, "Export CSV"), btn(p, "Today"), p.getByLabel("Go to date", { exact: true })] },
  // 1: the connection check's source select beside Run connection check (Build report and its select are each on a line of their own).
  { name: "Diagnostics", open: goTo("/diagnostics"), floor: 1, named: (p) => [btn(p, "Build report"), btn(p, "Run connection check")] },
  // floor 0: the three password fields stack, and Change password sits under them.
  { name: "Password", open: goTo("/password"), floor: 0, named: (p) => [p.getByLabel("Current password", { exact: true }), btn(p, "Change password")] },
];

async function measurePage(page: Page, c: PageCase): Promise<void> {
  await c.open(page);
  await loaded(page);
  for (const named of c.named(page)) await expect(named, `${c.name}: a named control is there`).toBeVisible();
  const report = await measureRows(page);
  expect(report.violations, `${c.name}: no two controls on one line differ in height`).toEqual([]);
  expect(report.pagePairs, `${c.name}: the page's own pairs compared (the controls with an edge: ${report.edged.join(" | ")})`).toBeGreaterThanOrEqual(c.floor);
}

for (const width of [1440, 1024]) {
  for (const c of PAGES) {
    test(`3. ${c.name} at ${width}: no two controls on one line differ in height`, async ({ page }) => {
      await prepare(page, { billing: c.billing });
      await page.setViewportSize({ width, height: 900 });
      await measurePage(page, c);
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. Dark

for (const name of ["Billing, a closed month", "Audit", "an asset page", "Assets Tree"]) {
  test(`4. dark + desert gold: ${name}, no two controls on one line differ in height, and the Live chip and the Find field still have an edge`, async ({ page }) => {
    const c = PAGES.find((p) => p.name === name)!;
    await prepare(page, { billing: c.billing });
    await page.setViewportSize({ width: 1440, height: 900 });
    await setLook(page, DARK);
    try {
      await c.open(page);
      await expect(html(page)).toHaveAttribute("data-mode", DARK.mode);
      await expect(html(page)).toHaveAttribute("data-theme", DARK.theme);
      await loaded(page);
      for (const named of c.named(page)) await expect(named, `${c.name}: a named control is there`).toBeVisible();
      const report = await measureRows(page);
      expect(report.violations, `${name}: no two controls on one line differ in height`).toEqual([]);
      expect(report.pagePairs, `${name}: the page's own pairs compared (${report.edged.join(" | ")})`).toBeGreaterThanOrEqual(c.floor);
      // The rule is by alpha: a theme that made an edge transparent would hide a pair, so the two controls of the top bar must still count.
      expect(report.edged.some((e) => e.startsWith("span.live ")), `the Live chip has an edge in dark (${report.edged.join(" | ")})`).toBe(true);
      expect(report.edged.some((e) => e.startsWith("input ") && e.includes("Find an asset or page")), `the Find field has an edge in dark (${report.edged.join(" | ")})`).toBe(true);
    } finally {
      await setLook(page, LIGHT);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. The note box

const SIZES = [{ width: 1440, height: 900 }, { width: 1024, height: 640 }, { width: 800, height: 600 }] as const;

/** Opens the Close month dialog (a finished open month) or the Reopen month dialog (a closed month); nothing is requested until the confirming button is pressed, and it never is. */
async function openMonthDialog(page: Page, kind: "close" | "reopen"): Promise<Locator> {
  await openBilling(page);
  if (kind === "close") {
    await btn(page, "Previous month").click();
    await btn(page, "Close month…").click();
  } else {
    await btn(page, "Reopen month…").click();
  }
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Presses on the box's bottom-right corner (its grip) and moves `dy` px, a long way past the window's edge. */
async function dragGrip(page: Page, note: Locator, dy: number): Promise<void> {
  await note.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = await boxOf(note, "the note box");
  const x = box.x + box.width - 4;
  const y = box.y + box.height - 4;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 10 });
  await page.mouse.up();
  await settled(page);
}

/** Scrolls each target of the dialog into view and checks that it lies inside the window. */
async function expectReachable(page: Page, targets: Record<string, Locator>, where: string): Promise<void> {
  const view = page.viewportSize()!;
  for (const [name, target] of Object.entries(targets)) {
    await target.scrollIntoViewIfNeeded();
    await settled(page);
    const box = await boxOf(target, name);
    const inside = box.y >= 0 && box.y + box.height <= view.height && box.x >= 0 && box.x + box.width <= view.width;
    expect(inside, `${where}: ${name} is inside the window (${JSON.stringify(box)} in ${view.width} x ${view.height})`).toBe(true);
  }
}

for (const kind of ["close", "reopen"] as const) {
  test(`5. the ${kind === "close" ? "Close month" : "Reopen month"} note box is between 4 and 12 lines (and 40% of the window), keeps its place while typing, and the buttons stay reachable`, async ({ page }) => {
    await prepare(page, { billing: kind === "close" ? "open" : "closed" });
    for (const size of SIZES) {
      await test.step(`${size.width} x ${size.height}`, async () => {
        const where = `${kind} ${size.width}x${size.height}`;
        await page.setViewportSize(size);
        const dialog = await openMonthDialog(page, kind);
        const note = dialog.locator("textarea");
        const count = dialog.locator(".month-count");
        const go = dialog.locator(".month-go");
        const cancel = btn(dialog, "Cancel");
        const limits = await note.evaluate((el) => {
          const style = getComputedStyle(el);
          const line = parseFloat(style.lineHeight);
          const extra = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
          return { line, min: 4 * line + extra, max: Math.min(0.4 * window.innerHeight, 12 * line + extra) };
        });
        expect(limits.line, `${where}: the line height is a number of px`).toBeGreaterThan(0);
        const high = async () => (await boxOf(note, "the note box")).height;

        expect(await high(), `${where}: starts at least 4 lines high (${limits.min})`).toBeGreaterThanOrEqual(limits.min - 1);
        expect(await high(), `${where}: starts at most ${limits.max} high`).toBeLessThanOrEqual(limits.max + 1);

        await dragGrip(page, note, 900);
        const grown = await high();
        expect(grown, `${where}: dragged 900 px down it stops at the maximum (${limits.max}), not above`).toBeLessThanOrEqual(limits.max + 1);
        expect(grown, `${where}: dragged 900 px down it did grow to the maximum (${limits.max})`).toBeGreaterThanOrEqual(limits.max - 2);
        await expectReachable(page, { Cancel: cancel, "the confirming button": go }, `${where}, the box at its maximum`);

        await dragGrip(page, note, -900);
        const shrunk = await high();
        expect(shrunk, `${where}: dragged 900 px up it stops at 4 lines (${limits.min}), not below`).toBeGreaterThanOrEqual(limits.min - 1);
        expect(shrunk, `${where}: dragged 900 px up it did shrink to 4 lines (${limits.min})`).toBeLessThanOrEqual(limits.min + 2);
        await expectReachable(page, { Cancel: cancel, "the confirming button": go }, `${where}, the box at its minimum`);

        // Forty typed lines: the count line and the buttons do not move, the box does not grow, the text scrolls inside it.
        await dialog.evaluate((el) => { el.scrollTop = 0; });
        const before = { count: await boxOf(count, "the count"), go: await boxOf(go, "the confirming button"), cancel: await boxOf(cancel, "Cancel"), note: await boxOf(note, "the note box") };
        await note.fill(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
        await dialog.evaluate((el) => { el.scrollTop = 0; });
        await settled(page);
        const after = { count: await boxOf(count, "the count"), go: await boxOf(go, "the confirming button"), cancel: await boxOf(cancel, "Cancel"), note: await boxOf(note, "the note box") };
        for (const part of ["count", "go", "cancel", "note"] as const) {
          for (const key of ["x", "y", "width", "height"] as const) {
            expect(Math.abs(after[part][key] - before[part][key]), `${where}: after 40 lines ${part}.${key} is ${after[part][key]}, it was ${before[part][key]}`).toBeLessThan(0.5);
          }
        }
        expect(await note.evaluate((el) => el.scrollHeight > el.clientHeight), `${where}: 40 lines scroll inside the box`).toBe(true);
      });
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 6. The remove dialogs

const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
/** The sentence the delete dialogs have always said (lib/impact.ts assetLoss), written here again. */
const LOSS = (assets: number, mappings: number, tariffs: number) =>
  `${counted(assets, "asset")}, ${counted(mappings, "mapping")} and ${counted(tariffs, "tariff")} will be deleted; their past energy and cost figures disappear from Billing and dashboards, except in closed months, which keep their billed figures.`;
/** What the note of an ASSET delete must say, in its key words: a month that is not closed loses the figures, closing first keeps a finished month, mapping the same points again brings the figures back.
 * (A source's note says "cannot be mapped again" instead: its points go with it. No case here removes a source.) */
const NOTE_WORDS = ["not closed", "close that month", "get their figures back"] as const;

/** The dialog's note is inside the region its `aria-describedby` names (the polite description), and Cancel has the focus. */
async function expectNoteDescribesDialog(dialog: Locator, note: Locator): Promise<void> {
  const region = await dialog.getAttribute("aria-describedby");
  expect(region, "the dialog names its description").toBeTruthy();
  expect(await note.evaluate((el, id) => document.getElementById(id)?.contains(el) ?? false, region ?? ""), "the note is inside the dialog's description").toBe(true);
  await expect(btn(dialog, "Cancel"), "Cancel has the focus").toBeFocused();
}

test("6a. the remove dialog of an asset with energy data keeps its sentence and adds the note inside its description", async ({ page }) => {
  await prepare(page);
  await answerImpact(page, assetId, { assets: 3, mappings: 3, tariffs: 0 });
  await page.goto(`/assets/${assetId}`);
  await loaded(page);
  await btn(page.locator(".page-head"), `Delete ${assetName}`).click();
  const dialog = page.getByRole("dialog", { name: `Delete "${assetName}"?`, exact: true });
  await expect(dialog).toBeVisible();
  await expect(btn(dialog, "Delete anyway"), "the numbers are in").toBeEnabled();
  await expect(dialog.locator(".confirm-body"), "the old sentence is still there").toContainText(LOSS(3, 3, 0));
  const note = dialog.locator(".confirm-note");
  await expect(note, "one note paragraph").toHaveCount(1);
  for (const words of NOTE_WORDS) await expect(note, `the note says "${words}"`).toContainText(words);
  await expectNoteDescribesDialog(dialog, note);
  await btn(dialog, "Cancel").click();
  await expect(dialog).toBeHidden();
});

test("6b. the remove dialog of a leaf has no note and says only that it cannot be undone", async ({ page }) => {
  await prepare(page);
  await answerImpact(page, assetId, { assets: 1, mappings: 0, tariffs: 0 });
  await page.goto(`/assets/${assetId}`);
  await loaded(page);
  await btn(page.locator(".page-head"), `Delete ${assetName}`).click();
  const dialog = page.getByRole("dialog", { name: `Delete "${assetName}"?`, exact: true });
  await expect(dialog).toBeVisible();
  await expect(btn(dialog, "Delete"), "the numbers are in").toBeEnabled();
  await expect(dialog.locator(".confirm-body"), "the plain message").toHaveText("This can't be undone.");
  await expect(dialog.locator(".confirm-note"), "no note without energy data").toHaveCount(0);
  await expect(btn(dialog, "Cancel"), "Cancel has the focus").toBeFocused();
  await btn(dialog, "Cancel").click();
  await expect(dialog).toBeHidden();
});

test("6c. the bulk remove dialog of the Assets Tree's pick bar shows the note for assets with energy data", async ({ page }) => {
  await prepare(page);
  await page.goto("/assets");
  await loaded(page);
  // The first two top-level rows of the tree, whatever the stack holds: they are picked and never deleted (the impact is answered here, the confirming button is not pressed).
  const tree = page.getByRole("region", { name: "Asset tree" });
  const tops = await tree.evaluate((region) =>
    [...region.querySelectorAll<HTMLElement>(".node[data-asset-id]")].filter((node) => node.closest("li")?.parentElement?.closest("li") == null).slice(0, 2).map((node) => Number(node.dataset.assetId)),
  );
  expect(tops.length, "the Assets Tree has two top-level rows to pick").toBe(2);
  // The dialog checks the server's count of assets under each pick against the asset list, so the answer for a row with sub-assets counts them (the row and everything below it).
  const list = (await (await page.request.get("/api/assets")).json()) as ApiAsset[];
  const below = (id: number): number => 1 + list.filter((a) => a.parent_id === id).reduce((sum, child) => sum + below(child.id), 0);
  const counts = tops.map(below);
  for (const [i, id] of tops.entries()) await answerImpact(page, id, { assets: counts[i], mappings: 2, tariffs: 0 });
  for (const id of tops) await tree.locator(`a[href="/assets/${id}"]`).click({ modifiers: ["Control"] });
  const bar = tree.getByRole("group", { name: "Selection", exact: true });
  await expect(bar).toContainText("2 picked");
  await btn(bar, "Delete the 2 picked assets").click();
  const dialog = page.getByRole("dialog", { name: "Delete 2 assets?", exact: true });
  await expect(dialog).toBeVisible();
  await expect(btn(dialog, "Delete anyway"), "the numbers are in").toBeEnabled();
  await expect(dialog.locator(".confirm-body"), "the sentence of the two picks together").toContainText(LOSS(counts[0] + counts[1], 4, 0));
  const note = dialog.locator(".confirm-note");
  await expect(note, "one note paragraph").toHaveCount(1);
  for (const words of NOTE_WORDS) await expect(note, `the note says "${words}"`).toContainText(words);
  await expectNoteDescribesDialog(dialog, note);
  await btn(dialog, "Cancel").click();
  await expect(dialog).toBeHidden();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 7. Storage

test("7. the Storage retention card says that removing assets keeps their readings, and its skeleton has the same paragraphs above the form", async ({ page }) => {
  await prepare(page);
  // The settings are held back, so the skeleton stays; then they are answered by the real server.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === "/api/settings/storage", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await gate;
    await route.continue().catch(() => undefined); // the page may be gone by now
  });
  // The paragraphs of the retention card above its form: the free-disk note and the readings note, in the real card and as word pills in the skeleton.
  const paragraphsAboveForm = () =>
    page.locator(".retention-card").evaluate((card) => {
      const found: string[] = [];
      for (const child of card.children) {
        if (child.matches(".retention-form")) break;
        if (child.tagName === "P") found.push(child.className);
      }
      return found;
    });
  try {
    await page.goto("/storage");
    await expect(page.locator(".sk-region"), "the held settings keep the page's skeleton").toHaveCount(1);
    await expect(page.locator(".retention-card")).toBeVisible();
    const skeleton = await paragraphsAboveForm();
    release();
    await expect(page.locator(".sk-region")).toHaveCount(0);
    await expect(page.getByLabel("Raw retention (days)", { exact: true })).toBeVisible();
    const real = await paragraphsAboveForm();
    expect(real, "the retention card has the free-disk note and the readings note above its form").toHaveLength(2);
    expect(skeleton.length, `the skeleton has as many paragraphs above its form as the loaded card (${skeleton.join(" | ")} against ${real.join(" | ")})`).toBe(real.length);
    const notes = page.locator(".retention-card p.muted");
    await expect(notes.nth(0), "the free-disk note comes first").toContainText("Free disk space is not visible from the API container");
    await expect(notes.nth(1), "the readings note is under it").toContainText("Removing assets or sources does not remove their readings.");
  } finally {
    release();
  }
});
