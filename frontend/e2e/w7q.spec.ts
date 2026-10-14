import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { rowAction, userBlock } from "./shell";

// W7q (the Asset kinds page you can tell apart and tidy: a Starter tag, four filters, checkboxes with Shift range / Space / Select all unused, delete
// several kinds in one go, the common data-centre kinds as the header's button with Add all 39 beside the filter, and no jump to the top after a delete)
// on the state the earlier projects leave behind: admin `admin` / `correct-horse`. The stack is SHARED and holds other kinds, so the spec makes
// its own and never deletes one it did not make: every name it makes starts `W7q <run> ` (the digits-only run suffix, as w7m/w7o, so a kind's default
// icon, a guess from its words, cannot be a keyword; it comes first so that this run's kinds are one block in the list and a leftover of a stopped run
// never sits between them), the account and the role start `w7q-`. afterAll removes, in this order, the assets, then the kinds (this run's own and the
// starter kinds the pack cases added that were NOT in the registry when the run began, unless assets of an earlier project use one: it stays, and is
// logged), then the account, then the role. Every step is tried and the failures are asserted once, at the end. beforeAll takes the registry's keys
// first and removes an account and a role that an earlier run left behind. The admin signs in through the API: the sign-in page is not what is tested.
//
// The cases are independent (workers is 1, so they still run in file order); each makes the kinds it needs, in one block named after the case:
//   scroll       1024x640, a list longer than the window by at least 600 px, a row in the middle of the window: delete ONE kind through the row menu and
//                the page stays where it was (1 px; the browser clamps scrollY when the document gets shorter, and that is not a jump), the focus is on
//                the menu button of the next row; then the same for a bulk delete of three, the focus on the filter in use. Also: Cancel of the New kind
//                form gives the focus back to New kind (the page leaves that button enabled while its own form is open, as a browser drops the focus
//                of a button that was disabled in the meantime; only a real browser shows it).
//   tag, filters the tag on Rack and on a pack kind, not on a W7q kind and not inside the label; the four counts match the rows; another filter clears
//                the ticks, the same filter again does not.
//   selecting    Shift+click and Shift+Space ADD a range, Space toggles, the header checkbox (none / some / all), Select all unused (its count is the
//                Unused filter's; Delete is NOT pressed on it, it would remove kinds this spec did not make), Clear and Escape; the focus is never on <body>.
//   bulk delete  three unused kinds of its own go and no others, with the toast; then one kind in use plus two unused: the dialog asks for a kind to move
//                to (the selection is not offered, Delete waits for a choice), the asset follows, and the audit log has one row per kind.
//   layout       the table's top does not move on the first tick at 1440, 1024 and 800 px, the sidebar expanded and minimised; the title is one line.
//   packs        the header's button adds exactly the common kinds that are missing, a second press says so and writes no audit row, Add all 39 adds
//                the rest and a second press says so; `?set=bogus` is 422.
//   permission   a role without Manage asset kinds sees the tag and the filters and no checkbox, no pack button, no bar; the API answers 403.
//
// Locators. A kind's row is found by its label as a whole (`.kind-label`; the tag sits beside the label, not in it). Playwright matches a name by
// case-insensitive SUBSTRING and "Delete" is also the start of dialog titles, so every button and dialog below is `exact: true` except the move
// dialog's select, whose label WRAPS it (`getByLabel("Move the assets to")`, no `exact`). A row's checkbox is "Select <name>", the header's is
// "Select all shown kinds"; the toolbar's slot is `.kinds-slot` and its count `.kinds-selected` (the page's one live line, no role="status").

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse" };
const RUN = Date.now().toString();
const PREFIX = `W7q ${RUN}`;

const READER_ROLE = "w7q-reader-role"; // See the Assets Tree and nothing else: no Manage asset kinds
const READER = { username: "w7q-reader", password: "w7q-reader-pass", role: READER_ROLE };

/** The ten kinds migration 0010 seeds (core/asset_kinds.py SEEDED_STARTERS): starters that are not in the pack. */
const SEEDED = ["Site", "Building", "Room", "Row", "Rack", "Panel", "Meter", "Circuit", "Other equipment", "generic"];
/** The common data-centre kinds (COMMON_NAMES): what the header's button adds. All of them are in STARTER. */
const COMMON = [
  "UPS", "Battery", "PDU", "RPP", "ATS", "STS", "Switchgear", "Transformer", "Generator", "Chiller", "CRAC", "Cooling tower", "Server",
  "Network switch", "Sensor", "Fire suppression",
];
/** The full pack (STARTER_PACK, in its order). The count is 39 there and in the toolbar's label: a change of the pack changes this list and that label. */
const STARTER = [
  "UPS", "Battery", "PDU", "RPP", "ATS", "STS", "Switchgear", "Busway", "Ring main unit", "Transformer", "Generator", "Fuel tank",
  "Chiller", "CRAC", "Air handling unit", "Cooling distribution unit", "Cooling tower", "Dry cooler", "Heat exchanger", "Pump", "Fan", "Valve",
  "Variable frequency drive", "Server", "Network switch", "Router", "Firewall", "Patch panel", "Cable tray", "Data hall",
  "Controller", "Sensor", "Smoke detector", "Humidity sensor", "Fire suppression", "Leak detector", "Camera", "Door", "Lighting",
];

