import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import {
  assetsList, belowOf, childrenOf, costsFor, LONG_NAME, nodeAt, NODES, ROWS_BY_LEVEL, rowsByLevelOf, SMALL_NAMES, smallCostsFor, TOTAL_ROWS,
} from "./billingModel";

// W17 (Billing at scale): the Billing table folds like the Assets Tree (a twisty on every parent, Collapse all, Expand all, Show levels), a filter box finds rows, the day-number header and the
// first column stay while the rows scroll, a big month (and a big Assets Tree) opens folded, and the fold is remembered. Admin `admin` / `correct-horse`, the account the earlier projects use.
//
// IT WRITES NOTHING and needs nothing from the stack. Every case answers GET /api/billing/costs (and GET /api/billing/months, and GET /api/billing/costs.csv with a one-line file) through
// page.route from a generated month (e2e/billingModel.ts: a pilot-hall shape of 370 rows, ids from 7,000 up, 31 days, every parent EXACTLY the sum of its children); the Assets Tree cases answer
// GET /api/assets from the same 370 assets. Any other write the page tries is refused with a 500 and fails the case (the sign-in and the look's save are the only ones allowed). The look is the
// admin's saved preference, set through PUT /api/me/preferences before a page opens; afterAll puts it back to Light and Navy and gold, also after a failed case.
//
// The words of the page are written here again (src/lib/billingRows.ts: rowsLine, twistyLabel, noMatchText): importing them would pull the app into the strict e2e type-check.
//
// Locators. Playwright matches a name by case-insensitive SUBSTRING, so the buttons and the filter box are looked up with `exact: true`; a row's twisty is the button named
// `Collapse|Expand <name>, <N> rows below`; a row header is named by the asset's name alone (aria-labelledby), and the rows are read from `table.billing tbody`.
//
// The cases:
//   0   the model itself: 1, 4, 16, 24, 141 and 370 rows per level, ids from 7,000 in pre-order, every parent the exact sum of its children, one asset with no figures, one name of 60+ characters.
//   1   a big month opens folded to the deepest level with at most 60 rows (24 of 370, the same number of rows in the DOM, none hidden with CSS, level 4, nothing written to storage by the visit);
//       a month of 5 rows opens whole.
//   2   a twisty folds Hall 1 and unfolds it again: the button keeps the focus (the same element), its name and aria-expanded change, Hall 1's own cells read the same; expanded, the Hall's month
//       total (kWh and cost text) equals the sum of its two pods'.
//   3   Collapse all, Expand all, Show levels 1 to 5 and All give the rows of the model; a twisty after a level makes the select read Custom and nothing else changes until another option is chosen.
//   4   the filter: "rack 01" shows the 2 matches and their ancestors, no twisty, the three controls disabled, a folded branch shows its match, Escape clears and the fold is back, "zzz" shows the
//       one no-match row, Clear filter clears and focuses the box.
//   5   the keyboard: Tab order filter, Clear filter (only with text), Collapse all, Expand all, Show levels, the ? button, the first twisty; Enter and Space on a twisty, the focus stays on it.
//   6   the header stays: 1440 x 900 light and 1024 x 768 dark (the first header row at the top of the box after a vertical scroll, the first column at its left after a sideways one, nothing
//       scrolls the page sideways), and 800 x 600, where only "no sideways scroll, the bar and the table are there" is claimed.
//   7   no layout shift: the page head and the month bar are where they were once the costs land, the skeleton's first row and the loaded first row are within 2 px, and a fold moves neither.
//   8   the CSV request is `/api/billing/costs.csv?month=YYYY-MM` after folding and filtering (8a, an open month); a closed month (8b) folds and filters the same way, keeps its banner and its
//       Reopen button, and its CSV request has the same shape.
//   9   the fold is remembered: a reload keeps it, Previous month keeps the fold and the filter text, Expand all is remembered as `none`, a fresh browser starts with the default, so does the same
//       page on another origin (127.0.0.1 against localhost).
//   10  the Assets Tree: 370 assets open at level 2 with nothing stored, the way to a deep asset unfolds and the row lies inside the tree's box, `none` opens it fully, the old `[]` opens folded.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const FOLD_KEY = "dcdash.billingFolded";
const TREE_KEY = "dcdash.assetTreeFolded";

interface Look { mode: "light" | "dark"; theme: string }
const LIGHT: Look = { mode: "light", theme: "navy-gold" };
const DARK: Look = { mode: "dark", theme: "desert-gold" };

const two = (n: number) => String(n).padStart(2, "0");
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------------------------------------------------------------
// The mock

interface Stub {
  /** Console errors and uncaught exceptions of the page. */
  errors: string[];
  /** Writes the spec does not expect; the page got a 500 for each. */
  stray: string[];
  /** The `month` of every GET /api/billing/costs, in order. */
  months: string[];
  /** The path and query of every GET /api/billing/costs.csv. */
  csv: string[];
  /** While set, the costs request waits for it. */
  gate: Promise<void> | null;
  /** The Assets Tree cases open assets the stack does not have: its answers for their details are 404 and the console says so. */
  lenient: boolean;
}
const stubs: Stub[] = [];

test.afterEach(() => {
  for (const stub of stubs.splice(0)) {
    expect(stub.stray, "the spec writes nothing to the stack: these requests were refused").toEqual([]);
    if (!stub.lenient) expect(stub.errors, "the page logged no console error and no exception").toEqual([]);
  }
});

