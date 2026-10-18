import { execFileSync } from "node:child_process";
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { costsFor } from "./billingModel";
import {
  checkAnswer, closeLineFor, COUNTED_GROUPS, describedFor, ESTIMATE_RULE, FAIL_DETAIL, GROUP_TITLES, headlineFor, slotFor,
  type ApiMonthCheck, type CheckChoice, type CountedGroup,
} from "./monthCheckModel";

// W21 (the Billing month check): a Check month button in the page header with a count on it, a drawer that lists what to look at before a month is trusted or closed, and one line in
// the Close month dialog. Admin `admin` / `correct-horse`, as in the earlier projects. The contract is section 3 of docs/superpowers/plans/2026-10-18-w21-month-check.md.
//
// CASES 1 TO 6 WRITE NOTHING and need nothing from the stack beyond the sign-in, the site's time zone and the look preference. GET /api/billing/month-check is answered through page.route from
// e2e/monthCheckModel.ts (the pilot hall's September: 10 things to check; plus clear, empty, not begun, many, closed, open and a 500), GET /api/billing/costs and /months from
// e2e/billingModel.ts; any other write the page tries is refused with a 500 and fails the case. Every case stores its own look (PUT /api/me/preferences) before the page opens, and afterAll
// puts it back to Light and Navy and gold, also after a failed case. The words of the page are written here again (src/lib/monthCheck.ts, e2e/monthCheckModel.ts). Names are matched by
// SUBSTRING, so every lookup is `exact: true`: with the drawer open `Close` also matches `Close month…`, and the drawer's title is the month's name, not the button's words.
//   1   the header: the order Close/Reopen month…, Check month, Download CSV (the month button comes and goes, the other two stay put); the button's name is exactly `Check month`; the count slot reads
//       10 / 0 / 99+ / empty (and its sentence for assistive technology); Check month and Download CSV keep one box on the current month, a finished month before and after its costs land and
//       a closed month, and when the answer lands; a count of 99+ keeps the width of 10; exactly one `.primary`.
//   2   the drawer, light and dark at 1440 x 900, 1024 x 640 and 800 x 600: the title, the headline, the groups in order, the estimate rule, the gap and the reset, "Not counted"; inside the
//       window; no sideways scroll; opening and closing it changes no figure.
//   3   the keyboard: Tab to Check month and Enter; the focus on the panel; Tab and Shift+Tab wrap inside; Escape closes and gives the focus back; a long list shows five lines, expands from
//       the keyboard with the focus kept, and says how many more the server did not send.
//   4   the states: the skeleton while the answer is held (and nothing in the header moves when it lands), a 500, "empty" and "not begun" (`Nothing to look at yet` with a reason), "clear"
//       (`Nothing to check` and what was looked at), and no live region added to the page.
//   5   the Close month dialog: its one line about the check (ready, and still reading at the click), no link or button of its own, nothing posted.
//   6   a closed month and a running month say so in the drawer.
// CASE B needs the scratch stack: it runs only when COMPOSE_PROJECT_NAME starts with `dcdash_e2e_` (the scratch drill scripts export it), exactly as w11.spec.ts, and is skipped with its
// message otherwise. beforeAll seeds the three-panel history INSIDE the stack (`docker compose exec ... python -m dcdash.seed.history --yes`), afterAll removes the "Seeded demo" subtree and
// the source `seeded-history` through the API. The seeder clamps its range to the raw retention (30 days), so the previous month holds only its last days: B asserts only what does not depend
// on the date, every expectation read from the real GET /api/billing/month-check answer.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const SCRATCH = (process.env.COMPOSE_PROJECT_NAME ?? "").startsWith("dcdash_e2e_");
const SKIP_MESSAGE = "needs the scratch stack's COMPOSE_PROJECT_NAME (dcdash_e2e_*); the seeder refuses anything else";

interface Look { mode: "light" | "dark"; theme: string }
const LIGHT: Look = { mode: "light", theme: "navy-gold" };
const DARK: Look = { mode: "dark", theme: "desert-gold" };

const CLOSE_BUTTON = "Close month…";
const REOPEN_BUTTON = "Reopen month…";
const CHECK_BUTTON = "Check month";
const DOWNLOAD_BUTTON = "Download CSV";
const UNMETERED_INTRO = "20 assets have no meter of their own and no meter above them, so no energy is counted for them. They are not part of the number at the top.";
const CLOSED_NOTE = "This month is closed: its billed figures are frozen. This check describes the readings as they are stored today.";
const RUNNING_NOTE = "This month is still running: the check stops at the last full hour.";
const LOOKED_AT = /^Looked at 217 meters over 720 hours \(156,240 meter hours in all\), from \d{4}-\d\d-\d\d \d\d:\d\d to \d{4}-\d\d-\d\d \d\d:\d\d\. Only the hourly readings that billing uses were read, so this check cannot see every kind of fault\.$/;

interface Box { x: number; y: number; width: number; height: number }

// ---------------------------------------------------------------------------------------------------------------------------------
// The look and the mock

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
    const saved = await request.put("/api/me/preferences", { data: LIGHT });
    expect(saved.ok(), `starting from the light look: ${saved.status()} ${await saved.text()}`).toBe(true);
  });
});
test.afterAll(async ({ browser }) => {
  await asAdmin(browser, async (request) => { await request.put("/api/me/preferences", { data: LIGHT }); });
});

interface Stub {
  stray: string[]; // the writes the spec does not expect (the page got a 500 for each)
  costsGate: Promise<void> | null; // while set, the costs request waits for it
  checkGate: Promise<void> | null; // while set, the month-check request waits for it
  checkHits: number; // how many times the page asked for the month check
  check: CheckChoice | ((month: string) => CheckChoice); // what the month-check route answers
  releases: (() => void)[]; // every gate the case made, opened again after the case whatever it did
}
const stubs: Stub[] = [];

test.afterEach(() => {
  for (const stub of stubs.splice(0)) {
    for (const release of stub.releases) release();
    expect(stub.stray, "the spec writes nothing to the stack: these requests were refused").toEqual([]);
  }
});

interface Opening {
  look?: Look; // default light
  closed?: boolean; // every month the costs route answers is a closed one
  check?: Stub["check"]; // default the pilot hall's September
}

