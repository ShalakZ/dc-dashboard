import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { rowAction, treeLink, userBlock } from "./shell";

// W7o (the kinds pack: a labelled Delete in the asset header, 48 icons in six groups with a search box, "Manage asset kinds" as its own
// permission, delete-and-move for a kind in use, and the data-centre starter kinds) on the state the earlier projects leave behind: admin
// `admin` / `correct-horse`. Every name this spec makes carries the digits-only run suffix (assets and kinds start with `W7o `, the account and
// the role with `w7o-`), and afterAll removes what this run made, in this order: the assets, then the kinds (this run's own and the starter
// kinds the pack added that were NOT in the registry when the run began, unless assets of an earlier project use one: that kind stays, and is
// logged), then the account, then the role, then the admin's look. Every step is tried and the failures are asserted once, at the end.
// beforeAll takes the registry's keys first (the starter-pack case compares against them, afterAll removes only what is new) and removes an
// account and a role that an earlier run left behind. The admin signs in through the API: the sign-in page is not what is tested here.
//
// The run suffix is digits only on purpose, as in w7m: a kind's default icon is a guess from its words, and a number cannot be a keyword.
//
// The cases are independent (one failure does not hide the others; workers is 1, so they still run in file order), in five describes:
//   header buttons       Add asset, Edit and Delete are one height on an asset's page (1440 and 1024 px, light and dark).
//   the icon picker      six groups, the search ("transfer", and an arrow-key walk across a group boundary under "security"), a new icon chosen
//                        and drawn in the tree row and the header, Escape in layers, no sideways scroll and no shift while typing.
//   delete and move      a kind of three assets: the move form, a fourth asset arriving (409 and the dialog's new count), the move, the audit entry.
//                        THIS DESCRIBE IS THE DEFERRABLE PART (plan decision 1): drop it with T1b-2 and T4b if they are dropped.
//   the starter pack     adds what is missing, skips a kind in another spelling without touching its icon, a second press adds nothing.
//   the permission       a role with Change assets and without Manage asset kinds: read-only page, 403 on every write, typed kinds stay text;
//                        an admin's typed kind is registered; the Roles editor offers the two permissions that Manage asset kinds needs.
//
// Locators. A picker's cell is found inside the radiogroup by its title (`exact: true`: "Rack" is also the start of "Row of racks"), the
// groups by their names (a `role="group"` named by its heading; a group the search emptied is `hidden`, so it is not in the role tree).
// The search box is the searchbox "Search icons". The move dialog's select is a label that WRAPS it, so its lookup is `getByLabel("Move the
// assets to")` without `exact` (the label's text holds the option texts). A kind's row is found by its label as a whole.

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse" };
const RUN = Date.now().toString();

const EDITOR_ROLE = "w7o-editor-role"; // Change assets, not Manage asset kinds
const EDITOR = { username: "w7o-editor", password: "w7o-editor-pass", role: EDITOR_ROLE };
const DEFAULT_LOOK = { mode: "light", theme: "navy-gold" }; // what w7d leaves, used only when the account's own look cannot be read

/** The data-centre starter kinds (core/asset_kinds.py STARTER_PACK, in its order). The count is 39 there too: a change of the pack changes this list. */
const STARTER = [
  "UPS", "Battery", "PDU", "RPP", "ATS", "STS", "Switchgear", "Busway", "Ring main unit", "Transformer", "Generator", "Fuel tank",
  "Chiller", "CRAC", "Air handling unit", "Cooling distribution unit", "Cooling tower", "Dry cooler", "Heat exchanger", "Pump", "Fan", "Valve",
  "Variable frequency drive", "Server", "Network switch", "Router", "Firewall", "Patch panel", "Cable tray", "Data hall",
  "Controller", "Sensor", "Smoke detector", "Humidity sensor", "Fire suppression", "Leak detector", "Camera", "Door", "Lighting",
];
const GROUPS = ["Structure", "Power", "Cooling", "IT and network", "Monitoring and safety", "Other"];

interface ApiAsset { id: number; name: string; kind: string; icon: string | null; kind_icon: string | null }
interface ApiKind { id: number; name: string; icon: string; asset_count: number }
interface ApiRole { id: number; name: string; builtin: boolean }
interface ApiUser { id: number; username: string }
interface ApiAuditEntry { id: number; action: string; detail: Record<string, unknown> }
interface StarterAnswer { added: string[]; already_there: number }

/** The comparison key of a kind text, as the server and the front end make it (these names are plain ASCII). */
const keyOf = (name: string) => name.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
/** The names this run made (the prefix alone would also catch an earlier run's leftovers, which are not ours to remove). */
const mine = (name: string) => name.startsWith("W7o ") && name.includes(` ${RUN}`);
const exactly = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

let keysBefore = new Set<string>(); // the registry when the run began
let lookBefore: { mode: string; theme: string } | null = null;

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

