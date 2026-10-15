import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Browser, type Download, type Locator, type Page } from "@playwright/test";
import { roleLabel } from "./roles";
import { treeLink, userBlock } from "./shell";

// W11 (close month: an administrator freezes a finished month's billing figures, the page and the CSV then read the frozen copy, and reopening
// goes back to live figures) on the state the earlier projects leave behind: admin `admin` / `correct-horse`.
//
// It stands LAST in the chain (project `w11`, depends on w7u) because it needs a month of history that no other spec has, and the only way to get it
// is the dev history seeder, run INSIDE the stack: `docker compose exec -T -e DCDASH_ALLOW_SEED_HISTORY=1 api python -m dcdash.seed.history --yes`.
// That makes the stack's Compose project part of the test: the spec runs only when COMPOSE_PROJECT_NAME starts with `dcdash_e2e_` (the scratch drill
// scripts export it with COMPOSE_FILE) and every case is skipped otherwise. beforeAll seeds, afterAll removes what the seeder made THROUGH THE API (the
// "Seeded demo" asset subtree and the source `seeded-history`) and puts the month back to open, so the stack ends as it began (the audit rows, the old
// closed copies and the orphaned readings of the deleted points stay, as after any source delete). The seeder clamps its range to the raw retention, so
// the previous month holds only its last days on most days of the month: no case assumes a whole month, every figure is read from the API.
//
// The cases run in file order (workers is 1) and share one month, the PREVIOUS site month; each starts from the state it needs (`ensureClosed`,
// `ensureOpen`, `ensureDifference`), so one failing case does not take the next one down with it:
//   close      Close month... from the page (Previous month, the dialog, a note): the banner says who and when, the note shows, the Closed chip shows,
//              the closed figures and CSV equal what the open month gave a moment before. The reference copy of the figures and of the CSV is kept here.
//   frozen     the world changes one write at a time through the API (Panel B moved under Panel A, a new rate for "Seeded demo", Panel C unmapped): after
//              each, the costs body minus `live` and the CSV bytes are byte-identical to the kept ones, the file is billing-<month>-closed.csv, and
//              `live.differs` says so; the page shows the line "Today's tree and rates would give ...".
//   reopen     Reopen month... needs a reason of 5 characters (4 keeps the button inert), then the banner and the chip are gone and the figures are the
//              live ones; the audit log has billing.closed and billing.reopened in words, in the API and on the Audit page.
//   permission a role with billing.view and billing.export but not billing.close, an Operator and a Viewer see no Close/Reopen control and get 403 from
//              both routes; a role WITH billing.close sees the control.
//   placement  at 1440x900 and 1024x640 the header buttons, the month bar, the banner, the delta line and the table do not overlap and nothing scrolls
//              sideways; both dialogs keep Cancel and the confirming button inside the window, Tab stays inside, Escape closes and gives the focus back.
//   warnings   the Move to... dialog of a move that changes a rate says "Closed months keep their billed figures."
//
// Locators. Playwright matches names by case-insensitive SUBSTRING: every control is looked up with `exact: true` ("Close month..." is also the start of
// the dialog's own "Close month" and of the heading "Close September 2026"; the buttons here end in the ellipsis character U+2026, the dialog's do not).
// The dialogs are found by their whole title. The page's classes (.closed-box, .closed-chip, .live-delta, .billing-bar) are the ones components/BillingPage.tsx
// and styles/pages-billing.css write. Screenshots go to .superpowers/sdd/overnight-w7/gallery/W11/ when W11_GALLERY=1.

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const SCRATCH = (process.env.COMPOSE_PROJECT_NAME ?? "").startsWith("dcdash_e2e_");
const SKIP_MESSAGE = "needs the scratch stack's COMPOSE_PROJECT_NAME (dcdash_e2e_*); the seeder refuses anything else";

const ADMIN = { username: "admin", password: "correct-horse", role: "admin" };
type Account = typeof ADMIN;
const PREFIX = "w11-";
const RUN = Date.now().toString();
const PLANT = `W11 ${RUN}`; // the warnings case's own small tree: `W11 <digits>` and `W11 <digits> <key>`
const REFUSED = "insufficient permission"; // the one text of every missing permission (backend api/deps.py)

const SEED_SOURCE = "seeded-history";
const SEED_ROOT = "Seeded demo";
const PANEL_A = "Seeded Panel A";
const PANEL_B = "Seeded Panel B";
const PANEL_C = "Seeded Panel C";
const PANEL_C_ADDRESS = "seed/panel-c/energy_kwh";

const ROLE_NO_CLOSE = "w11-no-close"; // billing.view + billing.export
const ROLE_CLOSER = "w11-closer"; // billing.view + billing.close
const VIEWER: Account = { username: "w11-viewer", password: "w11-viewer-pass", role: "viewer" };
const OPERATOR: Account = { username: "w11-operator", password: "w11-operator-pass", role: "operator" };
const NO_CLOSE: Account = { username: "w11-no-close", password: "w11-no-close-pass", role: ROLE_NO_CLOSE };
const CLOSER: Account = { username: "w11-closer", password: "w11-closer-pass", role: ROLE_CLOSER };

const CLOSE_BUTTON = "Close month…";
const REOPEN_BUTTON = "Reopen month…";
const KEPT = "Closed months keep their billed figures.";
const CLOSE_NOTE = "Month checked and sent by w11.spec.ts";
const REOPEN_REASON = "w11 checks that the live figures return";

