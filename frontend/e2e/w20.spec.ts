import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { costsFor, TOTAL_ROWS, type ApiCosts } from "./billingModel";

// W20 (the Billing toolbar): the month group (Previous month, the month, Next month, Year, Month) and the table group (the filter box, Collapse all, Expand all, Show levels with its ?) share
// ONE row when the page is wide and stack when it is not; the "Showing N of M rows" line is in the table's caption. Admin `admin` / `correct-horse`, as in the earlier projects.
//
// IT WRITES NOTHING and needs nothing from the stack beyond the sign-in, the site's time zone and the look preference. GET /api/billing/costs and /months are answered through page.route from
// e2e/billingModel.ts (the pilot hall: 370 rows; an open month, a closed month, one missing rate, the two empty answers); any other write the page tries is refused with a 500 and fails the
// case. Every case stores its own look (PUT /api/me/preferences) before the page opens, and afterAll puts it back to Light and Navy and gold, also after a failed case. The words of the page
// are written here again (src/lib/billingRows.ts). Names are matched by SUBSTRING, so buttons and the Year and Month selects are looked up with `exact: true`.
//
// The toolbar switches on the width of `.billing-main` (the page's size container: the window minus a constant while the sidebar is open, which case 3 reads, not assumes).
//   1   one row at 1920 x 1080, light and dark: one centre line, a gap of 16 px, one control (34 px) tall, the table group on one line, the eight controls 34 px high, no sideways scroll.
//   2   stacked at 1860 x 1000 (just under the threshold), 1440, 1280, 1024 and 800: 16 px between the groups, nothing overlaps or leaves the page, the rows line is right of the sentence.
//   3   the threshold: a container 1583 px wide stacks, 1585 px shares one row of 34 px (not 76), 1583 stacks again.
//   4   no layout shift, at 1920 and 1440: held costs against landed costs, Collapse all, Expand all, a filter, paging a month (held and landed) move the toolbar by nothing.
//   5   Tab order, at 1920 and 1440: the month group, then the table group (Next month is disabled on the current month, so it comes second only after one click on Previous month).
//   6   the rows line, at 1920 and 1440: in the caption, polite, no role; at the box's right edge at every sideways scroll; out of view when scrolled down (accepted) and back in view after a new
//       filter; the caption keeps 38 px, the toolbar stays, the table is named by the sentence only.
//   7   an open, a closed and a missing-rate month, light and dark: toolbar, banner, table in that order, the table box ends 0 to 40 px inside a 1080 px window; the two empty answers keep the
//       toolbar with its idle copy and its height.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";

interface Look { mode: "light" | "dark"; theme: string }
const LIGHT: Look = { mode: "light", theme: "navy-gold" };
const DARK: Look = { mode: "dark", theme: "desert-gold" };

const CTL_H = 34; // `--ctl-h`
const GAP = 16; // the toolbar's gap
const CAPTION_H = 38; // 10 + 18 + 10 of padding and line, with the border
const ALL = `All ${TOTAL_ROWS} rows shown`;
const FILTERED = `2 of ${TOTAL_ROWS} rows match`;
const SENTENCE = /^Each cell shows kWh above and cost in USD below\.$/;
/** The windows of the cases that run both layouts. */
const WIDE_AND_STACKED: readonly (readonly [number, number])[] = [[1920, 1080], [1440, 900]];

interface Box { x: number; y: number; width: number; height: number }

// ---------------------------------------------------------------------------------------------------------------------------------
// The look and the mock

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

interface Stub {
  stray: string[]; // the writes the spec does not expect (the page got a 500 for each)
  gate: Promise<void> | null; // while set, the costs request waits for it
}
const stubs: Stub[] = [];

test.afterEach(() => {
  for (const stub of stubs.splice(0)) expect(stub.stray, "the spec writes nothing to the stack: these requests were refused").toEqual([]);
});