async function asAdmin<T>(browser: Browser, use: (request: Page["request"]) => Promise<T>): Promise<T> {
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
    const saved = await request.put("/api/me/preferences", { data: LIGHT });
    expect(saved.ok(), `starting from the light look: ${saved.status()} ${await saved.text()}`).toBe(true);
  });
});
test.afterAll(async ({ browser }) => {
  await asAdmin(browser, async (request) => { await request.put("/api/me/preferences", { data: LIGHT }); });
});

interface Opening {
  /** Every month the page asks for is a closed one. */
  closed?: boolean;
  /** The month has 5 rows (the Site and four meters). */
  small?: boolean;
  /** GET /api/assets is answered with the 370 assets of the model. */
  assets?: boolean;
}

/** Answers the routes of the cases from the model, refuses every other write, listens for errors and signs in. */
async function prepare(page: Page, opening: Opening = {}): Promise<Stub> {
  const stub: Stub = { errors: [], stray: [], months: [], csv: [], gate: null, lenient: false };
  stubs.push(stub);
  page.on("console", (message) => {
    if (message.type() !== "error" || /net::ERR_ABORTED/.test(message.text())) return;
    const url = message.location().url;
    if (/\/api\/me$/.test(url) && /401/.test(message.text())) return; // the sign-in page asks before anyone is signed in; these cases sign in first
    stub.errors.push(`console: ${message.text()} (${url})`);
  });
  page.on("pageerror", (error) => stub.errors.push(`pageerror: ${error.message}`));
  // Registered FIRST, so it is asked last: a write that is not the sign-in or the look's save is refused and written down.
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    if (method === "GET" || method === "HEAD") return route.fallback();
    if (path === "/api/login" || (method === "PUT" && path === "/api/me/preferences")) return route.fallback();
    stub.stray.push(`${method} ${path}`);
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "w17: this spec writes nothing" }) });
  });
  const answer = (path: string, body: (url: URL) => string, extra: { contentType?: string; headers?: Record<string, string>; seen?: (url: URL) => void } = {}) =>
    page.route((url) => url.pathname === path, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const url = new URL(route.request().url());
      extra.seen?.(url);
      if (path === "/api/billing/costs" && stub.gate) await stub.gate;
      await route.fulfill({ status: 200, contentType: extra.contentType ?? "application/json", headers: extra.headers, body: body(url) }).catch(() => undefined); // the page may be gone by now
    });
  await answer("/api/billing/costs", (url) => {
    const month = url.searchParams.get("month") ?? "";
    return JSON.stringify((opening.small ? smallCostsFor : costsFor)(month, { closed: opening.closed === true }));
  }, { seen: (url) => stub.months.push(url.searchParams.get("month") ?? "") });
  await answer("/api/billing/months", () => {
    const now = new Date();
    return JSON.stringify({ first_month: `${now.getUTCFullYear() - 1}-${two(now.getUTCMonth() + 1)}` }); // a year back, so Previous month has somewhere to go
  });
  await answer("/api/billing/costs.csv", () => "asset,total\r\nSite,1\r\n", {
    contentType: "text/csv", headers: { "content-disposition": 'attachment; filename="billing.csv"' }, seen: (url) => stub.csv.push(url.pathname + url.search),
  });
  if (opening.assets) await answer("/api/assets", () => JSON.stringify(assetsList()));
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in: ${login.status()} ${await login.text()}`).toBe(true);
  return stub;
}

async function setLook(page: Page, look: Look): Promise<void> {
  const saved = await page.request.put("/api/me/preferences", { data: look });
  expect(saved.ok(), `storing ${JSON.stringify(look)}: ${saved.status()} ${await saved.text()}`).toBe(true);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Locators and small readings

const btn = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const bodyRows = (page: Page) => page.locator("table.billing tbody tr");
const labels = (page: Page) => page.locator("table.billing tbody th[scope=row] .bill-label");
const html = (page: Page) => page.locator("html");
const filterBox = (page: Page) => page.getByRole("searchbox", { name: "Filter assets", exact: true });
const levels = (page: Page) => page.getByRole("combobox", { name: "Show levels", exact: true });
/** The rows line of the live bar (the inert copy that holds its room while loading has no words). */
const line = (page: Page) => page.locator(".billing-page .billing-tools:not(.is-idle) .tools-count");
const monthLabel = (page: Page) => page.locator(".billing-page .month-label");
const twisty = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^(Collapse|Expand) ${esc(name)}, \\d+ rows? below$`) });
/** The row of the first asset with this name (`nth` for the repeated ones: Pod A, Row 1 ...). */
const rowOf = (page: Page, name: string, nth = 0) =>
  bodyRows(page).filter({ has: page.locator(".bill-label", { hasText: new RegExp(`^${esc(name)}$`) }) }).nth(nth);

const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const stored = (page: Page, key: string) => page.evaluate((k) => window.localStorage.getItem(k), key);
const num = (text: string | null) => Number((text ?? "").replace(/[~*,\s]/g, ""));
const rowsText = (n: number, total = TOTAL_ROWS) => `Showing ${n} of ${total} rows`;

interface Box { x: number; y: number; width: number; height: number }
async function boxOf(target: Locator, what: string): Promise<Box> {
  const box = await target.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  return box!;
}
function expectSame(got: Box, want: Box, what: string, tolerance = 0.5): void {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(got[key] - want[key]), `${what}: ${key} is ${got[key]}, it was ${want[key]}`).toBeLessThanOrEqual(tolerance);
  }
}
/**
 * How far the document is wider than its window: 0 or less means it does not scroll sideways. The Billing page keeps a scrollbar gutter (`html:has(.billing-page) { scrollbar-gutter: stable }`), and
 * headless Chromium paints no scrollbar, so the document is 15 px NARROWER than the window there (-15, nothing overflows): only a positive number is a sideways scroll.
 */
const pageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function openBilling(page: Page, url = "/billing"): Promise<void> {
  await page.goto(url);
  await expect(bodyRows(page).first()).toBeVisible();
  await expect(line(page)).toHaveText(/\S/);
}

/** What a row says in its Month total cell: the kWh above, the cost below. */
async function monthTotal(page: Page, index: number, name: string): Promise<{ kwh: number; cost: number }> {
  const row = bodyRows(page).nth(index);
  await expect(row.locator(".bill-label")).toHaveText(name);
  const [kwh, cost] = await row.locator("td").nth(1).locator("div").allTextContents();
  return { kwh: num(kwh), cost: num(cost) };
}

/** The Tab key from `from`, `presses` times; what has the focus after each press. */
async function tabPath(page: Page, from: Locator, presses: number): Promise<string[]> {
  await from.focus();
  const path: string[] = [];
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press("Tab");
    path.push(await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return "nothing";
      const tag = el.tagName.toLowerCase();
      return tag === "button" ? `button:${el.getAttribute("aria-label") ?? (el.textContent ?? "").trim()}` : tag === "input" ? `input:${el.getAttribute("type")}` : tag;
    }));
  }
  return path;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 0. The model

test("0. the model has the shape the cases rely on", () => {
  expect(TOTAL_ROWS).toBe(370);
  expect(rowsByLevelOf(NODES), "rows per level").toEqual([...ROWS_BY_LEVEL]);
  expect(NODES.map((n) => n.id), "ids run from 7,000 in tree pre-order").toEqual(NODES.map((_, i) => 7_000 + i));
  expect(NODES.filter((n) => n.name.startsWith("Rack 01")).map((n) => n.path), "'rack 01' matches the first rack of each hall").toEqual([
    "Site / Hall 1 / Pod A / Row 1 / Rack 01", "Site / Hall 2 / Pod A / Row 1 / Rack 01",
  ]);
  expect(LONG_NAME.length, "one name long enough to need the ellipsis").toBeGreaterThanOrEqual(60);

  const body = costsFor("2026-10");
  expect(body.days).toHaveLength(31);
  expect(body.days[0]).toBe("2026-10-01");
  expect(body.assets).toHaveLength(370);
  expect(body.closed).toBeNull();
  expect(costsFor("2026-02").days, "a month has the days it has").toHaveLength(28);
  const byId = new Map(body.assets.map((a) => [a.asset_id, a]));
  const free = body.assets.filter((a) => a.total === null);
  expect(free.map((a) => a.path), "one rack has no meter: days of nulls and no total").toEqual(["Site / Hall 1 / Pod A / Row 2 / Rack 20"]);
  expect(free[0].days.every((d) => d === null)).toBe(true);
  let estimated = 0;
  for (const asset of body.assets) {
    const kids = body.assets.filter((a) => a.parent_id === asset.asset_id);
    if (asset.parent_id !== null) expect(byId.has(asset.parent_id), `${asset.path}: the parent comes first`).toBe(true);
    for (const figure of [asset.total, ...asset.days]) {
      if (figure === null) continue;
      expect(figure.kwh * 2, `${asset.path}: a multiple of 0.5 kWh`).toBe(Math.round(figure.kwh * 2));
      expect(figure.cost, `${asset.path}: cost = kWh x 0.25`).toBe(figure.kwh * 0.25);
      if (figure.estimated) { estimated++; expect(asset.path.startsWith("Site / Hall 2") || asset.path === "Site", `${asset.path} is estimated`).toBe(true); }
    }
    if (asset.total !== null) expect(asset.total.kwh % 2, `${asset.path}: the month is a multiple of 2 kWh`).toBe(0);
    if (kids.length === 0) continue;
    const parts = kids.map((k) => k.total).filter((t) => t !== null);
    expect(asset.total?.kwh ?? null, `${asset.path}: the month is the sum of its children`).toBe(parts.length === 0 ? null : parts.reduce((a, t) => a + t.kwh, 0));
    expect(asset.total?.cost ?? null, `${asset.path}: so is its cost`).toBe(parts.length === 0 ? null : parts.reduce((a, t) => a + (t.cost ?? 0), 0));
    asset.days.forEach((day, d) => {
      const parts = kids.map((k) => k.days[d]).filter((t) => t !== null);
      expect(day?.kwh ?? null, `${asset.path}, day ${d + 1}`).toBe(parts.length === 0 ? null : parts.reduce((a, t) => a + t.kwh, 0));
    });
  }
  expect(estimated, "a handful of estimated figures, so the ~ mark is there").toBeGreaterThan(10);
  expect(costsFor("2026-10", { closed: true }).closed, "the closed body has the record").toMatchObject({ id: 1, note: expect.any(String) });
  expect(smallCostsFor("2026-10").assets.map((a) => a.name)).toEqual([...SMALL_NAMES]);
  expect(assetsList()).toHaveLength(370);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. Opens folded

test("1. a big month opens folded to the deepest level with at most 60 rows; a small month opens whole", async ({ page }) => {
  test.setTimeout(90_000);
  await prepare(page);
  await openBilling(page);
  await expect(line(page)).toHaveText("Showing 24 of 370 rows");
  await expect(bodyRows(page)).toHaveCount(24);
  const hidden = await bodyRows(page).evaluateAll((rows) => rows.filter((tr) => getComputedStyle(tr).display === "none" || (tr as HTMLElement).hidden).length);
  expect(hidden, "a folded row is not in the page, nothing is hidden with CSS").toBe(0);
  await expect(levels(page)).toHaveValue("4");
  expect(await labels(page).allTextContents(), "Site, the halls, Electrical, the pods and panels, the rows").toEqual(
    NODES.filter((n) => n.depth < 4).map((n) => n.name),
  );
  expect(await stored(page, FOLD_KEY), "a visit alone remembers nothing").toBeNull();

  await test.step("a month of five rows shows every row", async () => {
    const small = await page.context().newPage();
    await prepare(small, { small: true });
    await openBilling(small);
    await expect(line(small)).toHaveText("All 5 rows shown");
    await expect(bodyRows(small)).toHaveCount(5);
    expect(await labels(small).allTextContents()).toEqual([...SMALL_NAMES]);
    await expect(levels(small)).toHaveValue("all");
    await small.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. A twisty

test("2. a twisty folds and unfolds its branch, the focus stays on it, a folded row keeps its figures, and a parent is the sum of its children", async ({ page }) => {
  test.setTimeout(90_000);
  await prepare(page);
  await openBilling(page);
  const hall1 = nodeAt("Site / Hall 1");
  const toggle = twisty(page, "Hall 1");
  const label = await toggle.getAttribute("aria-label");
  expect(label, "the twisty names the rows below it").toBe(`Collapse Hall 1, ${belowOf(hall1)} rows below`);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const shown = NODES.filter((n) => n.depth < 4).length;
  const hiddenUnderHall1 = NODES.filter((n) => n.depth < 4 && n.path.startsWith("Site / Hall 1 / ")).length;
  await expect(bodyRows(page)).toHaveCount(shown);
  const cellsBefore = await rowOf(page, "Hall 1").locator("td").allTextContents();

  await toggle.focus();
  await toggle.evaluate((el) => { (window as unknown as { __twisty?: Element }).__twisty = el; });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAttribute("aria-label", `Expand Hall 1, ${belowOf(hall1)} rows below`);
  await expect(bodyRows(page), "Hall 1's rows leave the page").toHaveCount(shown - hiddenUnderHall1);
  expect(await page.evaluate(() => document.activeElement === (window as unknown as { __twisty?: Element }).__twisty), "the focus is still on the very same button").toBe(true);
  await expect(toggle).toBeFocused();
  expect(await rowOf(page, "Hall 1").locator("td").allTextContents(), "a folded row keeps its own figures").toEqual(cellsBefore);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(bodyRows(page)).toHaveCount(shown);
  await expect(toggle).toBeFocused();
  expect(await rowOf(page, "Hall 1").locator("td").allTextContents()).toEqual(cellsBefore);

  await btn(page, "Expand all").click();
  await expect(line(page)).toHaveText("All 370 rows shown");
  await expect(bodyRows(page)).toHaveCount(370);
  const total = await monthTotal(page, NODES.indexOf(hall1), "Hall 1");
  const pods = childrenOf(hall1);
  expect(pods.map((p) => p.name)).toEqual(["Pod A", "Pod B"]);
  let kwh = 0;
  let cost = 0;
  for (const pod of pods) {
    const part = await monthTotal(page, NODES.indexOf(pod), pod.name);
    kwh += part.kwh;
    cost += part.cost;
  }
  expect(total.kwh, "Hall 1's kWh is the sum of its pods'").toBe(kwh);
  expect(total.cost, "and so is its cost").toBe(cost);
  expect(total.kwh).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. Collapse all, Expand all, Show levels

test("3. Collapse all, Expand all and Show levels give the rows of the model, and a twisty after a level makes the select read Custom", async ({ page }) => {
  test.setTimeout(120_000);
  await prepare(page);
  await openBilling(page);

  await btn(page, "Collapse all").click();
  await expect(line(page)).toHaveText(rowsText(1));
  await expect(bodyRows(page)).toHaveCount(1);
  await expect(levels(page)).toHaveValue("1");
  await btn(page, "Expand all").click();
  await expect(line(page)).toHaveText("All 370 rows shown");
  await expect(bodyRows(page)).toHaveCount(370);
  await expect(levels(page)).toHaveValue("all");

  for (let level = 1; level <= 5; level++) {
    await levels(page).selectOption(String(level));
    await expect(line(page), `level ${level}`).toHaveText(rowsText(ROWS_BY_LEVEL[level - 1]));
    await expect(bodyRows(page), `level ${level}`).toHaveCount(ROWS_BY_LEVEL[level - 1]);
    await expect(levels(page)).toHaveValue(String(level));
  }
  await levels(page).selectOption("all");
  await expect(line(page)).toHaveText("All 370 rows shown");
  await expect(bodyRows(page)).toHaveCount(370);

  await test.step("a twisty after a level reads Custom, and nothing else changes until an option is chosen", async () => {
    await levels(page).selectOption("3");
    await expect(bodyRows(page)).toHaveCount(16);
    await page.getByRole("button", { name: /^Expand Pod A, \d+ rows? below$/ }).first().click();
    await expect(levels(page)).toHaveValue("custom");
    await expect(levels(page).locator("option:checked")).toHaveText("Custom");
    await expect(levels(page).locator("option[value=custom]")).toBeDisabled();
    await expect(bodyRows(page), "the pod's two rows are there; the rest stays as the level left it").toHaveCount(18);
    await expect(line(page)).toHaveText(rowsText(18));
    await settled(page);
    await expect(bodyRows(page)).toHaveCount(18);
    await levels(page).selectOption("3");
    await expect(bodyRows(page)).toHaveCount(16);
    await expect(levels(page)).toHaveValue("3");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. The filter

test("4. the filter shows the matches with their ancestors, locks the fold controls, and clearing brings the fold back", async ({ page }) => {
  test.setTimeout(120_000);
  await prepare(page);
  await openBilling(page);
  const matches = ["Site", "Hall 1", "Pod A", "Row 1", "Rack 01", "Hall 2", "Pod A", "Row 1", "Rack 01"];

  await test.step("rack 01: two matches, their ancestors, no twisty, the fold controls disabled", async () => {
    await filterBox(page).fill("rack 01");
    await expect(line(page)).toHaveText("2 of 370 rows match");
    await expect(bodyRows(page)).toHaveCount(matches.length);
    expect(await labels(page).allTextContents()).toEqual(matches);
    await expect(page.locator("table.billing tbody .bill-label.is-context"), "the ancestors read quieter than the matches").toHaveCount(7);
    await expect(page.locator("table.billing tbody .twisty"), "the arrows are decoration while a filter is on").toHaveCount(0);
    await expect(btn(page, "Collapse all")).toBeDisabled();
    await expect(btn(page, "Expand all")).toBeDisabled();
    await expect(levels(page)).toBeDisabled();
    await filterBox(page).press("Escape");
    await expect(filterBox(page)).toHaveValue("");
    await expect(filterBox(page), "the focus stays in the box").toBeFocused();
    await expect(line(page), "the fold of before is back").toHaveText("Showing 24 of 370 rows");
    await expect(bodyRows(page)).toHaveCount(24);
    await expect(btn(page, "Collapse all")).toBeEnabled();
  });

  await test.step("a branch folded before typing shows its match, and is folded again afterwards", async () => {
    await twisty(page, "Hall 1").click();
    await expect(line(page)).toHaveText("Showing 18 of 370 rows");
    await filterBox(page).fill("rack 01");
    await expect(line(page)).toHaveText("2 of 370 rows match");
    expect(await labels(page).allTextContents(), "Hall 1's rack is shown although Hall 1 is folded").toEqual(matches);
    await filterBox(page).press("Escape");
    await expect(line(page)).toHaveText("Showing 18 of 370 rows");
    await expect(twisty(page, "Hall 1")).toHaveAttribute("aria-expanded", "false");
    await twisty(page, "Hall 1").click();
    await expect(line(page)).toHaveText("Showing 24 of 370 rows");
  });

  await test.step("a filter that matches nothing", async () => {
    await filterBox(page).fill("zzz");
    await expect(line(page)).toHaveText("No rows match");
    await expect(bodyRows(page)).toHaveCount(1);
    await expect(bodyRows(page).first()).toHaveText('No assets match "zzz".');
    await expect(page.locator("table.billing tbody th")).toHaveCount(0);
  });

  await test.step("Clear filter clears and puts the focus in the box", async () => {
    await filterBox(page).fill("rack 01");
    await expect(line(page)).toHaveText("2 of 370 rows match");
    await btn(page, "Clear filter").click();
    await expect(filterBox(page)).toHaveValue("");
    await expect(filterBox(page)).toBeFocused();
    await expect(btn(page, "Clear filter")).toHaveCount(0);
    await expect(line(page)).toHaveText("Showing 24 of 370 rows");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. The keyboard

test("5. Tab visits the filter, Clear filter, Collapse all, Expand all, Show levels, the ? button and then the twisties; Enter and Space fold and unfold", async ({ page }) => {
  test.setTimeout(90_000);
  await prepare(page);
  await openBilling(page);
  const first = `button:Collapse Site, ${belowOf(nodeAt("Site"))} rows below`;

  expect(await tabPath(page, filterBox(page), 5), "no filter text: the three controls, the ? button, the first twisty").toEqual([
    "button:Collapse all", "button:Expand all", "select", "button:What does this mean?", first,
  ]);

  await filterBox(page).fill("rack 01");
  await expect(line(page)).toHaveText("2 of 370 rows match");
  expect(await tabPath(page, filterBox(page), 2), "with text: Clear filter, and the disabled controls are skipped").toEqual([
    "button:Clear filter", "button:What does this mean?",
  ]);
  await filterBox(page).fill("");
  await expect(line(page)).toHaveText("Showing 24 of 370 rows");

  const site = twisty(page, "Site");
  await site.focus();
  await page.keyboard.press("Enter");
  await expect(site).toHaveAttribute("aria-expanded", "false");
  await expect(bodyRows(page)).toHaveCount(1);
  await expect(site, "Enter folds and the focus stays on the twisty").toBeFocused();
  await page.keyboard.press("Space");
  await expect(site).toHaveAttribute("aria-expanded", "true");
  await expect(bodyRows(page)).toHaveCount(24);
  await expect(site, "Space unfolds and the focus stays on the twisty").toBeFocused();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 6. The header stays

/** Scrolls the table's box and reads where the header, the first column and the corner are, and what is on top there. */
async function stickyReading(page: Page) {
  return page.evaluate(() => new Promise<{
    scrollTop: number; scrollLeft: number; boxTop: number; boxLeft: number; headTop: number; headHit: boolean; cornerLeft: number; cornerHit: boolean;
    rowLeft: number; rowHit: boolean; rowFound: boolean; pageOver: number;
  }>((done) => {
    const box = document.querySelector(".billing-page .table-scroll") as HTMLElement;
    const heads = Array.from(box.querySelectorAll("table.billing thead th")) as HTMLElement[];
    const hit = (el: Element) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return at !== null && at.closest("th") === el;
    };
    box.scrollTop = 600;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const b = box.getBoundingClientRect();
      const headTop = heads[0].getBoundingClientRect().top;
      const headHit = hit(heads[1]); // the Rate header: in view whatever the sideways scroll
      const scrollTop = box.scrollTop;
      box.scrollLeft = 300;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const b2 = box.getBoundingClientRect();
        const headBottom = heads[0].getBoundingClientRect().bottom;
        const row = (Array.from(box.querySelectorAll("table.billing tbody th[scope=row]")) as HTMLElement[]).find((th) => {
          const r = th.getBoundingClientRect();
          return r.top >= headBottom + 2 && r.bottom <= b2.bottom - 2;
        });
        done({
          scrollTop, scrollLeft: box.scrollLeft, boxTop: b.top + box.clientTop, boxLeft: b2.left + box.clientLeft, headTop, headHit,
          cornerLeft: heads[0].getBoundingClientRect().left, cornerHit: hit(heads[0]),
          rowLeft: row ? row.getBoundingClientRect().left : -1, rowHit: row ? hit(row) : false, rowFound: row !== undefined,
          pageOver: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        });
      }));
    }));
  }));
}

test("6. the header row and the first column stay in view while the rows scroll, and the page never scrolls sideways", async ({ page }) => {
  test.setTimeout(150_000);
  await prepare(page);
  try {
    for (const { width, height, look, name } of [{ width: 1440, height: 900, look: LIGHT, name: "1440 x 900, light" }, { width: 1024, height: 768, look: DARK, name: "1024 x 768, dark" }]) {
      await test.step(name, async () => {
        await setLook(page, look);
        await page.setViewportSize({ width, height });
        await openBilling(page);
        await expect(html(page)).toHaveAttribute("data-theme", look.theme);
        await expect(html(page)).toHaveAttribute("data-mode", look.mode);
        await btn(page, "Expand all").click();
        await expect(line(page)).toHaveText("All 370 rows shown");
        await expect(bodyRows(page)).toHaveCount(370);
        const r = await stickyReading(page);
        expect(r.scrollTop, `${name}: the box scrolled`).toBeGreaterThan(500);
        expect(Math.abs(r.headTop - r.boxTop), `${name}: the first header row sits at the top of the box (${r.headTop} against ${r.boxTop})`).toBeLessThanOrEqual(1);
        expect(r.headHit, `${name}: a header cell is on top at its own centre`).toBe(true);
        expect(r.scrollLeft, `${name}: the box scrolled sideways`).toBeGreaterThan(100);
        expect(Math.abs(r.cornerLeft - r.boxLeft), `${name}: the first column sits at the left of the box (${r.cornerLeft} against ${r.boxLeft})`).toBeLessThanOrEqual(1);
        expect(r.rowFound, `${name}: a row header is in view`).toBe(true);
        expect(Math.abs(r.rowLeft - r.boxLeft), `${name}: a row header sits at the left of the box (${r.rowLeft} against ${r.boxLeft})`).toBeLessThanOrEqual(1);
        expect(r.rowHit, `${name}: the row header is on top at its own centre`).toBe(true);
        expect(r.cornerHit, `${name}: the corner is on top of both`).toBe(true);
        expect(r.pageOver, `${name}: the page does not scroll sideways`).toBeLessThanOrEqual(0);
      });
    }
    await test.step("800 x 600: no sideways scroll, the bar and the table are there", async () => {
      await setLook(page, LIGHT);
      await page.setViewportSize({ width: 800, height: 600 });
      await openBilling(page);
      expect(await pageOverflow(page), "the page does not scroll sideways").toBeLessThanOrEqual(0);
      await expect(page.locator(".billing-page .billing-tools:not(.is-idle)")).toBeVisible();
      await expect(filterBox(page)).toBeVisible();
      await expect(btn(page, "Collapse all")).toBeVisible();
      await expect(levels(page)).toBeVisible();
      await expect(page.locator("table.billing")).toBeVisible();
      await expect(page.locator("table.billing thead th").first()).toBeVisible();
      await btn(page, "Expand all").click();
      await expect(bodyRows(page)).toHaveCount(370);
      expect(await pageOverflow(page), "nor with every row open").toBeLessThanOrEqual(0);
    });
  } finally {
    await setLook(page, LIGHT);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 7. No layout shift

test("7. nothing above the table moves when the costs land or when a fold changes the rows", async ({ page }) => {
  test.setTimeout(90_000);
  const stub = await prepare(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  let release!: () => void;
  stub.gate = new Promise<void>((resolve) => { release = resolve; });
  const head = page.locator(".page-head");
  const bar = page.locator(".billing-bar");
  const wrap = (loaded: boolean) => page.locator(loaded ? ".billing-page table.billing" : ".billing-page .sk-table");
  const firstRow = (loaded: boolean) => (loaded ? bodyRows(page).first() : page.locator(".billing-page .sk-table tbody tr").first());
  try {
    await page.goto("/billing");
    await expect(page.getByRole("status").filter({ hasText: /^Loading billing$/ })).toBeVisible();
    await expect(bar).toBeVisible();
    await settled(page);
    const skeleton = { head: await boxOf(head, "the page head"), bar: await boxOf(bar, "the month bar"), row: await boxOf(firstRow(false), "the skeleton's first row"), wrap: await boxOf(wrap(false), "the skeleton's table") };

    stub.gate = null;
    release();
    await expect(bodyRows(page).first()).toBeVisible();
    await expect(page.locator(".billing-page .sk-table")).toHaveCount(0);
    await settled(page);
    expect(await page.locator(".billing-page .banner").count(), "no banner above the table in this month").toBe(0);
    const loaded = { head: await boxOf(head, "the page head"), bar: await boxOf(bar, "the month bar"), row: await boxOf(firstRow(true), "the first row"), wrap: await boxOf(wrap(true), "the table") };
    expectSame(loaded.head, skeleton.head, "the page head");
    expectSame(loaded.bar, skeleton.bar, "the month bar");
    expect(Math.abs(loaded.row.y - skeleton.row.y), `the first row: ${loaded.row.y} against the skeleton's ${skeleton.row.y}`).toBeLessThanOrEqual(2);
    expect(Math.abs(loaded.wrap.y - skeleton.wrap.y), `the table: ${loaded.wrap.y} against the skeleton's ${skeleton.wrap.y}`).toBeLessThanOrEqual(2);

    for (const action of ["Collapse all", "Expand all", "Collapse all"]) {
      await btn(page, action).click();
      await expect(line(page)).toHaveText(action === "Expand all" ? "All 370 rows shown" : rowsText(1));
      await settled(page);
      expectSame(await boxOf(head, "the page head"), loaded.head, `the page head after ${action}`);
      expectSame(await boxOf(bar, "the month bar"), loaded.bar, `the month bar after ${action}`);
    }
  } finally {
    release();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 8. The CSV

/** Folds Hall 1, filters, downloads the CSV and checks the one request it made: the month alone, nothing of the fold or the filter. A closed month does the same and keeps its banner. */
async function csvCase(page: Page, closed: boolean): Promise<void> {
  const stub = await prepare(page, { closed });
  await openBilling(page);
  if (closed) {
    await expect(page.locator(".billing-page .closed-box .banner")).toContainText("Closed by w17 spec");
    await expect(page.getByRole("button", { name: /^Reopen month/ })).toBeVisible();
  }
  await twisty(page, "Hall 1").click();
  await expect(line(page)).toHaveText("Showing 18 of 370 rows");
  await filterBox(page).fill("rack 0");
  await expect(page.locator("table.billing tbody .bill-label.is-context").first()).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), btn(page, "Download CSV").click()]);
  expect(download.suggestedFilename()).toBe("billing.csv");
  expect(stub.months.length).toBeGreaterThan(0);
  expect(stub.csv, "one request, the whole month").toEqual([`/api/billing/costs.csv?month=${stub.months[0]}`]);
  if (!closed) return;
  // the closed month folds and filters the same way, and its banner and Reopen button are still there
  await filterBox(page).fill("rack 01");
  await expect(line(page)).toHaveText("2 of 370 rows match");
  expect(await labels(page).allTextContents()).toEqual(["Site", "Hall 1", "Pod A", "Row 1", "Rack 01", "Hall 2", "Pod A", "Row 1", "Rack 01"]);
  await filterBox(page).fill("");
  await expect(line(page)).toHaveText("Showing 18 of 370 rows");
  await expect(page.locator(".billing-page .closed-box .banner")).toContainText("Closed by w17 spec");
  await expect(page.getByRole("button", { name: /^Reopen month/ })).toBeVisible();
  await expect(page.locator(".billing-page .chip.closed-chip")).toHaveText("Closed");
}

test("8a. the CSV request has no fold and no filter in it", async ({ page }) => {
  test.setTimeout(90_000);
  await csvCase(page, false);
});
test("8b. a closed month folds and filters the same way, keeps its banner and Reopen button, and its CSV request has the same shape", async ({ page }) => {
  test.setTimeout(90_000);
  await csvCase(page, true);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 9. Remembered

/** The origin the same stack answers on under the other name (127.0.0.1 against localhost): another browser origin, so another storage and another cookie jar. */
function otherOrigin(): string {
  const url = new URL(BASE_URL);
  url.hostname = url.hostname === "localhost" ? "127.0.0.1" : "localhost";
  url.pathname = "/";
  return url.origin;
}

test("9. the fold is remembered in this browser and for this address: a reload, Previous month, a fresh browser, another origin", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const stub = await prepare(page);
  await openBilling(page);
  await expect(line(page)).toHaveText("Showing 24 of 370 rows");
  expect(await stored(page, FOLD_KEY), "a visit alone remembers nothing").toBeNull();

  await test.step("a fold survives a reload", async () => {
    await twisty(page, "Hall 1").click();
    await expect(line(page)).toHaveText("Showing 18 of 370 rows");
    expect(await stored(page, FOLD_KEY), "the fold is stored once the person has changed it").not.toBeNull();
    await page.reload();
    await expect(bodyRows(page).first()).toBeVisible();
    await expect(line(page)).toHaveText("Showing 18 of 370 rows");
    await expect(twisty(page, "Hall 1")).toHaveAttribute("aria-expanded", "false");
  });

  await test.step("Previous month keeps the fold and the filter text", async () => {
    const was = await monthLabel(page).textContent();
    await btn(page, "Previous month").click();
    await expect(monthLabel(page)).not.toHaveText(was!);
    await expect(line(page)).toHaveText("Showing 18 of 370 rows");
    await filterBox(page).fill("rack 01");
    await expect(line(page)).toHaveText("2 of 370 rows match");
    const now = await monthLabel(page).textContent();
    await btn(page, "Previous month").click();
    await expect(monthLabel(page)).not.toHaveText(now!);
    await expect(filterBox(page)).toHaveValue("rack 01");
    await expect(line(page)).toHaveText("2 of 370 rows match");
    expect(stub.months.length, "the page asked for the earlier months").toBeGreaterThanOrEqual(3);
    await filterBox(page).fill("");
    await expect(line(page)).toHaveText("Showing 18 of 370 rows");
  });

  await test.step("Expand all is remembered as none", async () => {
    await btn(page, "Expand all").click();
    await expect(line(page)).toHaveText("All 370 rows shown");
    expect(await stored(page, FOLD_KEY)).toBe("none");
    await page.reload();
    await expect(bodyRows(page).first()).toBeVisible();
    await expect(line(page)).toHaveText("All 370 rows shown");
    await expect(bodyRows(page)).toHaveCount(370);
  });

  await test.step("a fresh browser starts with the default", async () => {
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 } });
    try {
      const fresh = await context.newPage();
      await prepare(fresh);
      await openBilling(fresh);
      await expect(line(fresh)).toHaveText("Showing 24 of 370 rows");
      await expect(bodyRows(fresh)).toHaveCount(24);
    } finally {
      await context.close();
    }
  });

  await test.step("the same page on another origin starts with the default too", async () => {
    const other = otherOrigin();
    const login = await page.request.post(`${other}/api/login`, { data: ADMIN });
    expect(login.ok(), `signing in on ${other}: ${login.status()} ${await login.text()}`).toBe(true);
    await openBilling(page, `${other}/billing`);
    await expect(line(page)).toHaveText("Showing 24 of 370 rows");
    await expect(bodyRows(page)).toHaveCount(24);
    expect(await stored(page, FOLD_KEY), "the other address remembers nothing of the first").toBeNull();
    await openBilling(page, "/billing");
    await expect(line(page), "and the first still remembers its own").toHaveText("All 370 rows shown");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 10. The Assets Tree

const treeLinks = (page: Page) => page.locator(".tree-col ul.tree .node > a:visible");

test("10a. the Assets Tree of 370 assets opens at level 2 with nothing stored, and a deep asset unfolds only its way and is scrolled into view", async ({ page }) => {
  test.setTimeout(120_000);
  const stub = await prepare(page, { assets: true });
  stub.lenient = true; // the stack has no asset 7,0xx: its detail answers are 404
  await page.setViewportSize({ width: 1440, height: 640 });

  await test.step("/assets: levels 1 and 2 only", async () => {
    await page.goto("/assets");
    await expect(treeLinks(page)).toHaveCount(4);
    expect(await treeLinks(page).allTextContents()).toEqual(["Site", "Hall 1", "Hall 2", "Electrical"]);
    expect(await stored(page, TREE_KEY), "a visit alone remembers nothing").toBeNull();
  });

  await test.step("/assets/<a rack of Hall 2>: only its way is open, and its row is inside the tree's box", async () => {
    const rack = nodeAt("Site / Hall 2 / Pod B / Row 4 / Rack 58");
    const way = new Set(NODES.filter((n) => rack.path.startsWith(`${n.path} / `)).map((n) => n.id)); // the ancestors, not the rack itself
    const wanted = NODES.filter((n) => n.depth < 2 || (n.parent_id !== null && way.has(n.parent_id)));
    await page.goto(`/assets/${rack.id}`);
    await expect(treeLinks(page)).toHaveCount(wanted.length);
    expect(await treeLinks(page).allTextContents(), "levels 1 and 2, and the children of each ancestor").toEqual(wanted.map((n) => n.name));
    await expect(page.locator(".tree-col .node.is-selected")).toBeVisible();
    // The scroll happens in an effect after the way has unfolded, so the row is waited for; the window is short enough that the 22 rows overflow the box, so the scroll has to have happened.
    const inside = () => page.evaluate(() => {
      const b = (document.querySelector(".tree-col .tree-scroll") as HTMLElement).getBoundingClientRect();
      const r = (document.querySelector(".tree-col .node.is-selected") as HTMLElement).getBoundingClientRect();
      return r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5;
    });
    await expect.poll(inside, { message: "the selected row lies inside the tree's box" }).toBe(true);
    const box = await page.evaluate(() => {
      const el = document.querySelector(".tree-col .tree-scroll") as HTMLElement;
      return { overflows: el.scrollHeight > el.clientHeight, scrollTop: el.scrollTop };
    });
    expect(box.overflows, "the unfolded rows are taller than the box").toBe(true);
    expect(box.scrollTop, "so the box was scrolled to the row").toBeGreaterThan(0);
  });
});

test("10b. the remembered tree: none opens it fully, the empty list the old code wrote opens it folded like nothing", async ({ page }) => {
  test.setTimeout(120_000);
  const stub = await prepare(page, { assets: true });
  stub.lenient = true;
  await page.addInitScript((key) => window.localStorage.setItem(key, "none"), TREE_KEY);
  await page.goto("/assets");
  await expect(treeLinks(page)).toHaveCount(TOTAL_ROWS);

  await page.addInitScript((key) => window.localStorage.setItem(key, "[]"), TREE_KEY); // runs after the first one: the text of the old writer
  await page.goto("/assets");
  await expect(treeLinks(page)).toHaveCount(4);
  expect(await treeLinks(page).allTextContents()).toEqual(["Site", "Hall 1", "Hall 2", "Electrical"]);
});