interface Figure { kwh: number; cost: number | null; estimated: boolean; partial: boolean; no_data: boolean }
interface CostsAsset { asset_id: number; parent_id: number | null; name: string; path: string; rate_per_kwh: number | null; days: (Figure | null)[]; total: Figure | null }
interface Closed { id: number; closed_name: string; closed_at: string; note: string; total_kwh: number; total_cost: number | null }
interface Live { total_kwh: number; total_cost: number | null; delta_kwh: number; delta_cost: number | null; differs: boolean; changed_assets: number; currency: string | null }
interface Costs { month: string; timezone: string; currency: string | null; days: string[]; assets: CostsAsset[]; closed: Closed | null; live?: Live | null }
/** What a closed month must keep answering: the costs body without `live`, and the CSV (its bytes and its file name). */
interface Kept { costs: Omit<Costs, "live">; csv: Buffer; csvName: string }
interface ApiAsset { id: number; parent_id: number | null; name: string }
interface ApiSource { id: number; name: string }
interface ApiPoint { id: number; address: string; mapping: { id: number } | null }
interface ApiUser { id: number; username: string }
interface ApiRole { id: number; name: string; builtin: boolean }
interface ApiAudit { items: { id: number; action: string; detail: Record<string, unknown> }[] }
interface Seeded { rootId: number; aId: number; bId: number; cId: number; sourceId: number; mappingC: number }
interface Box { x: number; y: number; width: number; height: number }

/** What the cases share: the month, what the seeder made, the kept reference figures, and which writes of `frozen` have been made. */
const world = {
  month: "",
  seeded: null as Seeded | null,
  kept: null as Kept | null,
  moved: false,
  tariffId: 0, // the rate made for "Seeded demo"; 0 = none yet
  rate: 0,
  unmapped: false,
};
const seeded = (): Seeded => {
  if (world.seeded === null) throw new Error("the seeded history is not known (beforeAll did not finish)");
  return world.seeded;
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Requests

async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/** The answer's `detail` text (FastAPI's error body), or the raw text when the body is not that. */
async function detail(response: { text(): Promise<string> }): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    return typeof parsed.detail === "string" ? parsed.detail : text;
  } catch {
    return text;
  }
}

/** Runs `use` with the request context of a fresh browser context in which `who` is signed in. */
async function as<T>(browser: Browser, who: Account, use: (request: APIRequestContext) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    const login = await context.request.post("/api/login", { data: { username: who.username, password: who.password } });
    expect(login.ok(), `${who.username} signs in: ${login.status()} ${await login.text()}`).toBe(true);
    return await use(context.request);
  } finally {
    await context.close();
  }
}
const asAdmin = <T>(browser: Browser, use: (request: APIRequestContext) => Promise<T>) => as(browser, ADMIN, use);

/** The admin signs in through the API: the sign-in page is not what these cases test. */
async function signInAs(page: Page, who: Account): Promise<void> {
  const login = await page.request.post("/api/login", { data: { username: who.username, password: who.password } });
  expect(login.ok(), `signing in as ${who.username}: ${login.status()} ${await login.text()}`).toBe(true);
}

async function createRole(request: APIRequestContext, name: string, permissions: string[]): Promise<void> {
  const made = await request.post("/api/roles", { data: { name, description: "made by w11.spec.ts", permissions } });
  expect(made.status(), `creating role ${name}: ${await made.text()}`).toBe(201);
}

async function createAccount(request: APIRequestContext, who: Account): Promise<void> {
  const made = await request.post("/api/users", { data: { username: who.username, password: who.password, role: who.role } });
  expect(made.status(), `creating ${who.username}: ${await made.text()}`).toBe(201);
}