interface Opening {
  look?: Look; // default light
  closed?: boolean; // every month the page asks for is a closed one
  missingRate?: boolean; // one row has kWh but no cost: the missing-rate banner
  empty?: "none" | "nodata"; // no assets at all ("No assets yet."), or assets without one figure ("No energy data for this month.")
}

/** What GET /api/billing/costs answers for a month. */
function monthBody(month: string, opening: Opening): ApiCosts {
  const body = costsFor(month, { closed: opening.closed === true });
  if (body.closed) body.closed = { ...body.closed, closed_name: "w20 spec", note: "Closed for the w20 toolbar guard." };
  if (opening.empty === "none") return { ...body, assets: [] };
  if (opening.empty === "nodata") return { ...body, assets: body.assets.map((a) => ({ ...a, total: null })) };
  if (opening.missingRate) {
    const [site, ...rest] = body.assets;
    return { ...body, assets: [{ ...site, total: { ...site.total!, cost: null, partial: false } }, ...rest] };
  }
  return body;
}

/** Answers the Billing routes of the case from the model, refuses every other write, signs in and stores the look. */
async function prepare(page: Page, opening: Opening = {}): Promise<Stub> {
  const stub: Stub = { stray: [], gate: null };
  stubs.push(stub);
  // Registered FIRST, so it is asked last: a write that is not the sign-in or the look's save is refused and written down.
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    if (method === "GET" || method === "HEAD") return route.fallback();
    if (path === "/api/login" || (method === "PUT" && path === "/api/me/preferences")) return route.fallback();
    stub.stray.push(`${method} ${path}`);
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "w20: this spec writes nothing" }) });
  });
  await page.route((url) => url.pathname === "/api/billing/costs", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (stub.gate) await stub.gate;
    const body = JSON.stringify(monthBody(new URL(route.request().url()).searchParams.get("month") ?? "", opening));
    await route.fulfill({ status: 200, contentType: "application/json", body }).catch(() => undefined); // the page may be gone by now
  });
  await page.route((url) => url.pathname === "/api/billing/months", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const now = new Date();
    const first = `${now.getUTCFullYear() - 1}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`; // a year back, so Previous month has somewhere to go
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ first_month: first }) }).catch(() => undefined);
  });
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in: ${login.status()} ${await login.text()}`).toBe(true);
  const look = opening.look ?? LIGHT;
  const saved = await page.request.put("/api/me/preferences", { data: look });
  expect(saved.ok(), `storing ${JSON.stringify(look)}: ${saved.status()} ${await saved.text()}`).toBe(true);
  return stub;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Locators and readings

const btn = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const filterBox = (page: Page) => page.getByRole("searchbox", { name: "Filter assets", exact: true });
const levels = (page: Page) => page.getByRole("combobox", { name: "Show levels", exact: true });
const bodyRows = (page: Page) => page.locator("table.billing tbody tr");
const toolbar = (page: Page) => page.locator(".billing-page .billing-toolbar");
const liveTools = (page: Page) => page.locator(".billing-page .billing-toolbar > .billing-tools:not(.is-idle)");
const idleTools = (page: Page) => page.locator(".billing-page .billing-toolbar > .billing-tools.is-idle");
const monthLabel = (page: Page) => page.locator(".billing-page .month-label");
const caption = (page: Page) => page.locator(".billing-page table.billing caption");
/** The rows line, in the table's caption. */
const line = (page: Page) => page.locator(".billing-page table.billing caption .tools-count");
const scrollBox = (page: Page) => page.locator(".billing-page .table-scroll");

const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** The box of an element as the layout has it (also for `visibility: hidden`, the idle copy of the controls bar). */
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
const near = (got: number, want: number, what: string, tolerance = 1) => expect(Math.abs(got - want), `${what}: ${got}, expected ${want} (within ${tolerance})`).toBeLessThanOrEqual(tolerance);

/** Opens the current month (the sign-in has happened) and waits until the rows and the live controls are there and the page has stopped moving. */
async function openBilling(page: Page): Promise<void> {
  await page.goto("/billing");
  await expect(bodyRows(page).first()).toBeVisible();
  await expect(line(page)).toHaveText(/\S/);
  await expect(idleTools(page)).toHaveCount(0);
  await expect(page.locator(".sk-region")).toHaveCount(0);
  await expect(page.locator(".navbar .live")).toBeVisible();
  await settled(page);
}

interface Layout {
  main: Box; head: Box; toolbar: Box; bar: Box; tools: Box; barKids: Box[]; kids: Box[]; box: Box | null;
  /** How far the document is wider than its window; headless Chromium paints no scrollbar, so only a positive number is a sideways scroll. */
  overflow: number;
}

/** Every box of the toolbar and what is around it, read in one go. */
function layoutOf(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const rect = (el: Element): Box => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const one = (selector: string): Element => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`w20: nothing matches ${selector}`);
      return el;
    };
    const bar = one(".billing-page .billing-toolbar > .billing-bar");
    const tools = one(".billing-page .billing-toolbar > .billing-tools");
    const box = document.querySelector(".billing-page .table-scroll");
    return {
      main: rect(one(".billing-page .billing-main")), head: rect(one(".billing-page .page-head")), toolbar: rect(one(".billing-page .billing-toolbar")),
      bar: rect(bar), tools: rect(tools), barKids: Array.from(bar.children, rect), kids: Array.from(tools.children, rect), box: box ? rect(box) : null,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

const middle = (b: Box) => b.y + b.height / 2;
const apart = (a: Box, b: Box) => a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5;

/** Everything the layouts share: nothing leaves the page's own width, nothing scrolls the page sideways. */
function expectContained(at: Layout, where: string): void {
  for (const [what, box] of [["the month bar", at.bar], ["the table controls", at.tools], ...at.barKids.map((k, i) => [`month control ${i + 1}`, k] as const), ...at.kids.map((k, i) => [`table control ${i + 1}`, k] as const)] as const) {
    expect(box.x, `${where}: ${what} starts inside the page (${box.x} against ${at.main.x})`).toBeGreaterThanOrEqual(at.main.x - 1);
    expect(box.x + box.width, `${where}: ${what} ends inside the page (${box.x + box.width} against ${at.main.x + at.main.width})`).toBeLessThanOrEqual(at.main.x + at.main.width + 1);
  }
  expect(at.overflow, `${where}: the page does not scroll sideways`).toBeLessThanOrEqual(0);
}

/** One row: the same centre line, a gap of 16 px, one control tall, the table group on one line. */
function expectOneRow(at: Layout, where: string): void {
  near(middle(at.bar), middle(at.tools), `${where}: the centre lines of the month group and the table group`);
  expect(at.tools.x, `${where}: the table group starts 16 px after the month group`).toBeGreaterThanOrEqual(at.bar.x + at.bar.width + GAP - 1);
  near(at.toolbar.height, CTL_H, `${where}: the toolbar is one control tall`);
  for (const kid of at.kids) near(kid.y, at.kids[0].y, `${where}: the table group is one line (tops)`);
  expectContained(at, where);
}

/** Stacked: the table group under the month group (16 px), two controls tall at least, no two blocks overlap. */
function expectStacked(at: Layout, where: string): void {
  expect(at.tools.y, `${where}: the table group is 16 px under the month group`).toBeGreaterThanOrEqual(at.bar.y + at.bar.height + GAP - 1);
  expect(at.toolbar.height, `${where}: the toolbar is two controls and a gap tall at least`).toBeGreaterThanOrEqual(2 * CTL_H + GAP - 1);
  const blocks = [["the page header", at.head], ["the month bar", at.bar], ["the table controls", at.tools], ...(at.box ? [["the table", at.box] as const] : [])] as const;
  blocks.forEach(([nameA, a], i) => blocks.slice(i + 1).forEach(([nameB, b]) => expect(apart(a, b), `${where}: ${nameA} and ${nameB} do not overlap`).toBe(true)));
  expectContained(at, where);
}

/** Which of the selectors are out of order, in the document or on the page (each starts under the end of the one before). */
function inOrder(page: Page, selectors: string[]): Promise<string[]> {
  return page.evaluate((list) => {
    const problems: string[] = [];
    list.forEach((selector, i) => {
      const el = document.querySelector(selector);
      const before = i === 0 ? null : document.querySelector(list[i - 1]);
      if (!el) problems.push(`nothing matches ${selector}`);
      else if (before) {
        if (!(before.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) problems.push(`${selector} is not after ${list[i - 1]} in the document`);
        if (el.getBoundingClientRect().top < before.getBoundingClientRect().bottom - 1) problems.push(`${selector} starts above the end of ${list[i - 1]}`);
      }
    });
    return problems;
  }, selectors);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. One row

for (const look of [LIGHT, DARK]) {
  test(`1. at 1920 x 1080 the month group and the table group share one row, ${look.mode}`, async ({ page }) => {
    await prepare(page, { look });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await openBilling(page);
    expectOneRow(await layoutOf(page), "1920 x 1080");
    const controls: [string, Locator][] = [
      ["Previous month", btn(page, "Previous month")], ["Next month", btn(page, "Next month")], ["Year", page.getByLabel("Year", { exact: true })], ["Month", page.getByLabel("Month", { exact: true })],
      ["the filter box", filterBox(page)], ["Collapse all", btn(page, "Collapse all")], ["Expand all", btn(page, "Expand all")], ["Show levels", levels(page)],
    ];
    for (const [name, control] of controls) near((await boxOf(control, name)).height, CTL_H, `${name} is one control tall`);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. Stacked

const STACKED: readonly (readonly [number, number])[] = [[1860, 1000], [1440, 900], [1280, 800], [1024, 768], [800, 600]];

for (const [width, height] of STACKED) {
  test(`2. at ${width} x ${height} the table group is under the month group and the rows line is right of the sentence`, async ({ page }) => {
    await prepare(page);
    await page.setViewportSize({ width, height });
    await openBilling(page);
    const at = await layoutOf(page);
    expectStacked(at, `${width} x ${height}`);
    // The rows line lies inside the caption inside the table's box: right of the sentence at scrollLeft 0, and not past the box.
    const sentence = await boxOf(page.locator(".billing-page table.billing caption .cap-text"), "the how-to-read sentence");
    const count = await boxOf(line(page), "the rows line");
    expect(count.x, `the rows line (${count.x}) starts after the sentence ends (${sentence.x + sentence.width})`).toBeGreaterThanOrEqual(sentence.x + sentence.width - 1);
    expect(count.x + count.width, "and ends inside the table's box").toBeLessThanOrEqual(at.box!.x + at.box!.width + 1);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. The threshold

/** Resizes the window until `.billing-main` is `target` px wide; the sidebar is open at these widths, so it is the window minus a constant, which is read here, not assumed. */
async function fitContainer(page: Page, target: number): Promise<void> {
  const main = page.locator(".billing-page .billing-main");
  let wide = 0;
  for (let tries = 0; tries < 4; tries++) {
    wide = (await boxOf(main, "the page's size container")).width;
    if (Math.abs(wide - target) < 0.5) return;
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.width + Math.round(target - wide), height: size.height });
    await settled(page);
  }
  throw new Error(`w20: could not make the page's size container ${target} px wide (it is ${wide})`);
}