/** Holds back the costs or the month check until the returned function is called (also opened after the case, so the page is never left waiting). */
function hold(stub: Stub, which: "costs" | "check"): () => void {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  if (which === "costs") stub.costsGate = gate;
  else stub.checkGate = gate;
  stub.releases.push(release);
  return () => {
    if (which === "costs") stub.costsGate = null;
    else stub.checkGate = null;
    release();
  };
}

/** Answers the Billing routes of the case from the models, refuses every other write, signs in and stores the look. */
async function prepare(page: Page, opening: Opening = {}): Promise<Stub> {
  const stub: Stub = { stray: [], costsGate: null, checkGate: null, checkHits: 0, check: opening.check ?? "pilot", releases: [] };
  stubs.push(stub);
  // Registered FIRST, so it is asked last: a write that is not the sign-in or the look's save is refused and written down.
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    if (method === "GET" || method === "HEAD") return route.fallback();
    if (path === "/api/login" || (method === "PUT" && path === "/api/me/preferences")) return route.fallback();
    stub.stray.push(`${method} ${path}`);
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "w21: this spec writes nothing" }) });
  });
  await page.route((url) => url.pathname === "/api/billing/costs", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (stub.costsGate) await stub.costsGate;
    const month = new URL(route.request().url()).searchParams.get("month") ?? "";
    const body = JSON.stringify(costsFor(month, { closed: opening.closed === true }));
    await route.fulfill({ status: 200, contentType: "application/json", body }).catch(() => undefined); // the page may be gone by now
  });
  await page.route((url) => url.pathname === "/api/billing/months", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const now = new Date();
    const first = `${now.getUTCFullYear() - 1}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`; // a year back, so Previous month has somewhere to go
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ first_month: first }) }).catch(() => undefined);
  });
  await page.route((url) => url.pathname === "/api/billing/month-check", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    stub.checkHits += 1;
    if (stub.checkGate) await stub.checkGate;
    const month = new URL(route.request().url()).searchParams.get("month") ?? "";
    const choice = typeof stub.check === "function" ? stub.check(month) : stub.check;
    const answer = choice === "fail"
      ? { status: 500, body: JSON.stringify({ detail: FAIL_DETAIL }) }
      : { status: 200, body: JSON.stringify(checkAnswer(choice, month)) };
    await route.fulfill({ status: answer.status, contentType: "application/json", body: answer.body }).catch(() => undefined);
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
/** The header's buttons, left to right. With the drawer open the page behind is inert, so the cases that read it then use these CSS locators, not roles. */
const actions = (page: Page) => page.locator(".billing-page .page-head .actions > button");
const checkButton = (page: Page) => actions(page).filter({ has: page.locator(".check-count") });
const downloadButton = (page: Page) => actions(page).filter({ hasText: DOWNLOAD_BUTTON });
/** The count on the Check month button. */
const slotOf = (page: Page) => checkButton(page).locator(".check-count");
const bodyRows = (page: Page) => page.locator("table.billing tbody tr");
const monthLabel = (page: Page) => page.locator(".billing-page .month-label");
const tableText = async (page: Page) => (await page.locator("table.billing").first().textContent()) ?? "";

const headline = (page: Page) => page.locator(".drawer .month-check-headline");
/** A counted group of the open drawer, found by its title. */
const groupOf = (page: Page, key: CountedGroup) =>
  page.locator(".drawer .month-check-group").filter({ has: page.locator("h3", { hasText: new RegExp(`^${GROUP_TITLES[key]}\\s*[\\d,]+$`) }) });
const itemsOf = (group: Locator) => group.locator(".month-check-list > li");
const showButton = (group: Locator) => group.locator("button.month-check-show");
const infoBlock = (page: Page) => page.locator(".drawer .month-check-info");

const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

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

/** Where Check month and Download CSV are now. */
async function headerBoxes(page: Page): Promise<{ check: Box; download: Box }> {
  return { check: await boxOf(checkButton(page), CHECK_BUTTON), download: await boxOf(downloadButton(page), DOWNLOAD_BUTTON) };
}
async function expectHeaderSame(page: Page, want: { check: Box; download: Box }, when: string): Promise<void> {
  await settled(page);
  const got = await headerBoxes(page);
  expectSame(got.check, want.check, `${CHECK_BUTTON} ${when}`);
  expectSame(got.download, want.download, `${DOWNLOAD_BUTTON} ${when}`);
}

/** Opens the current month (the sign-in has happened) and waits until the rows, the header buttons and the top bar are there and the page has stopped moving. */
async function openBilling(page: Page): Promise<void> {
  await page.goto("/billing");
  await expect(bodyRows(page).first()).toBeVisible();
  await expect(page.locator(".billing-page .sk-region")).toHaveCount(0);
  await expect(page.locator(".navbar .live")).toBeVisible();
  await expect(checkButton(page)).toBeVisible();
  await expect(downloadButton(page)).toBeVisible();
  await settled(page);
}

/** One click on Previous month; waits for the earlier month's rows. Returns the month's name as the page writes it (`September 2026`). */
async function toPreviousMonth(page: Page): Promise<string> {
  const before = (await monthLabel(page).textContent()) ?? "";
  await btn(page, "Previous month").click();
  await expect(monthLabel(page)).not.toHaveText(before);
  await expect(page.locator(".billing-page .sk-region")).toHaveCount(0);
  await expect(bodyRows(page).first()).toBeVisible();
  await settled(page);
  return (await monthLabel(page).textContent()) ?? "";
}

const drawerOf = (page: Page, label: string) => page.getByRole("dialog", { name: `Check ${label}`, exact: true });

/** The site-local month, `back` months ago (`2026-09`), from the site's time zone like the page does. */
function siteMonth(timezone: string, back = 0, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const index = year * 12 + (month - 1) - back;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** The page's own month text (`September 2026`). */
function monthName(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(year, m - 1, 1)));
}