/** Every account whose name starts with w11-, then every custom role that does (a role an account holds cannot be deleted). */
async function removeAccounts(request: APIRequestContext): Promise<void> {
  for (const user of (await json<ApiUser[]>(request, "/api/users")).filter((u) => u.username.startsWith(PREFIX))) {
    const gone = await request.delete(`/api/users/${user.id}`);
    expect([204, 404], `deleting ${user.username}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
  for (const role of (await json<ApiRole[]>(request, "/api/roles")).filter((r) => !r.builtin && r.name.toLowerCase().startsWith(PREFIX))) {
    const gone = await request.delete(`/api/roles/${role.id}`);
    expect([204, 404], `deleting the role ${role.name}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
}

async function deleteAssets(request: APIRequestContext, ids: number[]): Promise<void> {
  // Newest first: a child goes before its parent, and a parent that took its children with it answers 404 for them, which is fine.
  for (const id of [...ids].sort((a, b) => b - a)) {
    const gone = await request.delete(`/api/assets/${id}?confirm=true`);
    expect([200, 204, 404], `deleting asset ${id}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
}

/** The assets of a plant a stopped run left (`W11 <digits>` and its children). */
const isPlant = (name: string) => /^W11 \d+( |$)/.test(name);

// ---------------------------------------------------------------------------------------------------------------------------------
// The month and the seeded history

/** The site-local month before the current one (`2026-09`): the month the seeder leaves complete, and the one every case closes. */
function previousMonth(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const [y, m] = month === 1 ? [year - 1, 12] : [year, month - 1];
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** The page's own month text (`September 2026`), which is also what the dialogs' titles and the audit sentences use. */
function monthLabel(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(year, m - 1, 1)));
}

/**
 * Runs the seeder inside the api container of the scratch stack. A second run finds `seeded-history` and exits 1 with "already exists": that is a
 * re-run on a stack that kept an earlier seed, and is fine. Any other failure (the raw-retention refusal near a month end, a database error, exit 2)
 * fails the suite with the seeder's own words.
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

async function findSeeded(request: APIRequestContext): Promise<Seeded> {
  const assets = await json<ApiAsset[]>(request, "/api/assets");
  const idOf = (name: string): number => {
    const found = assets.find((a) => a.name === name);
    expect(found, `the seeder made the asset "${name}"`).toBeTruthy();
    return found!.id;
  };
  const source = (await json<ApiSource[]>(request, "/api/sources")).find((s) => s.name === SEED_SOURCE);
  expect(source, `the seeder made the source ${SEED_SOURCE}`).toBeTruthy();
  const points = await json<ApiPoint[]>(request, `/api/sources/${source!.id}/points`);
  const pointC = points.find((p) => p.address === PANEL_C_ADDRESS);
  expect(pointC?.mapping, "Panel C's point is mapped").toBeTruthy();
  return { rootId: idOf(SEED_ROOT), aId: idOf(PANEL_A), bId: idOf(PANEL_B), cId: idOf(PANEL_C), sourceId: source!.id, mappingC: pointC!.mapping!.id };
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

// ---------------------------------------------------------------------------------------------------------------------------------
// Billing through the API

const costsOf = (request: APIRequestContext, month: string) => json<Costs>(request, `/api/billing/costs?month=${month}`);

/** The costs body as a closed month must keep answering it: everything but `live`. */
function withoutLive(costs: Costs): Omit<Costs, "live"> {
  const copy = { ...costs };
  delete copy.live;
  return copy;
}

/** The figures of a body (not who closed it): an open month and its closed copy have the same ones at the moment of closing. */
const figuresOf = (costs: Omit<Costs, "live">) => ({ month: costs.month, timezone: costs.timezone, currency: costs.currency, days: costs.days, assets: costs.assets });

async function csvOf(request: APIRequestContext, month: string): Promise<{ bytes: Buffer; name: string }> {
  const response = await request.get(`/api/billing/costs.csv?month=${month}`);
  expect(response.ok(), `GET the CSV of ${month}: ${response.status()} ${await response.text()}`).toBe(true);
  const name = /filename="([^"]+)"/.exec(response.headers()["content-disposition"] ?? "")?.[1] ?? "";
  return { bytes: await response.body(), name };
}

async function keep(request: APIRequestContext): Promise<Kept> {
  const csv = await csvOf(request, world.month);
  return { costs: withoutLive(await costsOf(request, world.month)), csv: csv.bytes, csvName: csv.name };
}

async function closeViaApi(request: APIRequestContext, note: string): Promise<void> {
  const made = await request.post(`/api/billing/months/${world.month}/close`, { data: { note } });
  expect(made.status(), `closing ${world.month}: ${await made.text()}`).toBe(201);
  world.kept = null;
}

async function reopenViaApi(request: APIRequestContext, note: string): Promise<void> {
  const made = await request.post(`/api/billing/months/${world.month}/reopen`, { data: { note } });
  expect(made.status(), `reopening ${world.month}: ${await made.text()}`).toBe(200);
  world.kept = null;
}

/** The month is closed, and the kept reference is the figures it answers now. */
async function ensureClosed(request: APIRequestContext): Promise<Kept> {
  if ((await costsOf(request, world.month)).closed === null) await closeViaApi(request, CLOSE_NOTE);
  world.kept ??= await keep(request);
  return world.kept;
}

async function ensureOpen(request: APIRequestContext): Promise<void> {
  if ((await costsOf(request, world.month)).closed !== null) await reopenViaApi(request, "w11 puts the month back");
}

const rowOf = (costs: { assets: CostsAsset[] }, name: string): CostsAsset => {
  const row = costs.assets.find((a) => a.name === name);
  expect(row, `the costs have a row for ${name}`).toBeTruthy();
  return row!;
};

// The three writes of `frozen`, each made once. A later case that needs the world to differ from the closed copy calls ensureDifference.

async function moveBUnderA(request: APIRequestContext): Promise<void> {
  if (world.moved) return;
  const moved = await request.post("/api/assets/move", { data: { moves: [{ ids: [seeded().bId], parent_id: seeded().aId }] } });
  expect(moved.status(), `moving ${PANEL_B} under ${PANEL_A}: ${await moved.text()}`).toBe(200);
  world.moved = true;
}

/** A rate for "Seeded demo" from 2020-01-01 (before the month) that differs from the one the panels have: the old rate plus 0.25. Made once, then patched. */
async function changeRate(request: APIRequestContext): Promise<void> {
  if (world.tariffId === 0) {
    const old = rowOf(await costsOf(request, world.month), PANEL_A).rate_per_kwh ?? 0.1;
    const rate = Math.round((old + 0.25) * 100) / 100;
    const made = await request.post("/api/tariffs", { data: { asset_id: seeded().rootId, rate_per_kwh: rate, effective_from: "2020-01-01" } });
    expect(made.status(), `a rate for "${SEED_ROOT}": ${await made.text()}`).toBe(201);
    world.tariffId = ((await made.json()) as { id: number }).id;
    world.rate = rate;
    return;
  }
  const rate = Math.round((world.rate + 0.25) * 100) / 100;
  const patched = await request.patch(`/api/tariffs/${world.tariffId}`, { data: { rate_per_kwh: rate } });
  expect(patched.status(), `changing the rate of "${SEED_ROOT}": ${await patched.text()}`).toBe(200);
  world.rate = rate;
}

async function unmapC(request: APIRequestContext): Promise<void> {
  if (world.unmapped) return;
  const gone = await request.delete(`/api/mappings/${seeded().mappingC}`);
  expect(gone.status(), `unmapping ${PANEL_C}: ${await gone.text()}`).toBe(204);
  world.unmapped = true;
}

/** A closed month whose copy differs from today's figures (a later case needs the delta line): changes a rate when nothing differs yet. */
async function ensureDifference(request: APIRequestContext): Promise<void> {
  if ((await costsOf(request, world.month)).live?.differs) return;
  await changeRate(request);
  expect((await costsOf(request, world.month)).live?.differs, "today's rates now differ from the closed copy").toBe(true);
}

/** The costs body (minus `live`) and the CSV are exactly the kept ones; returns the body so the caller can read `live`. */
async function expectKept(request: APIRequestContext, kept: Kept, when: string): Promise<Costs> {
  const costs = await costsOf(request, world.month);
  expect(withoutLive(costs), `${when}: the costs body (minus live) is the kept one`).toEqual(kept.costs);
  const csv = await csvOf(request, world.month);
  expect(csv.name, `${when}: the CSV file name`).toBe(`billing-${world.month}-closed.csv`);
  expect(csv.bytes.equals(kept.csv), `${when}: the CSV bytes are the kept ones`).toBe(true);
  return costs;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The browser

const GALLERY = fileURLToPath(new URL("../../.superpowers/sdd/overnight-w7/gallery/W11/", import.meta.url));
async function shot(page: Page, name: string): Promise<void> {
  if (process.env.W11_GALLERY !== "1") return;
  mkdirSync(GALLERY, { recursive: true });
  await page.screenshot({ path: `${GALLERY}${name}.png` });
}

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const closeButton = (page: Page) => page.getByRole("button", { name: CLOSE_BUTTON, exact: true });
const reopenButton = (page: Page) => page.getByRole("button", { name: REOPEN_BUTTON, exact: true });
const downloadButton = (page: Page) => page.getByRole("button", { name: "Download CSV", exact: true });
const chip = (page: Page) => page.locator(".billing-page .closed-chip");
const closedBox = (page: Page) => page.locator(".billing-page .closed-box");
const byLine = (page: Page) => closedBox(page).locator(".closed-line:not(.closed-note)");
const noteLine = (page: Page) => closedBox(page).locator(".closed-note");
const deltaLine = (page: Page) => page.locator(".billing-page .live-delta");
const table = (page: Page) => page.locator("table.billing");
const nameCell = (page: Page, name: string) => table(page).locator('tbody th[scope="row"]').filter({ hasText: new RegExp(`^${name}$`) });

/** The Year and Month selects (the picker beside Previous and Next) set to `month`. */
async function pickMonth(page: Page, month: string): Promise<void> {
  const [year, m] = month.split("-").map(Number);
  await page.getByLabel("Year", { exact: true }).selectOption(String(year));
  await page.getByLabel("Month", { exact: true }).selectOption(String(m));
  await expect(page.locator(".billing-page .month-label")).toHaveText(monthLabel(month));
}

/** The Billing page on `month`, with its table drawn (the Close/Reopen control comes with the costs, so a lookup after this is a real answer). */
async function openBilling(page: Page, month: string): Promise<void> {
  await page.goto("/billing");
  await expect(heading1(page, "Billing")).toBeVisible();
  await pickMonth(page, month);
  await expect(table(page)).toBeVisible();
}

/** The Close month / Reopen month dialog and its parts. */
function monthDialog(page: Page, title: string, noteLabel: string, confirm: string) {
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  return {
    dialog,
    note: dialog.getByRole("textbox", { name: noteLabel, exact: true }),
    cancel: dialog.getByRole("button", { name: "Cancel", exact: true }),
    go: dialog.getByRole("button", { name: confirm, exact: true }),
    count: dialog.locator(".month-count"),
  };
}
const closeDialog = (page: Page) => monthDialog(page, `Close ${monthLabel(world.month)}`, "Note (optional)", "Close month");
const reopenDialog = (page: Page) => monthDialog(page, `Reopen ${monthLabel(world.month)}`, "Reason", "Reopen month");

async function boxOf(locator: Locator, what: string): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  return box!;
}

/**
 * The keyboard path of a dialog from its opener: Enter on the opener opens it with the focus in the note, Tab goes Cancel, the confirming button,
 * and round to the note; Shift+Tab goes back the other way; Escape closes it and the opener has the focus again. Leaves the dialog closed.
 */
async function keyboardPath(page: Page, opener: Locator, form: ReturnType<typeof monthDialog>): Promise<void> {
  await opener.focus();
  await page.keyboard.press("Enter");
  await expect(form.dialog).toBeVisible();
  await expect(form.note, "the focus starts in the note").toBeFocused();
  await page.keyboard.press("Tab");
  await expect(form.cancel, "Tab goes to Cancel").toBeFocused();
  await page.keyboard.press("Tab");
  await expect(form.go, "then to the confirming button").toBeFocused();
  await page.keyboard.press("Tab");
  await expect(form.note, "and round to the note: the focus stays inside the dialog").toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(form.go, "Shift+Tab goes back round to the confirming button").toBeFocused();
  await page.keyboard.press("Escape");
  await expect(form.dialog).toBeHidden();
  await expect(opener, "Escape gives the focus back to the button that opened the dialog").toBeFocused();
}

/** Cancel and the confirming button are whole inside the window, and nothing in the dialog or the page scrolls sideways. */
async function expectDialogInWindow(page: Page, form: ReturnType<typeof monthDialog>, when: string): Promise<void> {
  const view = page.viewportSize()!;
  for (const [what, locator] of [["Cancel", form.cancel], ["the confirming button", form.go]] as const) {
    const box = await boxOf(locator, what);
    expect(box.x, `${when}: ${what} is inside the window (left)`).toBeGreaterThanOrEqual(0);
    expect(box.y, `${when}: ${what} is inside the window (top)`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${when}: ${what} is inside the window (right)`).toBeLessThanOrEqual(view.width);
    expect(box.y + box.height, `${when}: ${what} is inside the window (bottom)`).toBeLessThanOrEqual(view.height);
  }
  const sideways = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, dialog: dialog ? dialog.scrollWidth - dialog.clientWidth : 0 };
  });
  expect(sideways, `${when}: nothing scrolls sideways with the dialog open`).toEqual({ page: 0, dialog: 0 });
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