test("3. a page 1583 px wide stacks, 1585 px shares one row on one line, and 1583 stacks again", async ({ page }) => {
  await prepare(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openBilling(page);
  const threshold = await page.evaluate(() => 99 * parseFloat(getComputedStyle(document.documentElement).fontSize)); // 99rem
  for (const [width, row] of [[threshold - 1, false], [threshold + 1, true], [threshold - 1, false]] as const) {
    await fitContainer(page, width);
    const at = await layoutOf(page);
    expect(at.main.width, "the container is the width asked for").toBeCloseTo(width, 0);
    if (row) expectOneRow(at, `${width} px`);
    else expectStacked(at, `${width} px`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. No layout shift

for (const [width, height] of WIDE_AND_STACKED) {
  test(`4. at ${width} the toolbar does not move when the costs land, when a fold or a filter changes the rows or when the month changes`, async ({ page }) => {
    test.setTimeout(90_000);
    const stub = await prepare(page);
    await page.setViewportSize({ width, height });
    let release!: () => void;
    stub.gate = new Promise<void>((resolve) => { release = resolve; });
    const rects = async () => { const at = await layoutOf(page); return { toolbar: at.toolbar, bar: at.bar, tools: at.tools }; };
    const same = async (want: Awaited<ReturnType<typeof rects>>, after: string) => {
      await settled(page);
      const got = await rects();
      for (const key of ["toolbar", "bar", "tools"] as const) expectSame(got[key], want[key], `the ${key} ${after}`);
    };
    try {
      await page.goto("/billing");
      await expect(page.getByRole("status").filter({ hasText: /^Loading billing$/ })).toBeVisible();
      await expect(btn(page, "Previous month")).toBeEnabled(); // the month list is in: the selects have their final options
      await expect(idleTools(page)).toHaveCount(1);
      await settled(page);
      const held = await rects();

      stub.gate = null;
      release();
      await expect(bodyRows(page).first()).toBeVisible();
      await expect(idleTools(page)).toHaveCount(0);
      await same(held, "once the costs have landed");

      for (const [action, text] of [["Collapse all", "Showing 1 of 370 rows"], ["Expand all", ALL]] as const) {
        await btn(page, action).click();
        await expect(line(page)).toHaveText(text);
        await same(held, `after ${action}`);
      }
      await filterBox(page).fill("rack 01");
      await expect(line(page)).toHaveText(FILTERED);
      await same(held, "with a filter");
      await filterBox(page).fill("");
      await expect(line(page)).toHaveText(ALL);
      await same(held, "with the filter cleared");

      // Paging: the new month's costs are held first (the table is gone or old, the controls idle or live), then they land.
      const label = await monthLabel(page).textContent();
      stub.gate = new Promise<void>((resolve) => { release = resolve; });
      await btn(page, "Previous month").click();
      await expect(monthLabel(page)).not.toHaveText(label ?? "");
      await same(held, "while the previous month's costs are held");
      stub.gate = null;
      release();
      await expect(line(page)).toHaveText(ALL);
      await expect(idleTools(page)).toHaveCount(0);
      await same(held, "once the previous month has landed");
    } finally {
      release();
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. The keyboard

/** The Tab key from `from`, `presses` times; what has the focus after each press (the tag and its name). */
async function tabPath(page: Page, from: Locator, presses: number): Promise<string[]> {
  await from.focus();
  const path: string[] = [];
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press("Tab");
    path.push(await page.evaluate(() => {
      const el = document.activeElement as (HTMLElement & { labels?: NodeListOf<HTMLLabelElement> }) | null;
      if (!el) return "nothing";
      return `${el.tagName.toLowerCase()}:${(el.getAttribute("aria-label") ?? el.labels?.[0]?.textContent ?? el.textContent ?? "").trim()}`;
    }));
  }
  return path;
}

for (const [width, height] of WIDE_AND_STACKED) {
  test(`5. at ${width} Tab walks the month group, then the table group`, async ({ page }) => {
    await prepare(page);
    await page.setViewportSize({ width, height });
    await openBilling(page);
    const tableGroup = ["input:Filter assets", "button:Collapse all", "button:Expand all", "select:Show levels", "button:What does this mean?"];
    // The mock opens the current month, where Next month is natively disabled, so Tab skips it.
    await expect(btn(page, "Next month")).toBeDisabled();
    expect(await tabPath(page, btn(page, "Previous month"), 7), "the current month: Next month is skipped").toEqual(["select:Year", "select:Month", ...tableGroup]);

    const label = await monthLabel(page).textContent();
    await btn(page, "Previous month").click();
    await expect(monthLabel(page)).not.toHaveText(label ?? "");
    await expect(line(page)).toHaveText(/\S/);
    await expect(idleTools(page)).toHaveCount(0);
    await settled(page);
    await expect(btn(page, "Next month")).toBeEnabled();
    expect(await tabPath(page, btn(page, "Previous month"), 8), "an earlier month: Next month comes second").toEqual(["button:Next month", "select:Year", "select:Month", ...tableGroup]);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 6. The rows line

/** Where the rows line is against the table's box (the box's right edge less its border, its scrollbar and the sticky 14 px). */
function lineReading(page: Page) {
  return page.evaluate(() => {
    const box = document.querySelector(".billing-page .table-scroll") as HTMLElement;
    const count = document.querySelector(".billing-page table.billing caption .tools-count") as HTMLElement;
    const b = box.getBoundingClientRect();
    const c = count.getBoundingClientRect();
    return {
      scrollLeft: box.scrollLeft, scrollTop: box.scrollTop, right: c.right, left: c.left, top: c.top, bottom: c.bottom,
      wantRight: b.left + box.clientLeft + box.clientWidth - 14, boxLeft: b.left + box.clientLeft, boxTop: b.top + box.clientTop, boxBottom: b.top + box.clientTop + box.clientHeight,
    };
  });
}

for (const [width, height] of WIDE_AND_STACKED) {
  test(`6. at ${width} the rows line is a live region in the caption and stays at the right edge of the table box`, async ({ page }) => {
    test.setTimeout(90_000);
    await prepare(page);
    await page.setViewportSize({ width, height });
    await openBilling(page);
    const count = line(page);
    const scroller = scrollBox(page);
    const table = page.getByRole("table", { name: SENTENCE });
    await expect(count).toHaveText(`Showing 24 of ${TOTAL_ROWS} rows`);
    await expect(count, "a polite live region").toHaveAttribute("aria-live", "polite");
    expect(await count.getAttribute("role"), "with no role").toBeNull();
    await expect(table, "the table is named by the how-to-read sentence only").toHaveCount(1);
    const barBefore = await boxOf(toolbar(page), "the toolbar");
    near((await boxOf(caption(page), "the caption")).height, CAPTION_H, "the caption's height");

    await test.step("the right edge follows the box's right edge at every sideways scroll", async () => {
      const maxLeft = await scroller.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(maxLeft, "the table is wider than its box").toBeGreaterThan(100);
      for (const left of [0, 600, maxLeft]) {
        await scroller.evaluate((el, x) => { el.scrollLeft = x; }, left);
        await settled(page);
        const at = await lineReading(page);
        near(at.scrollLeft, left, "the box scrolled sideways", 1);
        near(at.right, at.wantRight, `scrollLeft ${left}: the rows line's right edge against the box's`, 2);
        expect(at.left, `scrollLeft ${left}: the rows line starts inside the box`).toBeGreaterThanOrEqual(at.boxLeft);
      }
    });

    await test.step("scrolled down it is out of view (accepted), and a new filter brings the box back to the top", async () => {
      await scroller.evaluate((el) => { el.scrollLeft = 0; el.scrollTop = 300; });
      await settled(page);
      const down = await lineReading(page);
      expect(down.scrollTop, "the box scrolled down").toBeGreaterThan(250);
      expect(down.bottom, "the rows line scrolled out above the box").toBeLessThanOrEqual(down.boxTop + 1);

      await filterBox(page).fill("rack 01");
      await expect(count).toHaveText(FILTERED);
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop), { message: "a new filter scrolls the box back to the top" }).toBe(0);
      await settled(page);
      const back = await lineReading(page);
      expect(back.top, "the rows line is in view again").toBeGreaterThanOrEqual(back.boxTop - 1);
      expect(back.bottom).toBeLessThanOrEqual(back.boxBottom + 1);
      near(back.right, back.wantRight, "and at the right edge", 2);
      near((await boxOf(caption(page), "the caption")).height, CAPTION_H, "the caption's height after the filter");
      expectSame(await boxOf(toolbar(page), "the toolbar"), barBefore, "the toolbar after the filter");
      await expect(table, "the table is still named by the sentence only").toHaveCount(1);
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 7. A closed month, a missing rate, the empty answers

const VARIANTS: readonly { name: string; opening: Opening; between: string[] }[] = [
  { name: "an open month", opening: {}, between: [] },
  { name: "a closed month", opening: { closed: true }, between: [".billing-page .closed-box"] },
  { name: "a month with a missing rate", opening: { missingRate: true }, between: [".billing-page .banner-warn"] },
];

for (const look of [LIGHT, DARK]) {
  for (const variant of VARIANTS) {
    test(`7. ${variant.name}, ${look.mode}: the toolbar comes first, then the banner, then the table, which ends inside the window`, async ({ page }) => {
      await prepare(page, { ...variant.opening, look });
      await page.setViewportSize({ width: 1920, height: 1080 });
      await openBilling(page);
      const order = [".billing-page .page-head", ".billing-page .billing-toolbar", ...variant.between, ".billing-page .table-scroll"];
      const wide = await layoutOf(page);
      expectOneRow(wide, "1920 x 1080");
      expect(await inOrder(page, order), "1920 x 1080: the order of the blocks").toEqual([]);
      const bottom = wide.box!.y + wide.box!.height;
      expect(bottom, `the table box ends ${1080 - bottom} px inside the window, 0 to 40 wanted`).toBeGreaterThanOrEqual(1080 - 40);
      expect(bottom).toBeLessThanOrEqual(1080);

      await page.setViewportSize({ width: 1440, height: 900 });
      await settled(page);
      expectStacked(await layoutOf(page), "1440 x 900");
      expect(await inOrder(page, order), "1440 x 900: the order of the blocks").toEqual([]);
    });
  }
}

const EMPTIES = [
  { text: "No assets yet.", opening: { empty: "none", look: LIGHT } },
  { text: "No energy data for this month.", opening: { empty: "nodata", look: DARK } },
] as const satisfies readonly { text: string; opening: Opening }[];

for (const empty of EMPTIES) {
  test(`7. "${empty.text}" keeps the toolbar, with the idle copy of the table controls, at the height it has with rows`, async ({ page }) => {
    await prepare(page, empty.opening);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/billing");
    await expect(page.locator(".billing-page .empty")).toContainText(empty.text);
    await expect(page.locator(".navbar .live")).toBeVisible();
    await expect(idleTools(page), "the table controls are the idle copy").toHaveCount(1);
    await expect(idleTools(page)).toHaveAttribute("aria-hidden", "true");
    await expect(liveTools(page)).toHaveCount(0);
    await expect(page.locator("table.billing")).toHaveCount(0);
    for (const [width, height, tall] of [[1920, 1080, CTL_H], [1440, 900, 2 * CTL_H + GAP]] as const) {
      await page.setViewportSize({ width, height });
      await settled(page);
      const at = await layoutOf(page);
      near(at.toolbar.height, tall, `${width}: the toolbar's height`);
      if (width === 1920) expectOneRow(at, `${width}`);
      else expectStacked(at, `${width}`);
      expect(await inOrder(page, [".billing-page .billing-toolbar", ".billing-page .empty"]), `${width}: the toolbar comes before the answer`).toEqual([]);
    }
  });
}