async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/** The drawer lies inside the window (it slides in for 200 ms, so this waits for it to arrive) and nothing scrolls sideways, in the page or in the drawer's body. */
async function expectDrawerInWindow(page: Page, dialog: Locator, where: string): Promise<void> {
  const view = page.viewportSize()!;
  await expect.poll(async () => {
    const box = await dialog.boundingBox();
    if (box === null) return "no box";
    const out: string[] = [];
    if (box.x < -1) out.push(`left edge ${box.x}`);
    if (box.y < -1) out.push(`top edge ${box.y}`);
    if (box.x + box.width > view.width + 1) out.push(`right edge ${box.x + box.width} of ${view.width}`);
    if (box.y + box.height > view.height + 1) out.push(`bottom edge ${box.y + box.height} of ${view.height}`);
    return out.join(", ");
  }, { message: `${where}: the drawer lies inside the window` }).toBe("");
  const sideways = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".drawer-body");
    return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: body ? body.scrollWidth - body.clientWidth : 0 };
  });
  expect(sideways.page, `${where}: the page behind does not scroll sideways`).toBeLessThanOrEqual(0);
  expect(sideways.body, `${where}: the drawer's body does not scroll sideways`).toBeLessThanOrEqual(1);
}

/** 0 (black) to 1 (white) for a computed colour (`rgb(...)`, or `color(srgb r g b)` with channels 0 to 1); NaN for anything else. */
function brightness(css: string): number {
  const numbers = (css.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  if (numbers.length < 3) return NaN;
  const scale = css.startsWith("color(") ? 1 : 255;
  const [r, g, b] = numbers.slice(0, 3).map((n) => n / scale);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. The header

const ORDERS: readonly { name: string; opening: Opening; previous: boolean; names: string[]; slot: string }[] = [
  { name: "an open past month", opening: {}, previous: true, names: [CLOSE_BUTTON, CHECK_BUTTON, DOWNLOAD_BUTTON], slot: "10" },
  { name: "a closed month", opening: { closed: true, check: "closed" }, previous: false, names: [REOPEN_BUTTON, CHECK_BUTTON, DOWNLOAD_BUTTON], slot: "10" },
  { name: "the current month", opening: { check: "open" }, previous: false, names: [CHECK_BUTTON, DOWNLOAD_BUTTON], slot: "8" },
];

for (const order of ORDERS) {
  test(`1. ${order.name}: the header reads ${order.names.join(", ")}, in that order, and Check month is named exactly that`, async ({ page }) => {
    await prepare(page, order.opening);
    await openBilling(page);
    if (order.previous) await toPreviousMonth(page);
    await expect(actions(page)).toHaveCount(order.names.length);
    for (const [i, name] of order.names.entries()) await expect(actions(page).nth(i), `button ${i + 1}`).toHaveAccessibleName(name);
    await expect(btn(page, CHECK_BUTTON), "one button is named exactly Check month").toHaveCount(1);
    // Left to right on the screen as well as in the document.
    const boxes: Box[] = [];
    for (const [i, name] of order.names.entries()) boxes.push(await boxOf(actions(page).nth(i), name));
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].x, `${order.names[i]} starts after ${order.names[i - 1]} ends`).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width - 1);
    }
    await expect(slotOf(page)).toHaveText(order.slot);
    // Download CSV is the page's one primary button; Check month is not.
    await expect(page.locator(".billing-page .primary")).toHaveCount(1);
    await expect(downloadButton(page)).toHaveClass(/\bprimary\b/);
    await expect(checkButton(page)).not.toHaveClass(/\bprimary\b/);
  });
}

const COUNTS: readonly { name: string; check: CheckChoice; slot: string; described: string }[] = [
  { name: "10 for the pilot answer", check: "pilot", slot: "10", described: "10 things to check" },
  { name: "0 when meters were looked at and nothing was found", check: "clear", slot: "0", described: "nothing to check" },
  { name: "99+ above 99", check: "many", slot: "99+", described: "217 things to check" },
  { name: "nothing when no meter recorded in the month", check: "empty", slot: "", described: "nothing to look at yet" },
  { name: "nothing when the month has not begun", check: "not_begun", slot: "", described: "nothing to look at yet" },
  { name: "nothing when the read failed", check: "fail", slot: "", described: "not read yet" },
];

for (const count of COUNTS) {
  test(`1. the count on Check month reads ${count.name}, and its sentence for assistive technology says so`, async ({ page }) => {
    const stub = await prepare(page, { check: count.check });
    await openBilling(page);
    // A failed read is tried once more after a second: wait for that, so the empty count is the answer and not just the start.
    if (count.check === "fail") await expect.poll(() => stub.checkHits, { message: "the page asked twice" }).toBeGreaterThanOrEqual(2);
    await expect(slotOf(page)).toHaveText(count.slot);
    await expect(checkButton(page)).toHaveAccessibleName(CHECK_BUTTON);
    await expect(checkButton(page)).toHaveAccessibleDescription(count.described);
    if (count.slot === "0") await expect(slotOf(page), "a zero is the quiet one").toHaveAttribute("data-zero", /.*/);
    else await expect(slotOf(page)).not.toHaveAttribute("data-zero", /.*/);
    expect(await slotOf(page).getAttribute("role"), "the count is no live region").toBeNull();
    expect(await slotOf(page).getAttribute("aria-live")).toBeNull();
  });
}

test("1. Check month and Download CSV keep one box on the current month, on a finished month before and after its costs land, and when the count lands", async ({ page }) => {
  test.setTimeout(90_000);
  const stub = await prepare(page);
  const releaseCosts = hold(stub, "costs");
  const releaseCheck = hold(stub, "check");
  await page.goto("/billing");
  await expect(checkButton(page)).toBeVisible();
  await expect(downloadButton(page)).toBeVisible();
  await expect(page.locator(".navbar .live")).toBeVisible();
  await settled(page);
  await expect(slotOf(page), "the count is empty while the answer is held").toHaveText("");
  await expect(actions(page), "no month button while the costs are held").toHaveCount(2);
  const held = await headerBoxes(page);

  releaseCheck();
  await expect(slotOf(page)).toHaveText("10");
  await expectHeaderSame(page, held, "once the count has landed");

  releaseCosts();
  await expect(bodyRows(page).first()).toBeVisible();
  await expect(actions(page), "the current month has no Close or Reopen button").toHaveCount(2);
  await expectHeaderSame(page, held, "on the current month once its costs have landed");

  // An earlier month: its costs are held, then they land and Close month… appears LEFT of Check month, which stays.
  const releaseMonth = hold(stub, "costs");
  await btn(page, "Previous month").click();
  await expect(page.getByRole("status").filter({ hasText: /^Loading billing$/ })).toBeVisible();
  await expect(actions(page), "while the costs are held there is no month button").toHaveCount(2);
  await expectHeaderSame(page, held, "on a finished month before its costs land");
  releaseMonth();
  await expect(btn(page, CLOSE_BUTTON)).toBeVisible();
  await expect(actions(page)).toHaveCount(3);
  await expectHeaderSame(page, held, "on a finished month after its costs have landed");
  const close = await boxOf(btn(page, CLOSE_BUTTON), CLOSE_BUTTON);
  expect(close.x + close.width, "Close month… sits left of Check month").toBeLessThanOrEqual(held.check.x + 1);
  await expect(page.locator(".billing-page .primary")).toHaveCount(1);
});