interface ApiAsset { id: number; name: string; kind: string }
interface ApiKind { id: number; name: string; icon: string; asset_count: number; starter: boolean }
interface ApiRole { id: number; name: string; builtin: boolean }
interface ApiUser { id: number; username: string }
interface ApiAuditEntry { id: number; action: string; detail: Record<string, unknown> }
interface StarterAnswer { added: string[]; already_there: number }

/** The comparison key of a kind text, as the server and the front end make it (these names are plain ASCII). */
const keyOf = (name: string) => name.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
/** The names this run made (the prefix alone would also catch an earlier run's leftovers, which are not ours to remove). */
const mine = (name: string) => name.startsWith(`${PREFIX} `);
const exactly = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

let keysBefore = new Set<string>(); // the registry when the run began

// ---------------------------------------------------------------------------------------------------------------------------------
// Requests

async function signInAs(page: Page, who: { username: string; password: string }): Promise<void> {
  const login = await page.request.post("/api/login", { data: { username: who.username, password: who.password } });
  expect(login.ok(), `signing in as ${who.username}: ${login.status()} ${await login.text()}`).toBe(true);
}
const signIn = (page: Page) => signInAs(page, ADMIN);

/** Runs `use` with the request context of a fresh browser context in which `who` is signed in. */
async function as<T>(browser: Browser, who: { username: string; password: string }, use: (request: APIRequestContext) => Promise<T>): Promise<T> {
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

async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}
const assetsOf = (request: APIRequestContext) => json<ApiAsset[]>(request, "/api/assets");
const kindsOf = (request: APIRequestContext) => json<ApiKind[]>(request, "/api/asset-kinds");
/** The registry as one comparable string: what a refused write must leave exactly as it was. */
const registryOf = async (request: APIRequestContext) => JSON.stringify((await kindsOf(request)).map((k) => [k.id, k.name, k.icon, k.asset_count]));

async function makeKind(request: APIRequestContext, name: string, icon = "generic"): Promise<ApiKind> {
  const made = await request.post("/api/asset-kinds", { data: { name, icon } });
  expect(made.status(), `creating the kind ${name}: ${await made.text()}`).toBe(201);
  return (await made.json()) as ApiKind;
}

/** `count` kinds of this run, `W7q <run> <label> 01`, `... 02` ...: one block in the list, in this order (the numbers are padded). */
async function makeKinds(request: APIRequestContext, label: string, count: number): Promise<string[]> {
  const names: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    const name = `${PREFIX} ${label} ${String(n).padStart(2, "0")}`;
    await makeKind(request, name);
    names.push(name);
  }
  return names;
}

async function makeAsset(request: APIRequestContext, name: string, kind: string): Promise<ApiAsset> {
  const made = await request.post("/api/assets", { data: { name, parent_id: null, kind, sort_order: 0 } });
  expect(made.status(), `creating the asset ${name}: ${await made.text()}`).toBe(201);
  return (await made.json()) as ApiAsset;
}