/** Problems of the page's top: a piece with no box, one that sticks out of the window sideways, or two that overlap. Empty when the layout is right. */
async function layoutProblems(page: Page, pieces: [string, Locator][]): Promise<string[]> {
  const view = page.viewportSize()!;
  const problems: string[] = [];
  const boxes: [string, Box][] = [];
  for (const [name, locator] of pieces) {
    const box = await locator.boundingBox();
    if (box === null) {
      problems.push(`${name} has no box`);
      continue;
    }
    boxes.push([name, box]);
    if (box.x < -0.5 || box.x + box.width > view.width + 0.5) problems.push(`${name} sticks out sideways (from ${box.x} to ${box.x + box.width} in a window ${view.width} wide)`);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (overlaps(boxes[i][1], boxes[j][1])) problems.push(`${boxes[i][0]} and ${boxes[j][0]} overlap`);
    }
  }
  return problems;
}

async function readFile(download: Download): Promise<Buffer> {
  const path = await download.path();
  expect(path, "the download was saved").not.toBeNull();
  return readFileSync(path!);
}

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W11: close month", () => {
  test.skip(!SCRATCH, SKIP_MESSAGE);

  test.beforeAll(async ({ browser }) => {
    if (!SCRATCH) return;
    test.setTimeout(300_000);
    await asAdmin(browser, async (request) => {
      await removeAccounts(request); // an earlier run that stopped half way
      await deleteAssets(request, (await json<ApiAsset[]>(request, "/api/assets")).filter((a) => isPlant(a.name)).map((a) => a.id));
      world.month = previousMonth((await json<{ timezone: string }>(request, "/api/site")).timezone);
    });
    seedHistory();
    world.seeded = await asAdmin(browser, findSeeded);
  });

  test.afterAll(async ({ browser }) => {
    if (!SCRATCH) return;
    test.setTimeout(240_000);
    // Every step is tried whatever the one before it did, and the failures are asserted once at the end.
    const failures: string[] = [];
    const attempt = async (what: string, step: () => Promise<void>) => {
      try {
        await step();
      } catch (e) {
        failures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    await asAdmin(browser, async (request) => {
      await attempt("the month", async () => {
        if (world.month !== "") await ensureOpen(request);
      });
      await attempt("the accounts and roles", () => removeAccounts(request));
      await attempt("the plant of the warnings case", async () => {
        await deleteAssets(request, (await json<ApiAsset[]>(request, "/api/assets")).filter((a) => isPlant(a.name)).map((a) => a.id));
      });
      await attempt("the seeded history", () => removeSeed(request));
    });
    expect(failures, "the clean-up left something behind").toEqual([]);
  });

  // 1 ---------------------------------------------------------------------------------------------------------------------------

  test("close: Close month... with a note freezes the previous month; the page says who closed it and when, shows the note and the Closed chip", async ({ page }) => {
    test.setTimeout(240_000);
    const month = world.month;
    await signInAs(page, ADMIN);

    const open = await costsOf(page.request, month);
    const openCsv = await csvOf(page.request, month);
    await test.step("the previous month starts open, with the seeded history in it", async () => {
      expect(open.closed, `${month} starts open`).toBeNull();
      expect(open.live, "an open month has no live part").toBeUndefined();
      const total = rowOf(open, SEED_ROOT).total;
      expect(total?.kwh ?? 0, `the seeded history left energy in ${month}`).toBeGreaterThan(0);
      expect(openCsv.name).toBe(`billing-${month}.csv`);
    });

    await test.step("Previous month from the current month lands on it, with Close month... and no Closed chip", async () => {
      await page.goto("/billing");
      await expect(heading1(page, "Billing")).toBeVisible();
      await page.getByRole("button", { name: "Previous month", exact: true }).click();
      await expect(page.locator(".billing-page .month-label")).toHaveText(monthLabel(month));
      await expect(table(page)).toBeVisible();
      await expect(nameCell(page, PANEL_A)).toBeVisible();
      await expect(closeButton(page)).toBeVisible();
      await expect(reopenButton(page)).toHaveCount(0);
      await expect(chip(page)).toHaveCount(0);
      await expect(closedBox(page)).toHaveCount(0);
    });

    const form = closeDialog(page);
    await test.step("the dialog asks for a note that is optional, and Cancel closes it without closing the month", async () => {
      await closeButton(page).click();
      await expect(form.dialog).toBeVisible();
      await expect(form.note).toBeFocused();
      await expect(form.go, "an optional note leaves the button ready").not.toHaveAttribute("aria-disabled", "true");
      await form.cancel.click();
      await expect(form.dialog).toBeHidden();
      await expect(closeButton(page), "Cancel gives the focus back").toBeFocused();
      expect((await costsOf(page.request, month)).closed, "Cancel closed nothing").toBeNull();
    });

    await test.step("a note, then Close month: the banner, the note and the chip", async () => {
      await closeButton(page).click();
      await form.note.fill(CLOSE_NOTE);
      await shot(page, "03-close-dialog");
      await form.go.click();
      await expect(form.dialog).toBeHidden();
      await expect(byLine(page)).toHaveText(/^Closed by admin on .+ \d{4}\.$/);
      await expect(noteLine(page)).toHaveText(CLOSE_NOTE);
      await expect(chip(page)).toHaveText("Closed");
      await expect(reopenButton(page)).toBeVisible();
      await expect(closeButton(page)).toHaveCount(0);
      await expect(heading1(page, "Billing"), "the button that opened the dialog is gone, so the heading has the focus").toBeFocused();
    });

    await test.step("the closed figures and the CSV are what the open month gave a moment before", async () => {
      world.kept = await keep(page.request);
      expect(world.kept.costs.closed).toMatchObject({ closed_name: "admin", note: CLOSE_NOTE });
      expect(world.kept.costs.closed?.total_kwh ?? 0).toBeGreaterThan(0);
      expect(figuresOf(world.kept.costs), "the stored figures are the month's figures at the moment of closing").toEqual(figuresOf(open));
      expect(world.kept.csvName).toBe(`billing-${month}-closed.csv`);
      expect(world.kept.csv.equals(openCsv.bytes), "the closed CSV has the open month's bytes").toBe(true);
    });
  });

  // 2 ---------------------------------------------------------------------------------------------------------------------------

  test("frozen: moving an asset, changing a rate and unmapping a point leave the closed month's figures and CSV byte-identical, and the page shows what today would give", async ({ page }) => {
    test.setTimeout(240_000);
    const month = world.month;
    await signInAs(page, ADMIN);
    const kept = await ensureClosed(page.request);

    await test.step("before any change the closed month answers as kept and today's figures agree with it", async () => {
      const costs = await expectKept(page.request, kept, "before any change");
      expect(costs.live, "today's figures are there").toBeTruthy();
      expect(costs.live?.differs, "nothing differs yet").toBe(false);
    });

    await test.step(`${PANEL_B} moves under ${PANEL_A}`, async () => {
      await moveBUnderA(page.request);
      const costs = await expectKept(page.request, kept, "after the move");
      expect(costs.live?.differs, "today's tree differs from the closed copy").toBe(true);
      expect(costs.live?.changed_assets ?? 0, "the moved asset and the totals above it differ").toBeGreaterThanOrEqual(1);
    });

    await test.step(`"${SEED_ROOT}" gets a different rate from before the month`, async () => {
      const before = rowOf(kept.costs, PANEL_A).rate_per_kwh;
      await changeRate(page.request);
      const costs = await expectKept(page.request, kept, "after the new rate");
      expect(costs.live?.differs, "today's rates differ from the closed copy").toBe(true);
      expect(rowOf(kept.costs, PANEL_A).rate_per_kwh, "the closed copy still shows the old rate").toBe(before);
      expect(world.rate, "the new rate is not the old one").not.toBe(before);
    });

    await test.step(`${PANEL_C} is unmapped`, async () => {
      await unmapC(page.request);
      const costs = await expectKept(page.request, kept, "after the unmapping");
      expect(costs.live?.differs, "today's mappings differ from the closed copy").toBe(true);
    });

    await test.step("the page still shows the closed copy and says what today would give", async () => {
      await openBilling(page, month);
      await expect(byLine(page)).toHaveText(/^Closed by admin on /);
      await expect(chip(page)).toHaveText("Closed");
      await expect(deltaLine(page)).toHaveText(/^Today's tree and rates would give /);
      const before = rowOf(kept.costs, PANEL_B);
      await expect(nameCell(page, PANEL_B), "Panel B is still where it was when the month was closed").toHaveAttribute("title", before.path);
      const live = await json<ApiAsset[]>(page.request, "/api/assets");
      expect(live.find((a) => a.id === seeded().bId)?.parent_id, "while the live tree has it under Panel A").toBe(seeded().aId);
    });

    await test.step("Download CSV on the page gives the closed month's file", async () => {
      const [download] = await Promise.all([page.waitForEvent("download"), downloadButton(page).click()]);
      expect(download.suggestedFilename()).toBe(`billing-${month}-closed.csv`);
      expect((await readFile(download)).equals(kept.csv), "the downloaded bytes are the kept ones").toBe(true);
    });
  });

  // 3 ---------------------------------------------------------------------------------------------------------------------------

  test("reopen: a reason of 5 characters is needed; then the banner and the chip are gone, the figures are the live ones, and the audit log says both", async ({ page }) => {
    test.setTimeout(240_000);
    const month = world.month;
    await signInAs(page, ADMIN);
    const kept = await ensureClosed(page.request);
    await ensureDifference(page.request);
    await openBilling(page, month);
    await expect(chip(page)).toHaveText("Closed");

    const form = reopenDialog(page);
    const posted: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/reopen")) posted.push(request.url());
    });

    await test.step("a reason of 4 characters leaves the button inert; a click sends nothing", async () => {
      await reopenButton(page).click();
      await expect(form.dialog).toBeVisible();
      await expect(form.note).toBeFocused();
      await form.note.fill("abcd");
      await expect(form.count).toHaveText("4/5");
      await expect(form.go).toHaveAttribute("aria-disabled", "true");
      await form.go.click({ force: true }); // an aria-disabled button is "not enabled" to Playwright: force skips that check
      await expect(form.dialog, "the dialog stays").toBeVisible();
      await form.note.fill("  abcd  ");
      await expect(form.go, "blanks at the ends do not count").toHaveAttribute("aria-disabled", "true");
      await form.go.click({ force: true });
      expect(posted, "nothing was sent").toEqual([]);
      await expect(form.dialog).toBeVisible();
      await shot(page, "04-reopen-dialog");
    });

    await test.step("5 characters make the button ready", async () => {
      await form.note.fill("abcde");
      await expect(form.count).toHaveText("5/500");
      await expect(form.go).not.toHaveAttribute("aria-disabled", "true");
    });

    await test.step("with the reason, Reopen month takes the banner and the chip away", async () => {
      await form.note.fill(REOPEN_REASON);
      await form.go.click();
      await expect(form.dialog).toBeHidden();
      expect(posted).toHaveLength(1);
      await expect(closedBox(page)).toHaveCount(0);
      await expect(chip(page)).toHaveCount(0);
      await expect(deltaLine(page)).toHaveCount(0);
      await expect(closeButton(page), "the month is open again and can be closed").toBeVisible();
      await expect(reopenButton(page)).toHaveCount(0);
      await expect(heading1(page, "Billing"), "the button that opened the dialog is gone, so the heading has the focus").toBeFocused();
    });

    await test.step("the costs are the live figures now, and differ from the closed copy", async () => {
      const costs = await costsOf(page.request, month);
      expect(costs.closed).toBeNull();
      expect(costs.live, "an open month has no live part").toBeUndefined();
      expect(figuresOf(costs), "the figures are not the kept ones").not.toEqual(figuresOf(kept.costs));
      expect(rowOf(costs, PANEL_B).parent_id, "Panel B is under Panel A as the live tree has it").toBe(seeded().aId);
      expect(rowOf(kept.costs, PANEL_B).parent_id, "the closed copy had it under the site").toBe(seeded().rootId);
      const csv = await csvOf(page.request, month);
      expect(csv.name).toBe(`billing-${month}.csv`);
      expect(csv.bytes.equals(kept.csv), "the CSV is the live one, not the kept one").toBe(false);
      await expect(nameCell(page, PANEL_B)).toHaveAttribute("title", rowOf(costs, PANEL_B).path);
    });

    const label = monthLabel(month);
    await test.step("the audit log has billing.closed and billing.reopened (API)", async () => {
      const log = await json<ApiAudit>(page.request, "/api/audit?action=billing.*&limit=100");
      const closes = log.items.filter((e) => e.action === "billing.closed" && e.detail.month === month);
      const reopens = log.items.filter((e) => e.action === "billing.reopened" && e.detail.month === month);
      expect(closes.length, "billing.closed entries for the month").toBeGreaterThanOrEqual(1);
      expect(reopens.length, "billing.reopened entries for the month").toBeGreaterThanOrEqual(1);
      expect(closes.map((e) => e.detail.note)).toContain(CLOSE_NOTE);
      expect(reopens.map((e) => e.detail.note), "a reopen holds the reason").toContain(REOPEN_REASON);
    });

    await test.step("the Audit page lists both in words, with no database ids", async () => {
      await page.goto("/audit?action=billing.*");
      await expect(heading1(page, "Audit log")).toBeVisible();
      const rows = page.locator(".audit-table tbody tr[data-entry-id]");
      const closed = rows.filter({ hasText: `Closed billing for ${label}` }).first();
      const reopened = rows.filter({ hasText: `Reopened billing for ${label}` }).first();
      await expect(closed).toBeVisible();
      await expect(reopened).toBeVisible();
      await expect(closed.locator(".what")).toHaveText(new RegExp(`^Closed billing for ${label}( \\(.+\\))?$`));
      await expect(reopened.locator(".what")).toHaveText(`Reopened billing for ${label}: ${REOPEN_REASON}`);
      for (const row of [closed, reopened]) expect(await row.locator(".what-text").innerText(), "no database id in the sentence").not.toMatch(/#\d|\bid\b/i);
      await shot(page, "05-audit");
    });
  });

  // 4 ---------------------------------------------------------------------------------------------------------------------------

  test("permission: a role without billing.close, an Operator and a Viewer see no Close or Reopen control and the API answers 403; a role with billing.close sees it", async ({ browser }) => {
    test.setTimeout(300_000);
    const month = world.month;
    await asAdmin(browser, async (request) => {
      await removeAccounts(request);
      await createRole(request, ROLE_NO_CLOSE, ["billing.view", "billing.export"]);
      await createRole(request, ROLE_CLOSER, ["billing.view", "billing.close"]);
      for (const who of [VIEWER, OPERATOR, NO_CLOSE, CLOSER]) await createAccount(request, who);
      await ensureOpen(request);
    });

    /** A person signs in through the sign-in page and opens the month. */
    const asUser = async (who: Account, use: (page: Page) => Promise<void>) => {
      const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto("/login");
        await page.getByLabel("Username").fill(who.username);
        await page.getByLabel("Password", { exact: true }).fill(who.password);
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(userBlock(page)).toContainText(who.username);
        await expect(userBlock(page)).toContainText(roleLabel(who.role));
        await openBilling(page, month);
        await use(page);
      } finally {
        await context.close();
      }
    };
    const withoutControl = [VIEWER, OPERATOR, NO_CLOSE];

    await test.step("the month is open: nobody without billing.close sees Close month...", async () => {
      for (const who of withoutControl) {
        await asUser(who, async (page) => {
          await expect(downloadButton(page), `${who.username} reads and exports`).toBeVisible();
          await expect(closeButton(page), `${who.username} has no Close month...`).toHaveCount(0);
          await expect(reopenButton(page)).toHaveCount(0);
        });
      }
    });

    await test.step("the role with billing.close sees Close month... (and, without billing.export, no Download CSV)", async () => {
      await asUser(CLOSER, async (page) => {
        await expect(closeButton(page)).toBeVisible();
        await expect(reopenButton(page)).toHaveCount(0);
        await expect(downloadButton(page)).toHaveCount(0);
      });
    });

    await asAdmin(browser, async (request) => {
      await closeViaApi(request, CLOSE_NOTE);
    });

    await test.step("the month is closed: they see the banner and the Closed chip but no Reopen month...", async () => {
      for (const who of withoutControl) {
        await asUser(who, async (page) => {
          await expect(chip(page)).toHaveText("Closed");
          await expect(byLine(page)).toBeVisible();
          await expect(reopenButton(page), `${who.username} has no Reopen month...`).toHaveCount(0);
          await expect(closeButton(page)).toHaveCount(0);
          if (who === NO_CLOSE) await shot(page, "06-no-close-permission");
        });
      }
      await asUser(CLOSER, async (page) => {
        await expect(reopenButton(page)).toBeVisible();
        await expect(closeButton(page)).toHaveCount(0);
      });
    });

    await test.step("the API refuses both routes with 403, whatever the page shows, and changes nothing", async () => {
      for (const who of withoutControl) {
        await as(browser, who, async (request) => {
          const close = await request.post(`/api/billing/months/${month}/close`, { data: {} });
          expect(close.status(), `${who.username} closes ${month}: ${await close.text()}`).toBe(403);
          expect(await detail(close)).toBe(REFUSED);
          const reopen = await request.post(`/api/billing/months/${month}/reopen`, { data: { note: "a long enough reason" } });
          expect(reopen.status(), `${who.username} reopens ${month}: ${await reopen.text()}`).toBe(403);
          expect(await detail(reopen)).toBe(REFUSED);
        });
      }
      // The control: the gate lets the role with billing.close through (a month that is not over yet is refused by the rules, never closed).
      await as(browser, CLOSER, async (request) => {
        const probe = await request.post("/api/billing/months/2099-12/close", { data: {} });
        expect([409, 422], `${CLOSER.username} passes the gate: ${probe.status()} ${await probe.text()}`).toContain(probe.status());
      });
      await asAdmin(browser, async (request) => {
        expect((await costsOf(request, month)).closed, "the month is still closed").not.toBeNull();
      });
    });
  });

  // 5 ---------------------------------------------------------------------------------------------------------------------------

  test("placement: at 1440x900 and 1024x640 nothing overlaps or scrolls sideways, and both dialogs keep their buttons inside the window with a working keyboard path", async ({ page, browser }) => {
    test.setTimeout(300_000);
    const month = world.month;
    await signInAs(page, ADMIN);
    await ensureClosed(page.request);
    await ensureDifference(page.request);

    const sizes = [{ width: 1440, height: 900, shot: "01-closed-1440" }, { width: 1024, height: 640, shot: "02-closed-1024" }];
    for (const size of sizes) {
      await page.setViewportSize({ width: size.width, height: size.height });
      const at = `${size.width}x${size.height}`;

      await test.step(`${at}: the closed month's top does not overlap and the page does not scroll sideways`, async () => {
        await openBilling(page, month);
        await expect(byLine(page)).toBeVisible();
        await expect(deltaLine(page)).toBeVisible();
        const problems = await layoutProblems(page, [
          ["the title", heading1(page, "Billing")],
          ["Reopen month...", reopenButton(page)],
          ["Download CSV", downloadButton(page)],
          ["the month bar", page.locator(".billing-page .billing-bar")],
          ["the banner", closedBox(page).locator(".banner")],
          ["the line about today", deltaLine(page)],
          ["the table", page.locator(".billing-page .table-wrap")],
        ]);
        expect(problems, `the layout at ${at}`).toEqual([]);
        const banner = await boxOf(closedBox(page).locator(".banner"), "the banner");
        const delta = await boxOf(deltaLine(page), "the line about today");
        const grid = await boxOf(page.locator(".billing-page .table-wrap"), "the table");
        expect(banner.y + banner.height, "the banner is above the line about today").toBeLessThanOrEqual(delta.y + 0.5);
        expect(delta.y + delta.height, "the line about today is above the table").toBeLessThanOrEqual(grid.y + 0.5);
        const sideways = await page.evaluate(() => ({
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          section: (document.querySelector(".billing-page") as HTMLElement).scrollWidth - (document.querySelector(".billing-page") as HTMLElement).clientWidth,
        }));
        expect(sideways, `nothing scrolls sideways at ${at}`).toEqual({ page: 0, section: 0 });
        await shot(page, size.shot);
      });

      await test.step(`${at}: the Reopen dialog is inside the window and its keyboard path works`, async () => {
        const form = reopenDialog(page);
        await reopenButton(page).click();
        await expect(form.dialog).toBeVisible();
        await expectDialogInWindow(page, form, `Reopen at ${at}`);
        await form.cancel.click();
        await expect(form.dialog).toBeHidden();
        await keyboardPath(page, reopenButton(page), form);
      });
    }

    await asAdmin(browser, ensureOpen); // the Close dialog needs an open month
    for (const size of sizes) {
      await page.setViewportSize({ width: size.width, height: size.height });
      const at = `${size.width}x${size.height}`;
      await test.step(`${at}: the open month's Close dialog is inside the window and its keyboard path works`, async () => {
        await openBilling(page, month);
        await expect(closeButton(page)).toBeVisible();
        const problems = await layoutProblems(page, [
          ["the title", heading1(page, "Billing")],
          ["Close month...", closeButton(page)],
          ["Download CSV", downloadButton(page)],
          ["the month bar", page.locator(".billing-page .billing-bar")],
          ["the table", page.locator(".billing-page .table-wrap")],
        ]);
        expect(problems, `the open month's layout at ${at}`).toEqual([]);
        const form = closeDialog(page);
        await closeButton(page).click();
        await expect(form.dialog).toBeVisible();
        await expectDialogInWindow(page, form, `Close at ${at}`);
        await form.cancel.click();
        await expect(form.dialog).toBeHidden();
        await keyboardPath(page, closeButton(page), form);
      });
    }
  });

  // 6 ---------------------------------------------------------------------------------------------------------------------------

  test("warnings: the Move to... dialog of a move that changes a rate says that closed months keep their billed figures", async ({ page }) => {
    test.setTimeout(180_000);
    await signInAs(page, ADMIN);
    const ids: number[] = [];
    const create = async (key: string, parent: number | null, rate?: number): Promise<number> => {
      const name = key === "" ? PLANT : `${PLANT} ${key}`;
      const made = await page.request.post("/api/assets", { data: { name, parent_id: parent, kind: "generic", sort_order: 0 } });
      expect(made.status(), `creating ${name}: ${await made.text()}`).toBe(201);
      const id = ((await made.json()) as { id: number }).id;
      ids.push(id);
      if (rate !== undefined) {
        const tariff = await page.request.post("/api/tariffs", { data: { asset_id: id, rate_per_kwh: rate, effective_from: "2020-01-01" } });
        expect(tariff.status(), `the rate of ${name}: ${await tariff.text()}`).toBe(201);
      }
      return id;
    };
    const rack = `${PLANT} Rack B1`;
    try {
      // The plant: two halls under one root with a different rate each, and a rack in the second. Moving that rack into the first hall changes its rate.
      const root = await create("", null);
      await create("Hall A", root, 0.111);
      const hallB = await create("Hall B", root, 0.222);
      await create("Rack B1", hallB);

      await page.goto("/assets");
      await expect(treeLink(page, PLANT)).toBeVisible();
      await treeLink(page, rack).scrollIntoViewIfNeeded();
      const dialog = page.getByRole("dialog", { name: `Move "${rack}" to...`, exact: true });
      await treeLink(page, rack).focus();
      await page.keyboard.press("M");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("searchbox", { name: "Search places", exact: true }).fill(`${PLANT} Hall A`);
      await dialog.getByRole("radio", { name: `${PLANT} Hall A`, exact: true }).check();
      await dialog.getByRole("button", { name: "Move", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "Move anyway", exact: true }), "the button now asks again").toBeVisible();
      const message = dialog.locator(".place-message");
      await expect(message).toContainText("changes its rate from 0.222");
      await expect(message).toContainText(`Months that are not closed are recalculated at the new place, and the totals of both branches change. ${KEPT}`);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toBeHidden();
    } finally {
      await deleteAssets(page.request, ids);
    }
  });
});