test("1. a closed month keeps Check month and Download CSV where they are when Reopen month… arrives", async ({ page }) => {
  const stub = await prepare(page, { closed: true, check: "closed" });
  const releaseCosts = hold(stub, "costs");
  await page.goto("/billing");
  await expect(checkButton(page)).toBeVisible();
  await expect(downloadButton(page)).toBeVisible();
  await expect(slotOf(page)).toHaveText("10");
  await expect(actions(page)).toHaveCount(2);
  await settled(page);
  const held = await headerBoxes(page);
  releaseCosts();
  await expect(btn(page, REOPEN_BUTTON)).toBeVisible();
  await expect(actions(page)).toHaveCount(3);
  await expectHeaderSame(page, held, "on a closed month once its costs have landed");
  await expect(page.locator(".billing-page .primary")).toHaveCount(1);
});

test("1. a count of 99+ keeps Check month the width it has with 10", async ({ page }) => {
  test.setTimeout(90_000);
  const stub = await prepare(page);
  const { timezone } = await json<{ timezone: string }>(page.request, "/api/site");
  const current = siteMonth(timezone);
  stub.check = (month) => (month === current ? "pilot" : "many");
  await openBilling(page);
  await expect(slotOf(page)).toHaveText("10");
  const ten = await headerBoxes(page);
  await toPreviousMonth(page);
  await expect(slotOf(page)).toHaveText("99+");
  await expectHeaderSame(page, ten, "with 99+ on the earlier month");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. The drawer

const LOOKS = [LIGHT, DARK] as const;
const SIZES = [[1440, 900], [1024, 640], [800, 600]] as const;

for (const look of LOOKS) {
  for (const [width, height] of SIZES) {
    test(`2. the drawer lists the pilot hall's ten things at ${width} x ${height}, ${look.mode}, and opening it changes no figure`, async ({ page }) => {
      test.setTimeout(90_000);
      await prepare(page, { look });
      await page.setViewportSize({ width, height });
      await openBilling(page);
      const label = await toPreviousMonth(page);
      await expect(slotOf(page)).toHaveText("10");
      const tableBefore = await tableText(page);
      const where = `${look.mode} ${width} x ${height}`;

      await checkButton(page).click();
      const dialog = drawerOf(page, label);
      await expect(dialog, "the drawer opens and is named after the month").toBeVisible();
      await expect(dialog.getByRole("heading", { level: 2, name: `Check ${label}`, exact: true })).toBeVisible();
      await expectDrawerInWindow(page, dialog, where);
      const background = brightness(await page.locator(".drawer").evaluate((el) => getComputedStyle(el).backgroundColor));
      if (Number.isFinite(background)) {
        if (look.mode === "dark") expect(background, `${where}: the drawer is dark`).toBeLessThan(0.5);
        else expect(background, `${where}: the drawer is light`).toBeGreaterThan(0.5);
      }

      await expect(headline(page)).toHaveText("10 things to check");
      await expect(page.locator(".drawer .month-check-looked")).toHaveText(LOOKED_AT);
      // The counted groups in order, then the information block.
      await expect(page.locator(".drawer .month-check-group > h3")).toHaveText([
        /^Gaps in the readings\s*1$/, /^Estimated from power\s*8$/, /^Counter went back or dipped\s*1$/, /^Not counted$/,
      ]);

      const estimated = groupOf(page, "estimated");
      await expect(estimated.locator(".month-check-intro"), "the owner's estimate rule, as one sentence").toHaveText(ESTIMATE_RULE);
      await expect(itemsOf(estimated), "five lines before Show all").toHaveCount(5);
      await expect(showButton(estimated)).toHaveText("Show all 8");

      const gaps = groupOf(page, "gaps");
      await expect(gaps).toContainText("1 gap: 6 hours without any reading.");
      await expect(gaps.locator(".month-check-reads")).toHaveText("Reads Energy kWh (Hall 1 PLC)");

      const resets = groupOf(page, "resets");
      await expect(resets, "the reset names a size").toContainText(/The counter went back down 1 time \(\d{4}-\d\d-\d\d \d\d:\d\d, by 1,250\)/);

      await expect(infoBlock(page).locator("h4"), "Not counted holds the assets nothing measures").toHaveText(["Assets nothing measures"]);
      await expect(infoBlock(page).locator(".month-check-intro")).toHaveText(UNMETERED_INTRO);
      await expect(itemsOf(infoBlock(page))).toHaveCount(5);
      await expect(showButton(infoBlock(page))).toHaveText("Show all 20");

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(slotOf(page), "the count is where it was").toHaveText("10");
      expect(await tableText(page), `${where}: opening and closing the drawer changed a figure`).toBe(tableBefore);
    });
  }
}

/** True when two boxes share any area (half a pixel of touching is not sharing). */
function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
}

/** Opens the sidebar (a window under 1180px starts with it minimized, and it stays as the person left it) and waits until the page has stopped moving. */
async function expandSidebar(page: Page): Promise<void> {
  const shell = page.locator(".shell");
  if ((await shell.getAttribute("data-sidebar")) !== "expanded") await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await expect(shell).toHaveAttribute("data-sidebar", "expanded");
  await settled(page);
  // the column takes its width in a transition: measure only once the header's left edge has stopped moving (two reads 150 ms apart agree)
  let last = Number.NaN;
  await expect.poll(async () => {
    const x = await page.locator(".billing-page .page-head").evaluate((el) => el.getBoundingClientRect().x);
    const same = x === last;
    last = x;
    return same;
  }, { intervals: [150], timeout: 5_000 }).toBe(true);
}

// Review I1: with the sidebar open at 800px the page header is 516px wide and the three buttons of a finished month (Close month…, Check month, Download CSV: about 475px) were drawn over the
// end of the title ("Billir"). Below 600px of the header's own width the buttons go under the title; from there up they share its row. Measured on a finished month, where all three are there.
test("2. the header with the sidebar expanded on a finished month: at 800 x 600 the title is not overlapped or clipped and the actions sit under it, at 1024 x 640 the three buttons stay on the title's row", async ({ page }) => {
  test.setTimeout(90_000);
  await prepare(page);
  await page.setViewportSize({ width: 800, height: 600 });
  await openBilling(page);
  await toPreviousMonth(page);
  await expect(btn(page, CLOSE_BUTTON)).toBeVisible();
  await expect(actions(page), "Close month…, Check month and Download CSV").toHaveCount(3);
  await expandSidebar(page);

  const heading = page.locator(".billing-page .page-head h1");
  const names = [CLOSE_BUTTON, CHECK_BUTTON, DOWNLOAD_BUTTON];
  const read = async () => ({
    title: await boxOf(heading, "the title"),
    head: await boxOf(page.locator(".billing-page .page-head"), "the page header"),
    buttons: await Promise.all(names.map((name) => boxOf(btn(page, name), name))),
    clipped: await heading.evaluate((el) => el.scrollWidth - el.clientWidth),
    headOverflow: await page.locator(".billing-page .page-head").evaluate((el) => el.scrollWidth - el.clientWidth),
  });

  // 800 x 600: a header narrower than 600px, so the actions leave the title's row.
  const narrow = await read();
  expect(narrow.head.width, "the header is under the 600px where the buttons wrap").toBeLessThan(600);
  expect(narrow.clipped, "the title is not clipped").toBeLessThanOrEqual(1);
  expect(narrow.headOverflow, "the header does not overflow sideways").toBeLessThanOrEqual(1);
  narrow.buttons.forEach((box, i) => {
    expect(overlaps(narrow.title, box), `${names[i]} is drawn over the title`).toBe(false);
    expect(box.y, `${names[i]} sits under the title`).toBeGreaterThanOrEqual(narrow.title.y + narrow.title.height - 1);
    expect(box.x + box.width, `${names[i]} stays inside the header`).toBeLessThanOrEqual(narrow.head.x + narrow.head.width + 1);
    if (i === 0) expect(box.x, `${names[0]} starts at the title's left edge`).toBeLessThanOrEqual(narrow.title.x + 1); // the others follow it on the same row
  });
  for (let i = 1; i < names.length; i++) expect(narrow.buttons[i].y, `${names[i]} shares a row with ${names[0]}`).toBeLessThanOrEqual(narrow.buttons[0].y + 1);
  expect(narrow.buttons[0].x, "the order is Close month…, Check month, Download CSV").toBeLessThan(narrow.buttons[1].x);
  expect(narrow.buttons[1].x).toBeLessThan(narrow.buttons[2].x);

  // 1024 x 640 with the sidebar still open: the header is wide enough, the three buttons are on the title's row, to its right.
  await page.setViewportSize({ width: 1024, height: 640 });
  await settled(page);
  const wide = await read();
  expect(wide.head.width, "the header is 600px or more").toBeGreaterThanOrEqual(600);
  expect(wide.clipped).toBeLessThanOrEqual(1);
  wide.buttons.forEach((box, i) => {
    expect(overlaps(wide.title, box), `${names[i]} is drawn over the title`).toBe(false);
    expect(box.x, `${names[i]} is right of the title`).toBeGreaterThanOrEqual(wide.title.x + wide.title.width - 1);
    expect(box.y, `${names[i]} is on the title's row`).toBeLessThan(wide.title.y + wide.title.height);
    expect(box.y + box.height, `${names[i]} is on the title's row`).toBeGreaterThan(wide.title.y);
  });
  for (let i = 1; i < names.length; i++) expect(Math.abs(wide.buttons[i].y - wide.buttons[0].y), `${names[i]} shares a row with ${names[0]}`).toBeLessThanOrEqual(1);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. The keyboard

/** Where the focus is: the control's name, or `panel` for the drawer itself. */
const focusName = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "nothing";
    if (el.getAttribute("role") === "dialog") return "panel";
    return (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim();
  });

test("3. Tab reaches Check month and Enter opens the drawer with the focus on the panel; Tab and Shift+Tab wrap inside it; Escape closes it and the focus goes back", async ({ page }) => {
  test.setTimeout(90_000);
  await prepare(page);
  await openBilling(page);
  const label = await toPreviousMonth(page);
  await expect(slotOf(page)).toHaveText("10");
  const opener = checkButton(page);

  await btn(page, CLOSE_BUTTON).focus();
  await page.keyboard.press("Tab");
  await expect(opener, "Tab from Close month… goes to Check month").toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = drawerOf(page, label);
  await expect(dialog).toBeVisible();
  await expect(dialog, "the focus is on the panel").toBeFocused();

  // The controls of the drawer in the order Tab visits them: the x, then the two Show all buttons (the pilot answer has two lists of more than five lines).
  const tabStops = ["Close", "Show all 8", "Show all 20"];
  const inside = () => dialog.evaluate((el) => el.contains(document.activeElement));
  const press = async (key: "Tab" | "Shift+Tab", want: string) => {
    await page.keyboard.press(key);
    expect(await focusName(page), `${key} goes to ${want}`).toBe(want);
    expect(await inside(), `the focus is inside the drawer after ${key}`).toBe(true);
  };
  await press("Tab", tabStops[0]);
  await press("Tab", tabStops[1]);
  await press("Tab", tabStops[2]);
  await press("Tab", tabStops[0]); // wraps round to the first control
  await press("Shift+Tab", tabStops[2]); // and back to the last
  await press("Shift+Tab", tabStops[1]);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener, "Escape gives the focus back to Check month").toBeFocused();
  // A second Escape has nothing to close: the page stays as it is.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(page).toHaveURL(/\/billing$/);
  await expect(page.locator(".billing-page .error")).toHaveCount(0);
});

test("3. a list of more than five lines shows five and Show all, expands from the keyboard with the focus kept, and says how many more the server did not send", async ({ page }) => {
  test.setTimeout(90_000);
  await prepare(page, { check: "many" });
  await openBilling(page);
  await expect(slotOf(page)).toHaveText("99+");
  await checkButton(page).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(headline(page)).toHaveText("217 things to check");

  const group = groupOf(page, "estimated");
  await expect(group.locator("h3")).toHaveText(/^Estimated from power\s*217$/);
  await expect(itemsOf(group)).toHaveCount(5);
  const more = showButton(group);
  // The label counts the lines the server sent (60), not the group's total (217): the rest is in the cap line below the list.
  await expect(more).toHaveText("Show all 60");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(group.locator(".month-check-more"), "the cap line waits for the whole list").toHaveCount(0);

  await page.keyboard.press("Tab"); // the x
  await page.keyboard.press("Tab"); // Show all 60
  await expect(more).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(more, "the focus stays on the button").toBeFocused();
  await expect(more).toHaveText("Show fewer");
  await expect(itemsOf(group)).toHaveCount(60);
  await expect(group.locator(".month-check-more"), "the cap line says how many more the server did not send").toHaveText("and 157 more");

  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(more).toBeFocused();
  await expect(more).toHaveText("Show all 60");
  await expect(itemsOf(group)).toHaveCount(5);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. The states

test("4. while the answer is held the drawer shows its skeleton, and nothing in the header moves when the answer lands", async ({ page }) => {
  test.setTimeout(90_000);
  const stub = await prepare(page);
  const release = hold(stub, "check");
  await page.goto("/billing");
  await expect(bodyRows(page).first()).toBeVisible();
  await expect(checkButton(page)).toBeVisible();
  await expect(downloadButton(page)).toBeVisible();
  await expect(page.locator(".navbar .live")).toBeVisible();
  await settled(page);
  await expect(slotOf(page)).toHaveText("");
  await expect(checkButton(page)).toHaveAccessibleDescription("not read yet");
  const held = await headerBoxes(page);

  await checkButton(page).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator('.drawer [role="status"].sk-region'), "the drawer shows its one skeleton region").toHaveCount(1);
  await expect(page.locator(".drawer .sk-region")).toContainText("Loading the month check");
  // (the skeleton draws its headline line with the headline's own class, so the words are what must be absent)
  await expect(dialog).not.toContainText("things to check");
  await expect(dialog).not.toContainText("Nothing to check");
  await expect(page.locator(".drawer .error")).toHaveCount(0);

  release();
  await expect(headline(page)).toHaveText("10 things to check");
  await expect(page.locator(".drawer .sk-region")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(slotOf(page)).toHaveText("10");
  await expectHeaderSame(page, held, "once the answer has landed");
});

test("4. a 500 answer shows the drawer's error line and leaves the table untouched", async ({ page }) => {
  test.setTimeout(90_000);
  await prepare(page, { check: "fail" });
  await openBilling(page);
  const tableBefore = await tableText(page);
  await checkButton(page).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The read is tried once more after a second, so the line comes a little later; the skeleton is there until it does.
  await expect(dialog.locator("p.error")).toHaveText(FAIL_DETAIL);
  await expect(dialog.getByRole("alert")).toHaveCount(1);
  await expect(headline(page)).toHaveCount(0);
  await expect(page.locator(".drawer .sk-region")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(slotOf(page)).toHaveText("");
  await expect(checkButton(page)).toHaveAccessibleDescription("not read yet");
  expect(await tableText(page), "the failed read changed a figure").toBe(tableBefore);
  await expect(page.locator(".billing-page .error"), "the page itself shows no error line").toHaveCount(0);
});

const NOTHING: readonly { name: CheckChoice; reason: string; looked: string | RegExp }[] = [
  {
    name: "empty", reason: "No asset has an energy (kWh) counter or a power (kW) reading mapped.",
    looked: /^Looked at 0 meters over 720 hours \(0 meter hours in all\), from \d{4}-\d\d-\d\d \d\d:\d\d to \d{4}-\d\d-\d\d \d\d:\d\d\. Only the hourly readings that billing uses were read, so this check cannot see every kind of fault\.$/,
  },
  { name: "not_begun", reason: "This month has not begun.", looked: "Nothing was read." },
];

for (const nothing of NOTHING) {
  test(`4. the "${nothing.name}" answer says Nothing to look at yet, and why`, async ({ page }) => {
    await prepare(page, { check: nothing.name });
    await openBilling(page);
    await expect(checkButton(page)).toHaveAccessibleDescription("nothing to look at yet");
    await expect(slotOf(page)).toHaveText("");
    await checkButton(page).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(headline(page)).toHaveText("Nothing to look at yet");
    await expect(page.locator(".drawer .month-check-reason")).toHaveText(nothing.reason);
    await expect(page.locator(".drawer .month-check-looked")).toHaveText(nothing.looked);
    await expect(page.locator(".drawer .month-check-group > h3"), "no counted group, only the information block").toHaveText(["Not counted"]);
  });
}

test('4. the "clear" answer says Nothing to check and still says what it looked at', async ({ page }) => {
  await prepare(page, { check: "clear" });
  await openBilling(page);
  await expect(slotOf(page)).toHaveText("0");
  await checkButton(page).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(headline(page)).toHaveText("Nothing to check");
  await expect(page.locator(".drawer .month-check-reason")).toHaveCount(0);
  await expect(page.locator(".drawer .month-check-looked")).toHaveText(/^Looked at 217 meters over 720 hours \(156,240 meter hours in all\), from /);
  await expect(page.locator(".drawer .month-check-group > h3")).toHaveText(["Not counted"]);
  await expect(infoBlock(page).locator(".month-check-intro")).toHaveText("Every asset at the bottom of the tree has a meter of its own or one above it.");
});

test("4. the count and the drawer add no live region to the page", async ({ page }) => {
  test.setTimeout(90_000);
  const stub = await prepare(page, { check: "fail" });
  await openBilling(page);
  await expect.poll(() => stub.checkHits, { message: "the page asked twice" }).toBeGreaterThanOrEqual(2);
  await settled(page);
  const statuses = () => page.locator('[role="status"]').count();
  const failed = await statuses();

  stub.check = "pilot";
  await openBilling(page); // a full load, so the cached failure is gone
  await expect(slotOf(page)).toHaveText("10");
  const answered = await statuses();
  await checkButton(page).click();
  await expect(headline(page)).toHaveText("10 things to check");
  const open = await statuses();

  expect(answered, "the answered count adds no status to the page").toBe(failed);
  expect(open, "the open drawer adds no status to the page").toBe(answered);
  await expect(page.locator('.drawer [role="status"]'), "the drawer's answer is no live region").toHaveCount(0);
  const sentence = await checkButton(page).getAttribute("aria-describedby");
  expect(sentence, "the button is described by a sentence").not.toBeNull();
  expect(await page.locator(`[id="${sentence}"]`).getAttribute("role"), "the sentence has no role").toBeNull();
  expect(await page.locator(`[id="${sentence}"]`).getAttribute("aria-live")).toBeNull();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. The Close month dialog

test("5. the Close month dialog says what the check found, in one line with no link or button of its own", async ({ page }) => {
  await prepare(page);
  await openBilling(page);
  const label = await toPreviousMonth(page);
  await expect(slotOf(page)).toHaveText("10");
  await btn(page, CLOSE_BUTTON).click();
  const dialog = page.getByRole("dialog", { name: `Close ${label}`, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".month-extra")).toHaveText("Month check: 10 things to check (see Check month on the page).");
  await expect(dialog.locator("a"), "no link").toHaveCount(0);
  await expect(dialog.locator("button"), "no button besides Cancel and Close month").toHaveText(["Cancel", "Close month"]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(btn(page, CLOSE_BUTTON), "the focus goes back to the button that opened the dialog").toBeFocused();
});

test("5. the line says the check is not read yet when it was still reading at the click, and keeps saying it when the answer lands", async ({ page }) => {
  test.setTimeout(90_000);
  const stub = await prepare(page);
  const release = hold(stub, "check");
  await openBilling(page);
  const label = await toPreviousMonth(page);
  await expect(slotOf(page)).toHaveText("");
  await btn(page, CLOSE_BUTTON).click();
  const dialog = page.getByRole("dialog", { name: `Close ${label}`, exact: true });
  const line = dialog.locator(".month-extra");
  await expect(line).toHaveText("Month check: not read yet (see Check month on the page).");

  release();
  await expect(slotOf(page), "the answer lands on the page behind the dialog").toHaveText("10");
  await expect(line, "the dialog's line is fixed at the click").toHaveText("Month check: not read yet (see Check month on the page).");
  await expect(dialog.locator("button")).toHaveText(["Cancel", "Close month"]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 6. A closed month and a running month

test("6. a closed month says in the drawer that it is closed and the check describes the readings as stored today", async ({ page }) => {
  await prepare(page, { closed: true, check: "closed" });
  await openBilling(page);
  await expect(btn(page, REOPEN_BUTTON)).toBeVisible();
  await checkButton(page).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(headline(page)).toHaveText("10 things to check");
  await expect(page.locator(".drawer .month-check-state")).toHaveText(CLOSED_NOTE);
});

test("6. a running month says in the drawer that the check stops at the last full hour", async ({ page }) => {
  await prepare(page, { check: "open" });
  await openBilling(page);
  await expect(slotOf(page)).toHaveText("8");
  await checkButton(page).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(headline(page)).toHaveText("8 things to check");
  await expect(page.locator(".drawer .month-check-state")).toHaveText(RUNNING_NOTE);
  await expect(page.locator(".drawer .month-check-looked")).toHaveText(/, the last full hour\. Only the hourly readings that billing uses were read, so this check cannot see every kind of fault\.$/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// B. The real endpoint on the scratch stack

const SEED_SOURCE = "seeded-history";
const SEED_ROOT = "Seeded demo";
const PANEL_A = "Seeded Panel A";
const PANEL_B = "Seeded Panel B";
const PANEL_C = "Seeded Panel C";

interface ApiSource { id: number; name: string }
interface ApiAsset { id: number; parent_id: number | null; name: string }

/**
 * Runs the seeder inside the api container of the scratch stack, as w11.spec.ts does. A second run finds `seeded-history` and exits 1 with "already exists": that is a re-run on a stack
 * that kept an earlier seed, and is fine. Any other failure fails the suite with the seeder's own words.
 */
function seedHistory(): void {
  try {
    execFileSync("docker", ["compose", "exec", "-T", "-e", "DCDASH_ALLOW_SEED_HISTORY=1", "api", "python", "-m", "dcdash.seed.history", "--yes"], {
      env: process.env, encoding: "utf8", stdio: "pipe", timeout: 240_000, maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    const failure = e as { status?: number | null; stderr?: string; stdout?: string; message: string };
    const said = `${failure.stderr ?? ""}${failure.stdout ?? ""}`;
    if (failure.status === 1 && /already exists/.test(said)) return;
    throw new Error(`the history seeder failed (exit ${failure.status ?? "none"}): ${said.trim() || failure.message}`);
  }
}

/** Takes the seed away again, through the normal deletes: the subtree (its mappings and rates go with it), then the source. */
async function removeSeed(request: APIRequestContext): Promise<void> {
  for (const root of (await json<ApiAsset[]>(request, "/api/assets")).filter((a) => a.parent_id === null && a.name === SEED_ROOT)) {
    const gone = await request.delete(`/api/assets/${root.id}?confirm=true`);
    expect([200, 204, 404], `deleting "${SEED_ROOT}": ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
  for (const source of (await json<ApiSource[]>(request, "/api/sources")).filter((s) => s.name === SEED_SOURCE)) {
    const gone = await request.delete(`/api/sources/${source.id}?confirm=true`);
    expect([200, 204, 404], `deleting the source ${SEED_SOURCE}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
}

const hoursText = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "hour" : "hours"}`;
const timesText = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "time" : "times"}`;

/** The line of a group's list for `path`; when only five lines are shown, Show all is pressed first. */
async function itemFor(page: Page, group: Locator, path: string): Promise<Locator> {
  const item = itemsOf(group).filter({ has: page.locator(".month-check-path", { hasText: path }) });
  if ((await item.count()) === 0) await showButton(group).click();
  await expect(item, `the drawer lists ${path}`).toHaveCount(1);
  return item;
}

test.describe("W21 case B: the real month check of the seeded history", () => {
  test.skip(!SCRATCH, SKIP_MESSAGE);

  test.beforeAll(() => {
    if (!SCRATCH) return;
    test.setTimeout(300_000);
    seedHistory();
  });

  test.afterAll(async ({ browser }) => {
    if (!SCRATCH) return;
    test.setTimeout(240_000);
    await asAdmin(browser, removeSeed);
  });

  test("B. the drawer and the count say what GET /api/billing/month-check says for the previous month, and opening it changes no figure", async ({ page }) => {
    test.setTimeout(180_000);
    const login = await page.request.post("/api/login", { data: ADMIN });
    expect(login.ok(), `signing in: ${login.status()} ${await login.text()}`).toBe(true);
    const { timezone } = await json<{ timezone: string }>(page.request, "/api/site");
    const month = siteMonth(timezone, 1);
    const label = monthName(month);
    const answer = await json<ApiMonthCheck>(page.request, `/api/billing/month-check?month=${month}`);
    expect(answer.month).toBe(month);
    expect(answer.state, "the previous month is over").toBe("finished");

    await page.goto("/billing");
    await expect(page.getByRole("heading", { level: 1, name: "Billing", exact: true })).toBeVisible();
    await btn(page, "Previous month").click();
    await expect(monthLabel(page)).toHaveText(label);
    await expect(page.locator("table.billing")).toBeVisible();
    await expect(page.locator(".billing-page .sk-region")).toHaveCount(0);
    await settled(page);

    // The count and its sentence equal the real answer, computed here from its JSON.
    await expect(slotOf(page), "the count is the real answer's").toHaveText(slotFor(answer));
    await expect(checkButton(page), "and so is the sentence behind it").toHaveAccessibleDescription(describedFor(answer));
    const tableBefore = await tableText(page);

    await checkButton(page).click();
    const dialog = drawerOf(page, label);
    await expect(dialog).toBeVisible();
    await expect(headline(page), "the headline is the real answer's").toHaveText(headlineFor(answer));
    for (const key of COUNTED_GROUPS) {
      const total = answer.groups[key].total;
      if (total > 0) await expect(groupOf(page, key).locator("h3"), `${GROUP_TITLES[key]} has the real total`).toHaveText(new RegExp(`^${GROUP_TITLES[key]}\\s*${total.toLocaleString("en-US")}$`));
      else await expect(groupOf(page, key), `${GROUP_TITLES[key]} is not drawn when it has nothing`).toHaveCount(0);
    }

    // The seeded panels: Panel B has power only, so it is estimated; the counters start part way through the month (the seeder's range is clamped to the raw retention) or carry the gap and
    // the reset. Each panel the API names in a counted group is in the drawer under that group, with the path the API gives.
    const itemsIn = (key: CountedGroup): { path: string }[] => answer.groups[key].items;
    for (const name of [PANEL_A, PANEL_B, PANEL_C]) {
      const listed = COUNTED_GROUPS.filter((key) => itemsIn(key).some((item) => item.path.endsWith(` / ${name}`)));
      expect(listed.length, `the real answer lists ${name} in at least one counted group`).toBeGreaterThan(0);
      for (const key of listed) {
        const path = itemsIn(key).find((item) => item.path.endsWith(` / ${name}`))!.path;
        await itemFor(page, groupOf(page, key), path);
      }
    }
    const estimated = answer.groups.estimated.items.find((item) => item.path.endsWith(` / ${PANEL_B}`));
    expect(estimated, "Panel B is under Estimated from power").toBeTruthy();
    const estimatedLine = await itemFor(page, groupOf(page, "estimated"), estimated!.path);
    await expect(estimatedLine).toContainText(`Its energy is worked out from power readings in ${estimated!.hours_estimated.toLocaleString("en-US")} of its ${hoursText(estimated!.hours_total)}.`);

    // The gap and the reset are asserted only when the real answer has them inside this month (the range is clamped, so they may fall in the other month).
    const gap = answer.groups.gaps.items.find((item) => item.path.endsWith(` / ${PANEL_A}`) && item.runs > 0);
    if (gap) {
      const line = await itemFor(page, groupOf(page, "gaps"), gap.path);
      const sentence = gap.runs === 1 ? `1 gap: ${hoursText(gap.hours)} without any reading.` : `${gap.runs.toLocaleString("en-US")} gaps: ${hoursText(gap.hours)} without any reading in all.`;
      await expect(line, "Panel A's gap, in the API's own numbers").toContainText(sentence);
    } // else: the seeded gap is in the other month (no complete day inside this one), nothing to assert
    const reset = answer.groups.resets.items.find((item) => item.path.endsWith(` / ${PANEL_C}`) && item.resets > 0);
    if (reset) {
      const line = await itemFor(page, groupOf(page, "resets"), reset.path);
      await expect(line, "Panel C's reset, in the API's own numbers").toContainText(`The counter went back down ${timesText(reset.resets)}`);
    } // else: the seeded reset is in the current month, nothing to assert

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(slotOf(page), "the count is where it was").toHaveText(slotFor(answer));
    expect(await tableText(page), "opening and closing the drawer changed a figure").toBe(tableBefore);

    // The Close month dialog words the same answer in its one line (it is only opened and cancelled: nothing is posted). A month that is already closed has Reopen month… instead.
    if (!answer.closed) {
      await btn(page, CLOSE_BUTTON).click();
      const closing = page.getByRole("dialog", { name: `Close ${label}`, exact: true });
      await expect(closing).toBeVisible();
      await expect(closing.locator(".month-extra")).toHaveText(closeLineFor(answer));
      await closing.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(closing).toBeHidden();
    }
  });
});