/** Every account whose name starts with w7q-, then every custom role that does (a role an account holds cannot be deleted). */
async function removeAccounts(request: APIRequestContext): Promise<void> {
  for (const user of (await json<ApiUser[]>(request, "/api/users")).filter((u) => u.username.startsWith("w7q-"))) {
    const gone = await request.delete(`/api/users/${user.id}`);
    expect([204, 404], `deleting ${user.username}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
  for (const role of (await json<ApiRole[]>(request, "/api/roles")).filter((r) => !r.builtin && r.name.toLowerCase().startsWith("w7q-"))) {
    const gone = await request.delete(`/api/roles/${role.id}`);
    expect([204, 404], `deleting the role ${role.name}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
}

async function auditCount(request: APIRequestContext, action: string): Promise<number> {
  return (await json<{ total: number }>(request, `/api/audit?action=${action}&limit=1`)).total;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The browser

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const toast = (page: Page, text: string) => page.locator(".toast-stack .toast").filter({ hasText: text });
/** Two animation frames: whatever the page does about a viewport change or a keystroke has happened by then. */
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** A kind's row on the Asset kinds page, by its label as a whole ("W7q 1 pick 1" must not find "W7q 1 pick 10"). */
const kindRow = (page: Page, name: string) => page.getByRole("row").filter({ has: page.locator(".kind-label", { hasText: exactly(name) }) });
const kindCount = (page: Page, name: string) => kindRow(page, name).locator("td.kind-assets");
const rowBox = (page: Page, name: string) => page.getByRole("checkbox", { name: `Select ${name}`, exact: true });
const headerBox = (page: Page) => page.getByRole("checkbox", { name: "Select all shown kinds", exact: true });
const slot = (page: Page) => page.locator(".kinds-slot");
const selectedLine = (page: Page) => page.locator(".kinds-selected");
const idleButton = (page: Page) => slot(page).getByRole("button", { name: "Add all 39 data-centre kinds", exact: true });
const barButton = (page: Page, name: "Select all unused" | "Delete" | "Clear") => slot(page).getByRole("button", { name, exact: true });
const filterGroup = (page: Page) => page.getByRole("group", { name: "Show", exact: true });
const filterButton = (page: Page, label: "All" | "Starter" | "Yours" | "Unused") => filterGroup(page).getByRole("button", { name: new RegExp(`^${label} \\d+$`) });
const tableRows = (page: Page) => page.locator(".kinds-table tbody tr");
const pickedNames = (page: Page) => page.locator(".kinds-table tbody tr.is-picked .kind-label").allTextContents();

/** Opens the page and waits until the LIST is there (the heading is also in the loading skeleton, the table is not). */
async function openKinds(page: Page): Promise<void> {
  await page.goto("/assets/kinds");
  await expect(heading1(page, "Asset kinds")).toBeVisible();
  await expect(page.locator(".kinds-table")).toBeVisible();
}

/** What has the focus: its own name, or its text; "" for the page body (the focus fell off the page). */
const focusName = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "";
    return el.getAttribute("aria-label") ?? (el.textContent ?? "").trim();
  });

/** How far the page is scrolled, and how far it could be: the window's, and the table frame's own (if the layout scrolled inside one). */
const scrollNow = (page: Page) =>
  page.evaluate(() => ({
    y: window.scrollY,
    max: document.documentElement.scrollHeight - window.innerHeight,
    wrap: Math.max(0, ...[...document.querySelectorAll<HTMLElement>(".table-wrap")].map((el) => el.scrollTop)),
  }));

/** Puts the row in the middle of the window and checks that it is there with rows below it (so the browser has not clamped the scroll). */
async function centre(page: Page, row: Locator): Promise<void> {
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await settled(page);
  const [box, view] = [await row.boundingBox(), page.viewportSize()];
  expect(box && view, "the row is laid out").toBeTruthy();
  expect(box!.y, "the row is below the top quarter of the window").toBeGreaterThan(view!.height * 0.25);
  expect(box!.y + box!.height, "and above the bottom quarter").toBeLessThan(view!.height * 0.75);
  expect(await row.locator("xpath=following-sibling::tr").count(), "at least three rows are below it").toBeGreaterThanOrEqual(3);
}

/** Makes sure the sidebar is the way wanted (it starts the way the first width chose, and has no resize listener) and the page has stopped moving. */
async function sidebar(page: Page, want: "expanded" | "minimized"): Promise<void> {
  const shell = page.locator(".shell");
  if ((await shell.getAttribute("data-sidebar")) !== want) await page.locator(".side-toggle").click();
  await expect(shell).toHaveAttribute("data-sidebar", want);
  let last = -1;
  await expect
    .poll(async () => {
      const width = (await page.locator(".kinds-page").boundingBox())?.width ?? -2;
      const same = width === last;
      last = width;
      return same;
    }, { message: "the page has stopped moving" })
    .toBe(true);
}

/** Lines of text: the box's height over its line height (a line height the browser gives no number for is taken as 1.4 x the font size). */
const lines = (target: Locator) =>
  target.evaluate((el) => {
    const style = getComputedStyle(el);
    return el.getBoundingClientRect().height / (parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4);
  });

// ---------------------------------------------------------------------------------------------------------------------------------

test.beforeAll(async ({ browser }) => {
  await asAdmin(browser, async (request) => {
    keysBefore = new Set((await kindsOf(request)).map((k) => keyOf(k.name)));
    await removeAccounts(request); // an earlier run that stopped half way
  });
});

test.afterAll(async ({ browser }) => {
  // Every step is tried whatever the one before it did, and the failures are asserted once at the end: a kind that refuses to go must not
  // leave the account and the role behind.
  const failures: string[] = [];
  const attempt = async (what: string, step: () => Promise<void>) => {
    try {
      await step();
    } catch (e) {
      failures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await asAdmin(browser, async (request) => {
    // Assets first (newest first: deleting a parent takes its children, so a later 404 is fine): a kind that assets use cannot be deleted.
    await attempt("listing this run's assets", async () => {
      for (const asset of (await assetsOf(request)).filter((a) => mine(a.name)).sort((a, b) => b.id - a.id)) {
        await attempt(`the asset ${asset.name}`, async () => {
          const gone = await request.delete(`/api/assets/${asset.id}?confirm=true`);
          expect([200, 204, 404], `deleting ${asset.name}: ${gone.status()}`).toContain(gone.status());
        });
      }
    });
    // This run's kinds must go (strictly), and so must the starter kinds the pack cases added: only what the registry did not hold when the run began.
    // An asset made through the API never registers its kind text, so an earlier project may have assets of "Pump" or "UPS" with no such kind in the
    // registry; the pack then registers it and it has assets. That kind is left (and said), it is not this run's to empty.
    const starterKeys = new Set(STARTER.map(keyOf));
    await attempt("listing the kinds", async () => {
      for (const kind of await kindsOf(request)) {
        const own = mine(kind.name);
        const added = starterKeys.has(keyOf(kind.name)) && !keysBefore.has(keyOf(kind.name));
        if (!own && !added) continue;
        if (!own && kind.asset_count > 0) {
          console.log(`w7q: the starter kind "${kind.name}" has ${kind.asset_count} asset(s) from an earlier project and stays`);
          continue;
        }
        await attempt(`the kind ${kind.name}`, async () => {
          const gone = await request.delete(`/api/asset-kinds/${kind.id}`);
          expect([204, 404], `deleting the kind ${kind.name}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
        });
      }
    });
    await attempt("the account and the role", () => removeAccounts(request));
  });
  expect(failures, "the clean-up left something behind").toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7q: no jump to the top after a delete", () => {
  test("a window 640 px high, a list far longer: deleting one kind and then three leaves the page where it was, and the focus on a named element", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    // 20 of our own: with the kinds already on the stack the list is long, but a fresh stack has ten, and the spec must be able to fail either way.
    const names = await makeKinds(page.request, "scroll", 20);
    await page.setViewportSize({ width: 1024, height: 640 });
    await openKinds(page);
    await expect(kindRow(page, names[19])).toBeVisible();

    const start = await scrollNow(page);
    expect(start.max, `the page is only ${start.max} px longer than the window: a jump to the top could not be told from standing still`).toBeGreaterThanOrEqual(600);

    await test.step("one kind through the row menu: the scroll stays, the focus is on the menu button of the next row", async () => {
      const target = names[6];
      const row = kindRow(page, target);
      await centre(page, row);
      await (await rowAction(page, row, "Delete")).click();
      const confirm = page.getByRole("dialog", { name: `Delete the kind "${target}"?`, exact: true });
      await expect(confirm).toBeVisible();
      const before = await scrollNow(page);
      expect(before.y, `the page is scrolled to ${before.y}`).toBeGreaterThan(300);

      await confirm.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(confirm).toBeHidden();
      await expect(kindRow(page, target), "gone from the list").toHaveCount(0);
      await expect(toast(page, `Kind "${target}" deleted`)).toBeVisible();
      await expect.poll(() => focusName(page), { message: "the focus did not fall to the page body" }).not.toBe("");
      await settled(page);

      expect(await focusName(page), "the focus is the next row's menu button, not New kind").toBe(`Actions for ${names[7]}`);
      const after = await scrollNow(page);
      expect(Math.abs(after.y - Math.min(before.y, after.max)), `scrollY went from ${before.y} to ${after.y} (the most it could be: ${after.max})`).toBeLessThanOrEqual(1);
      expect(Math.abs(after.wrap - before.wrap), "the table frame did not scroll either").toBeLessThanOrEqual(1);
    });

    await test.step("three kinds through the checkboxes and the bar's Delete: the scroll stays, the focus is on the filter in use", async () => {
      const three = [names[9], names[10], names[11]];
      await centre(page, kindRow(page, names[10]));
      for (const name of three) await rowBox(page, name).click();
      await expect(selectedLine(page)).toHaveText("3 selected");
      await barButton(page, "Delete").click();
      const confirm = page.getByRole("dialog", { name: "Delete 3 kinds?", exact: true });
      await expect(confirm).toBeVisible();
      const before = await scrollNow(page);
      expect(before.y, `the page is scrolled to ${before.y}`).toBeGreaterThan(300);

      await confirm.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(confirm).toBeHidden();
      for (const name of three) await expect(kindRow(page, name), `${name} is gone from the list`).toHaveCount(0);
      await expect(toast(page, "Deleted 3 kinds")).toBeVisible();
      await expect(filterGroup(page).getByRole("button", { pressed: true }), "the focus is on the filter in use").toBeFocused();
      await settled(page);

      const after = await scrollNow(page);
      expect(Math.abs(after.y - Math.min(before.y, after.max)), `scrollY went from ${before.y} to ${after.y} (the most it could be: ${after.max})`).toBeLessThanOrEqual(1);
      expect(Math.abs(after.wrap - before.wrap), "the table frame did not scroll either").toBeLessThanOrEqual(1);
    });
  });

  test("New kind stays the opener of its own form: Cancel puts the focus back on it (a browser drops the focus of a button that was disabled meanwhile)", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await openKinds(page);
    const newKind = page.getByRole("button", { name: "New kind", exact: true });
    await newKind.click();
    const form = page.getByRole("dialog", { name: "New kind", exact: true });
    await expect(form).toBeVisible();
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(form).toBeHidden();
    await expect(newKind, "the focus went back to the button that opened the form").toBeFocused();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7q: the Starter tag and the filters", () => {
  test("Rack and a pack kind carry the tag beside their label, a W7q kind does not; the four filters count what they show; another filter clears the ticks", async ({ page }) => {
    test.setTimeout(150_000);
    await signIn(page);
    const [own] = await makeKinds(page.request, "tag", 1);

    // A pack kind: one the registry has, else UPS made for this case (afterAll removes it again: a pack kind that was not there before the run).
    const seeded = new Set(SEEDED.map(keyOf));
    let kinds = await kindsOf(page.request);
    let pack = kinds.find((k) => k.starter && !seeded.has(keyOf(k.name)))?.name;
    if (pack === undefined) pack = (await makeKind(page.request, "UPS")).name;
    const rack = (kinds.find((k) => k.starter && keyOf(k.name) === "rack") ?? kinds.find((k) => k.starter && seeded.has(keyOf(k.name))))?.name;
    expect(rack, "the registry holds one of the ten seeded kinds").toBeDefined();
    kinds = await kindsOf(page.request);

    await openKinds(page);
    await test.step("the tag is beside the label on a seeded kind and on a pack kind, and on no W7q kind", async () => {
      for (const name of [rack!, pack!]) {
        const row = kindRow(page, name);
        await expect(row.locator(".kind-starter"), `${name} carries the tag`).toHaveText("Starter");
        await expect(row.locator(".kind-label .kind-starter"), "and not inside its label").toHaveCount(0);
        await expect(row.locator(".kind-label"), "the label is the name alone").toHaveText(exactly(name));
      }
      await expect(kindRow(page, own).locator(".kind-starter"), "a kind of this spec is Yours").toHaveCount(0);
    });

    const want = {
      All: kinds.length,
      Starter: kinds.filter((k) => k.starter).length,
      Yours: kinds.filter((k) => !k.starter).length,
      Unused: kinds.filter((k) => k.asset_count === 0).length,
    };
    await test.step("the four filters carry their counts, and show that many rows", async () => {
      for (const label of ["All", "Starter", "Yours", "Unused"] as const) {
        const button = filterGroup(page).getByRole("button", { name: `${label} ${want[label]}`, exact: true });
        await expect(button, `${label} says ${want[label]}`).toBeVisible();
        await button.click();
        await expect(button).toHaveAttribute("aria-pressed", "true");
        await expect(tableRows(page), `${label} shows ${want[label]} rows`).toHaveCount(want[label]);
      }
      await filterButton(page, "Starter").click();
      await expect(kindRow(page, own), "Starter does not list a W7q kind").toHaveCount(0);
      await filterButton(page, "Yours").click();
      await expect(kindRow(page, own), "Yours does").toBeVisible();
      await expect(page.locator(".kinds-table .kind-starter"), "and no row of it has the tag").toHaveCount(0);
    });

    await test.step("another filter clears the ticks; the same filter pressed again does not", async () => {
      await filterButton(page, "All").click();
      await rowBox(page, own).click();
      await expect(selectedLine(page)).toHaveText("1 selected");
      await filterButton(page, "All").click();
      await expect(selectedLine(page), "the active filter pressed again changes nothing").toHaveText("1 selected");
      await filterButton(page, "Yours").click();
      await expect(selectedLine(page), "another filter forgets the ticks").toBeEmpty();
      await expect(page.locator(".kinds-table input[type=checkbox]:checked"), "no box is ticked").toHaveCount(0);
      await expect(idleButton(page), "the slot is idle again").toBeVisible();
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7q: selecting kinds", () => {
  test("Shift+click and Shift+Space add a range, Space toggles, the header box and Select all unused count right, Clear and Escape leave the focus on a named element", async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const names = await makeKinds(page.request, "pick", 14);
    await openKinds(page);
    const labels = await page.locator(".kinds-table tbody tr .kind-label").allTextContents();
    expect(labels.filter((label) => label.startsWith(`${PREFIX} pick `)), "this case's kinds are in the list in the order made").toEqual(names);
    const at = (...indexes: number[]) => indexes.map((i) => names[i]);
    const expectPicked = async (expected: string[], message: string) => {
      await expect.poll(() => pickedNames(page), { message }).toEqual(expected);
      await expect(selectedLine(page)).toHaveText(`${expected.length} selected`);
    };

    await test.step("a click ticks a row; Shift+click ADDS the rows from the last click to this one", async () => {
      await rowBox(page, names[1]).click();
      await expectPicked(at(1), "one tick");
      await rowBox(page, names[3]).click({ modifiers: ["Shift"] });
      await expectPicked(at(1, 2, 3), "Shift+click ranges from the first tick");
      await rowBox(page, names[5]).click();
      await expectPicked(at(1, 2, 3, 5), "a plain click adds one more and keeps the rest");
      await rowBox(page, names[7]).click({ modifiers: ["Shift"] });
      await expectPicked(at(1, 2, 3, 5, 6, 7), "the second range is added to the first, not put in its place");
    });

    await test.step("Shift+Space on a focused box adds the range too; Space toggles one box", async () => {
      await rowBox(page, names[10]).focus();
      await page.keyboard.press("Shift+Space");
      await expectPicked(at(1, 2, 3, 5, 6, 7, 8, 9, 10), "Shift+Space ranges from the last plain click");
      await rowBox(page, names[13]).focus();
      await page.keyboard.press("Space");
      await expectPicked(at(1, 2, 3, 5, 6, 7, 8, 9, 10, 13), "Space ticks");
      await page.keyboard.press("Space");
      await expectPicked(at(1, 2, 3, 5, 6, 7, 8, 9, 10), "Space again unticks");
    });

    await test.step("Clear takes every tick away and puts the focus on the pressed filter button, not on the body and not on the pack button", async () => {
      await barButton(page, "Clear").click();
      await expect(selectedLine(page)).toBeEmpty();
      expect(await pickedNames(page)).toEqual([]);
      await expect(filterButton(page, "All"), "the focus follows the bar to the pressed filter, which writes nothing").toBeFocused();
      await expect(idleButton(page), "the pack button, which would add kinds back on the next Enter, has no focus").not.toBeFocused();
    });

    await test.step("the header box: empty, some (indeterminate), all shown, then none again", async () => {
      const indeterminate = () => headerBox(page).evaluate((el) => (el as HTMLInputElement).indeterminate);
      await expect(headerBox(page)).not.toBeChecked();
      expect(await indeterminate(), "nothing ticked: not indeterminate").toBe(false);
      await rowBox(page, names[0]).click();
      await expect(selectedLine(page)).toHaveText("1 selected");
      await expect(headerBox(page)).not.toBeChecked();
      expect(await indeterminate(), "one ticked: indeterminate").toBe(true);

      const shown = await tableRows(page).count();
      await headerBox(page).click();
      await expect(selectedLine(page)).toHaveText(`${shown} selected`);
      await expect(page.locator(".kinds-table tbody tr.is-picked")).toHaveCount(shown);
      await expect(headerBox(page)).toBeChecked();
      expect(await indeterminate(), "all ticked: checked, not indeterminate").toBe(false);

      await headerBox(page).click();
      await expect(selectedLine(page)).toBeEmpty();
      await expect(page.locator(".kinds-table tbody tr.is-picked")).toHaveCount(0);
      await expect(headerBox(page)).not.toBeChecked();
    });

    await test.step("Select all unused ticks as many as the Unused filter shows (Delete is not pressed: it would take kinds this spec did not make)", async () => {
      const label = await filterButton(page, "Unused").textContent();
      const unused = Number(/(\d+)$/.exec((label ?? "").trim())?.[1]);
      expect(unused, `the Unused filter says "${label}"`).toBeGreaterThanOrEqual(names.length);
      await rowBox(page, names[2]).click(); // an unused kind of ours: the bar appears
      await barButton(page, "Select all unused").click();
      await expect(selectedLine(page)).toHaveText(`${unused} selected`);
      await expect(page.locator(".kinds-table tbody tr.is-picked")).toHaveCount(unused);
      await barButton(page, "Clear").click();
      await expect(selectedLine(page)).toBeEmpty();
      await expect(page.locator(".kinds-table tbody tr.is-picked")).toHaveCount(0);
    });

    await test.step("Escape clears the ticks, and with the focus on the bar's Delete it goes to the pressed filter button", async () => {
      await rowBox(page, names[4]).click();
      await expect(selectedLine(page)).toHaveText("1 selected");
      await barButton(page, "Delete").focus();
      await page.keyboard.press("Escape");
      await expect(selectedLine(page)).toBeEmpty();
      expect(await pickedNames(page)).toEqual([]);
      await expect.poll(() => focusName(page), { message: "the focus is on the pressed filter button (its name starts with All), not the body and not the pack button" }).toMatch(/^All /);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7q: deleting several kinds", () => {
  test("three unused kinds of ours go, and only those, with a toast that counts them", async ({ page }) => {
    test.setTimeout(150_000);
    await signIn(page);
    const names = await makeKinds(page.request, "bulk", 3);
    const before = await kindsOf(page.request);
    await openKinds(page);

    for (const name of names) await rowBox(page, name).click();
    await expect(selectedLine(page)).toHaveText("3 selected");
    await barButton(page, "Delete").click();
    const confirm = page.getByRole("dialog", { name: "Delete 3 kinds?", exact: true });
    await expect(confirm).toBeVisible();
    for (const name of names) await expect(confirm.locator(".confirm-body"), `the dialog lists ${name}`).toContainText(name);
    await expect(confirm.getByLabel("Move the assets to"), "nothing is in use, so there is no move form").toHaveCount(0);
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(toast(page, "Deleted 3 kinds")).toBeVisible();
    for (const name of names) await expect(kindRow(page, name), `${name} is gone from the list`).toHaveCount(0);

    const after = await kindsOf(page.request);
    expect(after.map((k) => k.id).sort(), "the registry lost exactly the three").toEqual(before.filter((k) => !names.includes(k.name)).map((k) => k.id).sort());
  });

  test("one kind in use and two unused: the dialog asks where the assets go (the selection is not offered), the asset follows, and the log has a row per kind", async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const [used, unusedA, unusedB] = await makeKinds(page.request, "mix", 3);
    const [target] = await makeKinds(page.request, "target", 1);
    const assetName = `${PREFIX} asset`;
    await makeAsset(page.request, assetName, used);
    await openKinds(page);
    await expect(kindCount(page, used)).toHaveText("1 asset");

    for (const name of [used, unusedA, unusedB]) await rowBox(page, name).click();
    await expect(selectedLine(page)).toHaveText("3 selected");
    await barButton(page, "Delete").click();
    const confirm = page.getByRole("dialog", { name: "Delete 3 kinds?", exact: true });
    await expect(confirm).toBeVisible();
    const deleteButton = confirm.getByRole("button", { name: "Delete", exact: true });
    const choice = confirm.getByLabel("Move the assets to"); // never `exact`: the label wraps the select

    await test.step("the count, the choice of the kinds that stay, and Delete off until one is chosen", async () => {
      await expect(confirm.locator(".confirm-body")).toContainText("1 of these kinds is used by 1 asset. Move that asset to another kind, then delete the 3.");
      await expect(choice).toHaveValue("");
      const options = await choice.locator("option").allTextContents();
      expect(options, "a kind that stays is a choice").toContain(target);
      for (const name of [used, unusedA, unusedB]) expect(options, `${name} is being deleted, so it is not a choice`).not.toContain(name);
      await expect(deleteButton).toBeDisabled();
    });

    await test.step("choosing a kind turns Delete on; it deletes the three, moves the asset and says so", async () => {
      await choice.selectOption({ label: target });
      await expect(deleteButton).toBeEnabled();
      await deleteButton.click();
      await expect(confirm).toBeHidden();
      await expect(toast(page, `Deleted 3 kinds, 1 asset moved to ${target}`)).toBeVisible();
      for (const name of [used, unusedA, unusedB]) await expect(kindRow(page, name), `${name} is gone from the list`).toHaveCount(0);
      await expect(kindCount(page, target), "the target holds the asset now").toHaveText("1 asset");
      expect((await assetsOf(page.request)).find((a) => a.name === assetName)?.kind, "the asset follows the kind").toBe(target);
    });

    await test.step("the audit log has one kind.deleted row per kind, and the one that held the asset says where it went", async () => {
      const log = await (async () => {
        const response = await page.request.get(`/api/audit?action=kind.deleted&q=${encodeURIComponent(PREFIX)}&limit=200`);
        expect(response.ok(), `GET /api/audit: ${response.status()}`).toBe(true);
        return ((await response.json()) as { items: ApiAuditEntry[] }).items;
      })();
      for (const name of [used, unusedA, unusedB]) {
        expect(log.filter((entry) => entry.detail.name === name), `one kind.deleted row for ${name}`).toHaveLength(1);
      }
      const entry = log.find((item) => item.detail.name === used)!;
      expect(entry.detail.assets, "the number moved").toBe(1);
      expect(entry.detail.moved_to, "and to where").toBe(target);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7q: the table does not move when the first row is ticked", () => {
  test("at 1440, 1024 and 800 px, the sidebar expanded and minimised, the table's top stays; at 1024 with the sidebar expanded the title is one line", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    await openKinds(page);
    const tableTop = () => page.locator(".kinds-table").evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    const cases: [number, number, ("expanded" | "minimized")[]][] = [[1440, 900, ["expanded", "minimized"]], [1024, 800, ["minimized", "expanded"]], [800, 600, ["minimized", "expanded"]]];
    for (const [width, height, bars] of cases) {
      for (const bar of bars) {
        await test.step(`${width} px, sidebar ${bar}`, async () => {
          await page.setViewportSize({ width, height });
          await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
          await sidebar(page, bar);
          await settled(page);

          if (width === 1024 && bar === "expanded") {
            await expect.poll(() => lines(heading1(page, "Asset kinds")), { message: "the title is one line" }).toBeLessThan(1.5);
            await expect.poll(() => lines(page.locator(".page-head .sub")), { message: "the sub line is one line" }).toBeLessThan(1.5);
          }
          const before = await tableTop();
          await tableRows(page).first().getByRole("checkbox").click();
          await expect(selectedLine(page)).toHaveText("1 selected");
          await settled(page);
          const after = await tableTop();
          expect(Math.abs(after - before), `the table's top moved from ${before} to ${after} with the first tick at ${width} px, sidebar ${bar}`).toBeLessThanOrEqual(0.5);
          await barButton(page, "Clear").click(); // the next width starts from a first tick again
          await expect(selectedLine(page)).toBeEmpty();
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7q: the common kinds and Add all 39", () => {
  test("the header's button adds exactly the common kinds that are missing, Add all 39 the rest; a second press of each says so and writes no audit row; a bad set is 422", async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const registryBefore = await registryOf(page.request);
    const before = await kindsOf(page.request);
    const have = new Set(before.map((k) => keyOf(k.name)));
    const missingCommon = COMMON.filter((name) => !have.has(keyOf(name)));

    await test.step("?set=bogus is 422 and writes nothing", async () => {
      const bad = await page.request.post("/api/asset-kinds/starter-pack?set=bogus");
      expect(bad.status(), `a set that does not exist: ${await bad.text()}`).toBe(422);
      expect(await registryOf(page.request), "and nothing was added").toBe(registryBefore);
    });

    await openKinds(page);
    const common = page.getByRole("button", { name: "Add common data-centre kinds", exact: true });
    await expect(common).toBeVisible();
    await expect(idleButton(page)).toBeVisible();
    // `query` is what the page sends: nothing for the common kinds (the server's default), `?set=all` for the whole catalogue.
    const pressed = async (button: Locator, query: string): Promise<StarterAnswer> => {
      await expect(button).not.toHaveAttribute("aria-disabled", "true"); // the previous press has finished and the list is back
      const answered = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/asset-kinds/starter-pack" && r.request().method() === "POST");
      await button.click();
      const response = await answered;
      expect(response.status(), "the pack answers 200").toBe(200);
      expect(new URL(response.url()).search, "the query the page sent").toBe(query);
      return (await response.json()) as StarterAnswer;
    };

    await test.step("the header's first press adds exactly the common kinds the registry lacked, with one audit row", async () => {
      const auditBefore = await auditCount(page.request, "kind.starter_pack_added");
      const first = await pressed(common, "");
      expect([...first.added].sort(), "the kinds the server added").toEqual([...missingCommon].sort());
      expect(first.already_there, "and the others of the 16").toBe(COMMON.length - missingCommon.length);
      await expect(toast(page, missingCommon.length === 0 ? "All the common data-centre kinds are already there" : `Added ${missingCommon.length} ${missingCommon.length === 1 ? "kind" : "kinds"}`).last()).toBeVisible();
      const keys = new Set((await kindsOf(page.request)).map((k) => keyOf(k.name)));
      for (const name of COMMON) expect(keys.has(keyOf(name)), `${name} is in the registry`).toBe(true);
      if (missingCommon.length > 0) await expect(kindRow(page, missingCommon[0]), "the page lists them without a reload").toBeVisible();
      expect(await auditCount(page.request, "kind.starter_pack_added"), "one audit row when something was added, none when not").toBe(auditBefore + (missingCommon.length > 0 ? 1 : 0));
    });

    await test.step("the header's second press says the common kinds are all there and writes no audit row", async () => {
      const [count, auditNow] = [(await kindsOf(page.request)).length, await auditCount(page.request, "kind.starter_pack_added")];
      const second = await pressed(common, "");
      expect(second.added, "nothing is added").toEqual([]);
      expect(second.already_there, "every common kind is there").toBe(COMMON.length);
      await expect(toast(page, "All the common data-centre kinds are already there").last()).toBeVisible();
      expect((await kindsOf(page.request)).length, "the registry did not grow").toBe(count);
      expect(await auditCount(page.request, "kind.starter_pack_added"), "a press that changes nothing leaves no trace").toBe(auditNow);
    });

    await test.step("Add all 39 adds the rest of the catalogue, and its second press says they are all there", async () => {
      const haveNow = new Set((await kindsOf(page.request)).map((k) => keyOf(k.name)));
      const rest = STARTER.filter((name) => !haveNow.has(keyOf(name)));
      const [count, auditNow] = [(await kindsOf(page.request)).length, await auditCount(page.request, "kind.starter_pack_added")];
      const third = await pressed(idleButton(page), "?set=all");
      expect([...third.added].sort(), "the rest of the 39").toEqual([...rest].sort());
      expect(third.already_there, "and the others").toBe(STARTER.length - rest.length);
      await expect(toast(page, rest.length === 0 ? "All the data-centre kinds are already there" : `Added ${rest.length} ${rest.length === 1 ? "kind" : "kinds"}`).last()).toBeVisible();
      expect((await kindsOf(page.request)).length, "the registry grew by what was added").toBe(count + rest.length);
      expect(await auditCount(page.request, "kind.starter_pack_added"), "one audit row when something was added, none when not").toBe(auditNow + (rest.length > 0 ? 1 : 0));

      const auditAfter = await auditCount(page.request, "kind.starter_pack_added");
      const fourth = await pressed(idleButton(page), "?set=all");
      expect(fourth.added, "nothing is added").toEqual([]);
      expect(fourth.already_there, "every kind of the catalogue is there").toBe(STARTER.length);
      await expect(toast(page, "All the data-centre kinds are already there").last()).toBeVisible();
      expect(await auditCount(page.request, "kind.starter_pack_added"), "a press that changes nothing leaves no trace").toBe(auditAfter);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7q: a role without Manage asset kinds", () => {
  test("it sees the tag and the filters and nothing to change with: no box, no pack button, no bar; the API answers 403 for the packs and for a delete", async ({ browser, page }) => {
    test.setTimeout(150_000);
    await asAdmin(browser, async (request) => {
      await removeAccounts(request);
      const role = await request.post("/api/roles", { data: { name: READER_ROLE, description: "made by w7q.spec.ts", permissions: ["assets.view"] } });
      expect(role.status(), `creating the role: ${await role.text()}`).toBe(201);
      const user = await request.post("/api/users", { data: { username: READER.username, password: READER.password, role: READER.role } });
      expect(user.status(), `creating the account: ${await user.text()}`).toBe(201);
    });
    await signIn(page);
    const [seen] = await makeKinds(page.request, "reader", 1);
    const seenId = (await kindsOf(page.request)).find((k) => k.name === seen)!.id;
    const registry = await registryOf(page.request);

    await test.step("the API: reading is allowed and carries the flag; the packs and a delete are 403, and nothing changes", async () => {
      await as(browser, READER, async (api) => {
        const list = await api.get("/api/asset-kinds");
        expect(list.status(), "reading the list needs only See the Assets Tree").toBe(200);
        expect(((await list.json()) as ApiKind[]).some((k) => k.starter === true), "the answer carries `starter`").toBe(true);
        const attempts = [
          ["POST /api/asset-kinds/starter-pack", await api.post("/api/asset-kinds/starter-pack")],
          ["POST /api/asset-kinds/starter-pack?set=common", await api.post("/api/asset-kinds/starter-pack?set=common")],
          ["POST /api/asset-kinds/starter-pack?set=all", await api.post("/api/asset-kinds/starter-pack?set=all")],
          ["DELETE /api/asset-kinds/{id}", await api.delete(`/api/asset-kinds/${seenId}`)],
        ] as const;
        for (const [what, response] of attempts) expect(response.status(), `${what} as a role without Manage asset kinds`).toBe(403);
      });
      expect(await asAdmin(browser, registryOf), "nothing was added or deleted").toBe(registry);
    });

    await test.step("the page: the tag and the filters, and none of the means to change a kind", async () => {
      await signInAs(page, READER);
      await openKinds(page);
      await expect(userBlock(page)).toContainText(READER.username);
      await expect(kindRow(page, seen), "the list is readable").toBeVisible();
      await expect(page.getByText('Managing asset kinds needs the "Manage asset kinds" permission.', { exact: true })).toBeVisible();
      await expect(page.locator(".kind-starter").first(), "the tag is shown to everybody").toHaveText("Starter");
      await expect(filterGroup(page).getByRole("button"), "the four filters").toHaveCount(4);
      await filterButton(page, "Yours").click();
      await expect(kindRow(page, seen), "a filter works for a reader").toBeVisible();
      await expect(page.locator(".kinds-table .kind-starter"), "Yours has no tag").toHaveCount(0);
      await filterButton(page, "Starter").click();
      await expect(kindRow(page, seen)).toHaveCount(0);

      await expect(page.locator(".kinds-page").getByRole("checkbox"), "no checkbox, not even the header's").toHaveCount(0);
      await expect(page.getByRole("button", { name: "Add common data-centre kinds", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Add all 39 data-centre kinds", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "New kind", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Actions for / }), "no row menu").toHaveCount(0);
      await expect(slot(page), "no slot, so no bar and no count").toHaveCount(0);
    });
  });
});