async function makeKind(request: APIRequestContext, name: string, icon: string): Promise<ApiKind> {
  const made = await request.post("/api/asset-kinds", { data: { name, icon } });
  expect(made.status(), `creating the kind ${name}: ${await made.text()}`).toBe(201);
  return (await made.json()) as ApiKind;
}

async function makeAsset(request: APIRequestContext, name: string, kind: string, icon: string | null = null): Promise<ApiAsset> {
  const body: Record<string, unknown> = { name, parent_id: null, kind, sort_order: 0 };
  if (icon !== null) body.icon = icon;
  const made = await request.post("/api/assets", { data: body });
  expect(made.status(), `creating the asset ${name}: ${await made.text()}`).toBe(201);
  return (await made.json()) as ApiAsset;
}

/** Every account whose name starts with w7o-, then every custom role that does (a role an account holds cannot be deleted). */
async function removeAccounts(request: APIRequestContext): Promise<void> {
  for (const user of (await json<ApiUser[]>(request, "/api/users")).filter((u) => u.username.startsWith("w7o-"))) {
    const gone = await request.delete(`/api/users/${user.id}`);
    expect([204, 404], `deleting ${user.username}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
  for (const role of (await json<ApiRole[]>(request, "/api/roles")).filter((r) => !r.builtin && r.name.toLowerCase().startsWith("w7o-"))) {
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
const tree = (page: Page) => page.getByRole("region", { name: "Asset tree" });
const toast = (page: Page, text: string) => page.locator(".toast-stack .toast").filter({ hasText: text });
/** Two animation frames: whatever the page does about a viewport change or a keystroke has happened by then. */
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** A kind's row on the Asset kinds page, by its label as a whole ("W7o Source N" must not find "W7o Source N2"). */
const kindRow = (page: Page, name: string) => page.getByRole("row").filter({ has: page.locator(".kind-label", { hasText: exactly(name) }) });
const kindCount = (page: Page, name: string) => kindRow(page, name).getByRole("cell").nth(1);

/** The <svg> of the asset's tree row, found by the row's own link (the same name can also be a crumb on the asset page). */
const treeIcon = (page: Page, name: string) => tree(page).locator(".node").filter({ has: page.getByRole("link", { name, exact: true }) }).locator(".node-icon svg");
/** The tile in the asset page's header (a dialog's preview tile is not in the header). */
const headerIcon = (page: Page) => page.locator(".page-head .page-tile svg");

/** The Add asset dialog and the parts of its Icon field, with the search box W7o added. */
function addDialog(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Add asset", exact: true });
  const field = dialog.getByRole("group", { name: "Icon", exact: true });
  const grid = field.getByRole("radiogroup", { name: "Icon choices", exact: true });
  return {
    dialog,
    grid,
    change: field.getByRole("button", { name: "Change icon", exact: true }),
    caption: field.locator(".icon-caption"),
    search: dialog.getByRole("searchbox", { name: "Search icons", exact: true }),
    radio: (label: string) => grid.getByRole("radio", { name: label, exact: true }),
    /** The cell to click, and to read the reference drawing from (a hidden cell is still found, and is then `toBeHidden`). */
    cell: (label: string) => grid.getByTitle(label, { exact: true }),
    /** Automatic's title says what it does, so it is matched by that sentence. */
    automatic: grid.getByTitle(/^Automatic: follows the kind/),
    name: dialog.getByLabel("Name", { exact: true }),
    kind: dialog.getByLabel(/^Kind/), // a label that wraps a <select> has the option texts in its text
    newKind: dialog.getByLabel("New kind", { exact: true }),
    save: dialog.getByRole("button", { name: "Save", exact: true }),
  };
}

async function openAddAsset(page: Page) {
  await page.goto("/assets");
  await page.getByRole("button", { name: "Add asset", exact: true }).click();
  const form = addDialog(page);
  await expect(form.dialog).toBeVisible();
  return form;
}

// ---------------------------------------------------------------------------------------------------------------------------------

test.beforeAll(async ({ browser }) => {
  await asAdmin(browser, async (request) => {
    keysBefore = new Set((await kindsOf(request)).map((k) => keyOf(k.name)));
    const me = await json<{ preferences: { mode: string; theme: string } | null }>(request, "/api/me");
    // Only the two fields the PUT takes, so a preference added later cannot turn the restore into a 422.
    lookBefore = me.preferences && typeof me.preferences.mode === "string" && typeof me.preferences.theme === "string"
      ? { mode: me.preferences.mode, theme: me.preferences.theme }
      : null;
    await removeAccounts(request); // an earlier run that stopped half way
  });
});

test.afterAll(async ({ browser }) => {
  // Every step is tried whatever the one before it did, and the failures are asserted once at the end: a kind that refuses to go must not
  // leave the account, the role and the admin's look behind.
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
    // This run's kinds must go (strictly), and so must the starter kinds the pack added: only what the registry did not hold when the run
    // began. An asset made through the API never registers its kind text, so an earlier project may have assets of "Pump" or "UPS" with no
    // such kind in the registry; the pack then registers it and it has assets. That kind is left (and said), it is not this run's to empty.
    const starterKeys = new Set(STARTER.map(keyOf));
    await attempt("listing the kinds", async () => {
      for (const kind of await kindsOf(request)) {
        const own = mine(kind.name);
        const added = starterKeys.has(keyOf(kind.name)) && !keysBefore.has(keyOf(kind.name));
        if (!own && !added) continue;
        if (!own && kind.asset_count > 0) {
          console.log(`w7o: the starter kind "${kind.name}" has ${kind.asset_count} asset(s) from an earlier project and stays`);
          continue;
        }
        await attempt(`the kind ${kind.name}`, async () => {
          const gone = await request.delete(`/api/asset-kinds/${kind.id}`);
          expect([204, 404], `deleting the kind ${kind.name}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
        });
      }
    });
    await attempt("the account and the role", () => removeAccounts(request));
    await attempt("the admin's look", async () => {
      const put = await request.put("/api/me/preferences", { data: lookBefore ?? DEFAULT_LOOK });
      expect(put.ok(), `putting the admin's look back: ${put.status()}`).toBe(true);
    });
  });
  expect(failures, "the clean-up left something behind").toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7o: the asset header's buttons", () => {
  for (const mode of ["dark", "light"] as const) {
    test(`Add asset, Edit and Delete are one height at 1440 and 1024 px, and Delete is an outlined button with its word (${mode})`, async ({ page }) => {
      test.setTimeout(120_000);
      await signIn(page);
      const name = `W7o header ${mode} ${RUN}`;
      const asset = await makeAsset(page.request, name, "Generic");
      const stored = await page.request.put("/api/me/preferences", { data: { mode, theme: "navy-gold" } });
      expect(stored.ok(), `storing the ${mode} look: ${stored.status()}`).toBe(true);
      await page.goto(`/assets/${asset.id}`);
      await expect(heading1(page, name)).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-mode", mode);

      // Looked up by role and name, never by position: the live chip sits in the same group.
      const head = page.locator(".page-head");
      const edit = head.getByRole("button", { name: "Edit", exact: true });
      const add = head.getByRole("button", { name: "Add asset", exact: true });
      const del = head.getByRole("button", { name: `Delete ${name}`, exact: true });

      for (const [width, height] of [[1440, 900], [1024, 800]] as const) {
        await test.step(`${width} px`, async () => {
          await page.setViewportSize({ width, height });
          await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
          await settled(page);
          await expect(del, "Delete is a button with its word, not a bare bin").toHaveText("Delete");
          const [e, a, d] = [await edit.boundingBox(), await add.boundingBox(), await del.boundingBox()];
          expect(e && a && d, "the three buttons are laid out").toBeTruthy();
          const heights = [e!.height, a!.height, d!.height];
          expect(Math.max(...heights) - Math.min(...heights), `the heights differ: Edit ${e!.height}, Add asset ${a!.height}, Delete ${d!.height}`).toBeLessThanOrEqual(0.5);
          expect(d!.width, "Delete is wider than tall: the word is on it").toBeGreaterThan(d!.height * 2);
          const border = (button: Locator) => button.evaluate((el) => { const s = getComputedStyle(el); return `${s.borderTopWidth} ${s.borderTopStyle}`; });
          expect(await border(del), "Delete has the same outline as Edit").toBe(await border(edit));
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7o: the icon picker", () => {
  test("six labelled groups hold the 48 icons, and the search for 'transfer' leaves the two transfer switches", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const form = await openAddAsset(page);
    await expect(form.search, "the search box exists only while the grid is open").toHaveCount(0);
    await form.change.click();
    await expect(form.grid).toBeVisible();
    await expect(form.search).toBeVisible();

    await test.step("six groups in order, 49 choices with Automatic", async () => {
      await expect(form.grid.locator(".icon-group-label")).toHaveText(GROUPS);
      for (const group of GROUPS) await expect(form.grid.getByRole("group", { name: group, exact: true })).toBeVisible();
      await expect(form.grid.getByRole("radio")).toHaveCount(49);
    });

    await test.step("typing 'transfer' leaves Automatic and the two transfer switches; their group is the only one left", async () => {
      await form.search.fill("transfer");
      await expect(form.grid.getByRole("radio")).toHaveCount(3);
      await expect(form.automatic).toBeVisible();
      await expect(form.cell("Automatic transfer switch")).toBeVisible();
      await expect(form.cell("Static transfer switch")).toBeVisible();
      await expect(form.cell("Rack"), "a cell that does not match is gone").toBeHidden();
      await expect(form.grid.getByRole("group"), "a group with no match goes with its heading").toHaveCount(1);
      await expect(form.grid.getByRole("group", { name: "Power", exact: true })).toBeVisible();
      await expect(form.dialog.getByText("No icons match", { exact: true })).toHaveCount(0);
    });

    await test.step("a word that nothing matches says so once, and Automatic is still there", async () => {
      await form.search.fill("zzzzz");
      await expect(form.dialog.getByText("No icons match", { exact: true })).toBeVisible();
      await expect(form.grid.getByRole("radio")).toHaveCount(1);
      await expect(form.automatic).toBeVisible();
      await form.search.fill("");
      await expect(form.grid.getByRole("radio")).toHaveCount(49);
    });
  });

  test("a transfer switch picked from the search is saved and drawn in the tree row and the asset page's header", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const name = `W7o ats ${RUN}`;
    const form = await openAddAsset(page);
    await form.name.fill(name);
    await form.change.click();
    await form.search.fill("transfer");
    await expect(form.grid.getByRole("radio")).toHaveCount(3);
    const reference = await form.cell("Automatic transfer switch").locator("svg").innerHTML();
    const other = await form.cell("Static transfer switch").locator("svg").innerHTML();
    expect(reference, "the two transfer switches are two drawings").not.toBe(other);
    await form.cell("Automatic transfer switch").click();
    await expect(form.radio("Automatic transfer switch")).toBeChecked();
    await expect(form.caption).toHaveText(/^Automatic transfer switch/);
    await expect(form.dialog, "choosing does not save").toBeVisible();
    await form.save.click();
    await expect(form.dialog).toBeHidden();
    await expect(treeLink(page, name)).toBeVisible();

    const asset = (await assetsOf(page.request)).find((a) => a.name === name);
    expect(asset, `the asset ${name} was created`).toBeTruthy();
    expect(asset!.icon, "the new icon id is stored").toBe("ats");
    await expect.poll(() => treeIcon(page, name).innerHTML(), { message: "the tree row" }).toBe(reference);
    await page.goto(`/assets/${asset!.id}`);
    await expect(heading1(page, name)).toBeVisible();
    await expect.poll(() => headerIcon(page).innerHTML(), { message: "the header tile" }).toBe(reference);
    await expect.poll(() => treeIcon(page, name).innerHTML(), { message: "the tree row after a load" }).toBe(reference);
  });

  test("the arrow keys walk the cells a search left, across a group boundary, and Escape goes search text, then grid, then dialog", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const form = await openAddAsset(page);
    await form.change.click();
    await expect(form.radio("Automatic"), "opening puts the focus on the checked cell").toBeFocused();
    await form.search.fill("security"); // Firewall (IT and network) and Camera (Monitoring and safety), with whole groups of hidden cells between
    await expect(form.grid.getByRole("radio")).toHaveCount(3);

    // What is left, in the order of the page, and the group each cell sits in: read from the page, so the walk below compares with what a
    // person sees. A walk across a boundary needs two groups.
    const left = await form.grid.locator("label.icon-cell:not([hidden])").evaluateAll((cells) =>
      cells.map((cell) => ({ name: cell.querySelector(".sr-only")!.textContent!, group: cell.closest(".icon-section")?.querySelector(".icon-group-label")?.textContent ?? "" })),
    );
    expect(left.map((c) => c.name), "Automatic first, then what the search found").toEqual(["Automatic", "Firewall", "Camera"]);
    expect(new Set(left.slice(1).map((c) => c.group)).size, "the two cells are in two groups").toBe(2);

    await test.step("Tab from the search lands on the checked cell, Automatic", async () => {
      await page.keyboard.press("Tab");
      await expect(form.radio("Automatic")).toBeFocused();
    });
    await test.step("ArrowRight twice crosses the boundary, skipping every hidden cell", async () => {
      await page.keyboard.press("ArrowRight");
      await expect(form.radio("Firewall")).toBeChecked();
      await expect(form.radio("Firewall")).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(form.radio("Camera")).toBeChecked();
      await expect(form.radio("Camera")).toBeFocused();
      await expect(form.caption).toHaveText(/^Camera/);
    });
    await test.step("ArrowLeft comes back across it, and the picked cell is never hidden by the search", async () => {
      await page.keyboard.press("ArrowLeft");
      await expect(form.radio("Firewall")).toBeChecked();
      await expect(form.radio("Firewall")).toBeFocused();
      await form.search.fill("camera");
      await expect(form.cell("Firewall"), "the checked cell stays though 'camera' does not match it").toBeVisible();
      await expect(form.cell("Camera")).toBeVisible();
    });
    await test.step("Escape clears the text first, closes the grid second, closes the dialog third", async () => {
      await form.search.focus();
      await page.keyboard.press("Escape");
      await expect(form.search, "the first Escape clears the search").toHaveValue("");
      await expect(form.grid).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(form.grid, "the second closes the grid").toBeHidden();
      await expect(form.dialog).toBeVisible();
      await expect(form.change, "and the focus is back on Change icon").toBeFocused();
      await page.keyboard.press("Escape");
      await expect(form.dialog, "the third closes the dialog").toBeHidden();
    });
  });

  test("with the grid open there is no sideways scroll, Save stays in the window, and typing in the search moves nothing", async ({ page }) => {
    test.setTimeout(150_000);
    await signIn(page);
    const form = await openAddAsset(page);
    await form.change.click();
    await expect(form.grid).toBeVisible();

    const geometry = async () => {
      const [save, dialog, grid] = [await form.save.boundingBox(), await form.dialog.boundingBox(), await form.grid.boundingBox()];
      expect(save && dialog && grid, "Save, the dialog and the grid are laid out").toBeTruthy();
      return { save: save!, dialog: dialog!, grid: grid! };
    };

    for (const [width, height] of [[1440, 900], [1024, 640], [800, 600]] as const) {
      await test.step(`${width} x ${height}`, async () => {
        await page.setViewportSize({ width, height });
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
        await form.search.fill(""); // the focus goes to the box now, so a later keystroke has nothing left to scroll into view
        await settled(page);
        const measured = await form.dialog.evaluate((dialog) => {
          const root = document.documentElement;
          const box = dialog.getBoundingClientRect();
          const grid = dialog.querySelector('[role="radiogroup"]')!.getBoundingClientRect();
          return { page: root.scrollWidth - root.clientWidth, dialog: dialog.scrollWidth - dialog.clientWidth, dialogRight: box.right, gridRight: grid.right, viewport: window.innerWidth };
        });
        // The page behind the dialog is checked at the two widths the plan names; at 800 px only the dialog is (nothing earlier measured /assets there).
        if (width >= 1024) expect(measured.page, `the page scrolls sideways by ${measured.page} px`).toBeLessThanOrEqual(0);
        expect(measured.dialog, `the dialog scrolls sideways by ${measured.dialog} px`).toBeLessThanOrEqual(0);
        expect(measured.gridRight, "the grid ends inside the dialog").toBeLessThanOrEqual(measured.dialogRight);
        expect(measured.dialogRight, "the dialog ends inside the window").toBeLessThanOrEqual(measured.viewport);
        const resting = await geometry();
        expect(resting.save.y + resting.save.height, `Save sits at ${resting.save.y + resting.save.height} px in a ${height} px window with the grid open`).toBeLessThanOrEqual(height);

        // The same three boxes for every kind of answer: all the icons, a few, none. A search that moved Save would be a button that runs away.
        for (const [text, radios] of [["transfer", 3], ["zzzzz", 1], ["", 49]] as const) {
          await form.search.fill(text);
          await expect(form.grid.getByRole("radio")).toHaveCount(radios);
          await settled(page);
          const now = await geometry();
          for (const part of ["save", "dialog", "grid"] as const) {
            for (const edge of ["x", "y", "width", "height"] as const) {
              expect(Math.abs(now[part][edge] - resting[part][edge]), `${part}.${edge} moved with the search "${text}" at ${width} x ${height}`).toBeLessThanOrEqual(1);
            }
          }
        }
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The deferrable part (plan decision 1): delete-and-move, with T1b-2 and T4b.

test.describe("W7o: delete a kind by moving its assets", () => {
  test("three assets use it: the move form, a fourth asset arrives (409, the new count, the choice kept), then the assets follow and the audit names the kinds", async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const [SOURCE, TARGET, BYSTANDER] = [`W7o source ${RUN}`, `W7o target ${RUN}`, `W7o bystander ${RUN}`];
    const source = await makeKind(page.request, SOURCE, "busway");
    const target = await makeKind(page.request, TARGET, "cabletray");
    await makeKind(page.request, BYSTANDER, "valve");
    const own = await makeAsset(page.request, `W7o move own icon ${RUN}`, SOURCE, "rack"); // an icon of its own: a move must not touch it
    const plain = await makeAsset(page.request, `W7o move plain ${RUN}`, SOURCE);
    await makeAsset(page.request, `W7o move third ${RUN}`, SOURCE);
    const stays = await makeAsset(page.request, `W7o stays ${RUN}`, BYSTANDER);

    await page.goto("/assets/kinds");
    await expect(heading1(page, "Asset kinds")).toBeVisible();
    await expect(kindCount(page, SOURCE)).toHaveText("3 assets");

    await (await rowAction(page, kindRow(page, SOURCE), "Delete")).click();
    const confirm = page.getByRole("dialog", { name: `Delete the kind "${SOURCE}"?`, exact: true });
    await expect(confirm).toBeVisible();
    const deleteButton = confirm.getByRole("button", { name: "Delete", exact: true });
    const choice = confirm.getByLabel("Move the assets to"); // never `exact`: the label wraps the select

    await test.step("the count, the choice of the other kinds, and Delete off until one is chosen", async () => {
      await expect(confirm.locator(".confirm-body")).toHaveText(`3 assets use "${SOURCE}". Move them to another kind, then delete "${SOURCE}".`);
      await expect(confirm.locator(".confirm-body select"), "the select is outside the region the dialog is described by").toHaveCount(0);
      await expect(choice).toHaveValue("");
      const options = await choice.locator("option").allTextContents();
      expect(options, "the other kinds are the choices").toContain(TARGET);
      expect(options).toContain(BYSTANDER);
      expect(options, "the kind itself is not one").not.toContain(SOURCE);
      await expect(deleteButton).toBeDisabled();
      await expect(confirm.getByRole("button", { name: "Cancel", exact: true }), "this is a question, so Cancel and not Close").toBeVisible();
    });

    await test.step("a fourth asset arrives while the dialog is open: the first Delete is refused with the new count, nothing changes, the choice stays", async () => {
      await choice.selectOption({ label: TARGET });
      await expect(choice).toHaveValue(String(target.id));
      await expect(deleteButton).toBeEnabled();
      await makeAsset(page.request, `W7o move late ${RUN}`, SOURCE); // the dialog still thinks 3
      await deleteButton.click();
      await expect(confirm.locator(".confirm-body")).toContainText(`4 assets use "${SOURCE}"`);
      await expect(confirm, "the dialog stays open").toBeVisible();
      await expect(choice, "and keeps the choice").toHaveValue(String(target.id));
      await expect(toast(page, "deleted"), "nothing was deleted").toHaveCount(0);
      const moved = (await assetsOf(page.request)).filter((a) => mine(a.name) && a.name.startsWith("W7o move "));
      expect(moved, "four assets of the source kind").toHaveLength(4);
      expect(moved.every((a) => a.kind === SOURCE), "none of them moved").toBe(true);
      expect((await kindsOf(page.request)).some((k) => k.id === source.id), "the kind is still there").toBe(true);
    });

    await test.step("the second Delete moves the four, deletes the kind, and the toast names both", async () => {
      await expect(deleteButton).toBeEnabled();
      await deleteButton.click();
      await expect(confirm).toBeHidden();
      await expect(toast(page, `Kind "${SOURCE}" deleted, 4 assets moved to ${TARGET}`)).toBeVisible();
      await expect(kindRow(page, SOURCE), "gone from the list").toHaveCount(0);
      await expect(kindCount(page, TARGET), "the target holds them now").toHaveText("4 assets");
      await expect(kindCount(page, BYSTANDER), "the bystander kind is untouched").toHaveText("1 asset");
    });

    await test.step("the assets follow the kind; an own icon and the other kind's assets are untouched", async () => {
      const assets = await assetsOf(page.request);
      const moved = assets.filter((a) => a.name.startsWith("W7o move ") && a.name.includes(` ${RUN}`));
      expect(moved).toHaveLength(4);
      for (const asset of moved) {
        expect(asset.kind, `${asset.name} follows the kind`).toBe(TARGET);
        expect(asset.kind_icon, `${asset.name} draws the target's icon`).toBe("cabletray");
      }
      expect(assets.find((a) => a.id === own.id)!.icon, "an asset's own icon is its own").toBe("rack");
      expect(assets.find((a) => a.id === plain.id)!.icon).toBeNull();
      expect(assets.find((a) => a.id === stays.id)!.kind, "an asset of another kind").toBe(BYSTANDER);
      expect((await kindsOf(page.request)).some((k) => k.id === source.id), "the kind is gone from the server").toBe(false);
    });

    await test.step("the audit entry says what moved where, in names", async () => {
      const log = await json<{ items: ApiAuditEntry[] }>(page.request, `/api/audit?action=kind.deleted&q=${encodeURIComponent(SOURCE)}&limit=50`);
      const entry = log.items.find((item) => item.detail.name === SOURCE);
      expect(entry, "the kind.deleted entry is in the log").toBeDefined();
      expect(entry!.detail.assets, "the number the UPDATE moved").toBe(4);
      expect(entry!.detail.moved_to, "the target's name").toBe(TARGET);
      await page.goto(`/audit?action=kind.deleted&q=${encodeURIComponent(SOURCE)}`);
      await expect(heading1(page, "Audit log")).toBeVisible();
      const sentence = page.locator(`.audit-table tr[data-entry-id="${entry!.id}"] td.cell-what`);
      await expect(sentence).toContainText(`Deleted asset kind ${SOURCE} and moved 4 assets to ${TARGET}`);
      await expect(sentence, "no number stands for a name").not.toContainText("#");
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7o: the data-centre starter kinds", () => {
  test("the button adds what is missing, skips a kind in another spelling without touching its icon, and a second press adds nothing and writes no audit entry", async ({ page }) => {
    test.setTimeout(150_000);
    await signIn(page);

    // A starter kind in another spelling and with another icon, if the registry has none: the pack must not add its own beside it, nor change it.
    const spelled = "router";
    if (!(await kindsOf(page.request)).some((k) => keyOf(k.name) === keyOf(spelled))) await makeKind(page.request, spelled, "generic");

    const before = await kindsOf(page.request);
    const have = new Set(before.map((k) => keyOf(k.name)));
    const missing = STARTER.filter((name) => !have.has(keyOf(name)));
    const auditBefore = await auditCount(page.request, "kind.starter_pack_added");

    await page.goto("/assets/kinds");
    await expect(heading1(page, "Asset kinds")).toBeVisible();
    const press = page.getByRole("button", { name: "Add data-centre kinds", exact: true });
    await expect(press).toBeVisible();
    const pressed = async (): Promise<StarterAnswer> => {
      await expect(press).not.toHaveAttribute("aria-disabled", "true"); // the previous press has finished and the list is back
      const answered = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/asset-kinds/starter-pack" && r.request().method() === "POST");
      await press.click();
      const response = await answered;
      expect(response.status(), "the pack answers 200").toBe(200);
      return (await response.json()) as StarterAnswer;
    };

    await test.step("the first press adds exactly the missing kinds", async () => {
      const first = await pressed();
      expect([...first.added].sort(), "the kinds the server added are the ones the registry lacked").toEqual([...missing].sort());
      expect(first.already_there, "and counts the rest").toBe(STARTER.length - missing.length);
      await expect(toast(page, missing.length === 0 ? "All the data-centre kinds are already there" : `Added ${missing.length} ${missing.length === 1 ? "kind" : "kinds"}`).last()).toBeVisible();
      const after = await kindsOf(page.request);
      expect(after.length, "the registry grew by what was added").toBe(before.length + missing.length);
      const keys = new Set(after.map((k) => keyOf(k.name)));
      for (const name of STARTER) expect(keys.has(keyOf(name)), `${name} is in the registry`).toBe(true);
      await expect(kindRow(page, "Data hall"), "the page lists them without a reload").toBeVisible();
      expect(await auditCount(page.request, "kind.starter_pack_added"), "one audit entry when something was added, none when not").toBe(auditBefore + (missing.length > 0 ? 1 : 0));
    });

    await test.step("a kind in another spelling was skipped, and keeps its own name and icon", async () => {
      const found = (await kindsOf(page.request)).filter((k) => keyOf(k.name) === keyOf(spelled));
      expect(found, "one kind, not two").toHaveLength(1);
      if (found[0].name === spelled) expect(found[0].icon, "the pack never overwrites an icon").toBe("generic"); // the one made above
    });

    await test.step("the second press says they are all there, adds nothing and writes no audit entry", async () => {
      const count = (await kindsOf(page.request)).length;
      const auditNow = await auditCount(page.request, "kind.starter_pack_added");
      const second = await pressed();
      expect(second.added, "nothing is added").toEqual([]);
      expect(second.already_there, "every starter kind is there").toBe(STARTER.length);
      await expect(toast(page, "All the data-centre kinds are already there").last()).toBeVisible();
      expect((await kindsOf(page.request)).length, "the registry did not grow").toBe(count);
      expect(await auditCount(page.request, "kind.starter_pack_added"), "a press that changes nothing leaves no trace").toBe(auditNow);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7o: Manage asset kinds is its own permission", () => {
  /** The role and the account that hold Change assets (and See the Assets Tree) but NOT Manage asset kinds: made through the API, as migration 0011 would not have made them. */
  async function makeEditor(browser: Browser): Promise<void> {
    await asAdmin(browser, async (request) => {
      await removeAccounts(request);
      const role = await request.post("/api/roles", { data: { name: EDITOR_ROLE, description: "made by w7o.spec.ts", permissions: ["assets.view", "assets.edit"] } });
      expect(role.status(), `creating the role: ${await role.text()}`).toBe(201);
      const user = await request.post("/api/users", { data: { username: EDITOR.username, password: EDITOR.password, role: EDITOR.role } });
      expect(user.status(), `creating the account: ${await user.text()}`).toBe(201);
    });
  }

  test("a role with Change assets reads the list and gets 403 on every kinds write, and nothing changes", async ({ browser, page }) => {
    test.setTimeout(120_000);
    await makeEditor(browser);
    await signIn(page);
    const seen = await makeKind(page.request, `W7o seen ${RUN}`, "meter");
    const spare = await makeKind(page.request, `W7o spare ${RUN}`, "rack");
    const before = await registryOf(page.request);

    await as(browser, EDITOR, async (api) => {
      expect((await api.get("/api/asset-kinds")).status(), "reading the list needs only See the Assets Tree").toBe(200);
      const attempts = [
        ["POST /api/asset-kinds", await api.post("/api/asset-kinds", { data: { name: `W7o refused ${RUN}`, icon: "rack" } })],
        ["PATCH /api/asset-kinds/{id}", await api.patch(`/api/asset-kinds/${seen.id}`, { data: { icon: "rack" } })],
        ["DELETE /api/asset-kinds/{id}", await api.delete(`/api/asset-kinds/${seen.id}`)],
        ["DELETE /api/asset-kinds/{id}?move_to=", await api.delete(`/api/asset-kinds/${seen.id}?move_to=${spare.id}&expect_assets=0`)],
        ["POST /api/asset-kinds/starter-pack", await api.post("/api/asset-kinds/starter-pack")],
      ] as const;
      for (const [what, response] of attempts) expect(response.status(), `${what} as a role without Manage asset kinds`).toBe(403);
    });
    expect(await registryOf(page.request), "nothing was made, renamed, re-iconed or deleted").toBe(before);
  });

  test("the Asset kinds page of that role shows the list and one line, and has no New kind, no starter button and no row menu", async ({ browser, page }) => {
    test.setTimeout(120_000);
    await makeEditor(browser);
    await signIn(page);
    const seen = await makeKind(page.request, `W7o shown ${RUN}`, "meter");
    await signInAs(page, EDITOR);
    await page.goto("/assets/kinds");
    await expect(heading1(page, "Asset kinds")).toBeVisible();
    await expect(userBlock(page)).toContainText(EDITOR.username);
    await expect(kindRow(page, seen.name), "the list is readable").toBeVisible();
    await expect(page.getByText('Managing asset kinds needs the "Manage asset kinds" permission.', { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New kind", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add data-centre kinds", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Actions for / })).toHaveCount(0);
  });

  test("that role adds an asset with a typed new kind: the text is stored, the note says so, and the registry is not written (no request, no 403)", async ({ browser, page }) => {
    test.setTimeout(120_000);
    await makeEditor(browser);
    await signInAs(page, EDITOR);
    const posted: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/asset-kinds") posted.push(request.url());
    });
    const [name, typed] = [`W7o editor asset ${RUN}`, `W7o editor kind ${RUN}`];
    const registry = await registryOf(page.request);

    const form = await openAddAsset(page);
    await form.name.fill(name);
    await form.kind.selectOption({ label: "Other…" });
    await form.newKind.fill(typed);
    await expect(form.dialog.getByText(/Only someone who manages kinds/), "the note says the kind is not added").toBeVisible();
    await expect(form.dialog.getByText(/added to Asset kinds/), "and not that it will be").toHaveCount(0);
    await form.save.click();
    await expect(form.dialog).toBeHidden();
    await expect(treeLink(page, name)).toBeVisible();
    await settled(page);

    const asset = (await assetsOf(page.request)).find((a) => a.name === name);
    expect(asset, `the asset ${name} was created`).toBeTruthy();
    expect(asset!.kind, "the asset keeps the text").toBe(typed);
    expect(await registryOf(page.request), "the registry is unchanged").toBe(registry);
    expect(posted, "no registration was even tried").toEqual([]);
  });

  test("an admin's typed new kind is registered with the asset, and the note says it will be", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const [name, typed] = [`W7o admin asset ${RUN}`, `W7o admin kind ${RUN}`];
    const form = await openAddAsset(page);
    await form.name.fill(name);
    await form.kind.selectOption({ label: "Other…" });
    await form.newKind.fill(typed);
    await expect(form.dialog.getByText(/added to Asset kinds/)).toBeVisible();
    await expect(form.dialog.getByText(/Only someone who manages kinds/)).toHaveCount(0);
    await form.save.click();
    await expect(form.dialog).toBeHidden();
    await expect(treeLink(page, name)).toBeVisible();
    await expect.poll(async () => (await kindsOf(page.request)).find((k) => k.name === typed)?.asset_count, { message: "the kind was registered and counts the asset" }).toBe(1);
  });

  test("the Roles editor offers Change assets and See the Assets Tree when Manage asset kinds is ticked alone, and the box is among the sensitive actions", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    await page.goto("/users/roles");
    await expect(heading1(page, "Users & Roles")).toBeVisible();
    await page.getByRole("button", { name: "New role", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "New role", exact: true });
    await expect(editor).toBeVisible();
    const box = (label: string) => editor.getByRole("checkbox", { name: label, exact: true });

    await expect(editor.locator("fieldset.role-sensitive").getByRole("checkbox", { name: "Manage asset kinds", exact: true }), "a risky action: in the sensitive box").toBeVisible();
    await box("Manage asset kinds").evaluate((node) => node.scrollIntoView({ block: "center" }));
    await box("Manage asset kinds").check();
    const offer = editor.getByRole("group", { name: "Manage asset kinds also needs these to show anything:", exact: true });
    await expect(offer).toBeVisible();
    await expect(offer.getByRole("listitem")).toHaveText(["Change assets", "See the Assets Tree"]);
    await offer.getByRole("button", { name: "Also tick 2 permissions", exact: true }).click();
    await expect(offer).toHaveCount(0);
    for (const label of ["Manage asset kinds", "Change assets", "See the Assets Tree"]) await expect(box(label), `${label} is ticked`).toBeChecked();
    await expect(editor.locator('input[type="checkbox"]:checked'), "and nothing else is").toHaveCount(3);

    await editor.getByRole("button", { name: "Cancel", exact: true }).click(); // nothing is saved: no role is made
    await expect(editor).toBeHidden();
  });
});
