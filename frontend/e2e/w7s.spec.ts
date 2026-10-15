import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { treeLink } from "./shell";

// W7s (delete the assets picked in the Assets Tree with one Delete in the pick bar, and tell the open asset from the picked ones) on the state the
// earlier projects leave behind: admin `admin` / `correct-horse`. The stack is SHARED, so the spec deletes only what it made: every asset starts
// `W7s <run>` (the digits-only run suffix as the neighbours use it; one root per case, `W7s <run> <case>`, with the case's assets under it), the
// account and the role start `w7s-`. Each case builds its OWN small plant through the API before the page is opened (the cases delete, so none
// may depend on another), afterEach removes what is left of it, and beforeAll / afterAll sweep what a stopped run left. The admin signs in through
// the API: the sign-in page is not what is tested here.
//
// The cases (independent; workers is 1, so they still run in file order):
//   1  Two leaves are picked while a third is open: the open row has a bar and no tint, the picked rows have the tint, the bar counts 2 and says the
//      open one is not counted; Delete lists both, confirms, both go, the toast says so, the picks clear, the page does not scroll and the focus
//      is on a named element in the tree column or the page's main area.
//   2  A picked parent and a picked child (and an unpicked second child, a tariff): the child goes with the parent (its note), the totals count the
//      branch, the audit log has ONE asset.deleted row, for the parent.
//   3  A child is added after the dialog showed its numbers: the first Delete is refused with the new numbers and nothing is deleted; the
//      second deletes the branch.
//   3b A pick someone else deleted before the dialog opened: the dialog is blocked (only Close), the tree refreshes, the next Delete works.
//   4  A partial failure: two picks, a child added to the second after the dialog loaded: the first goes, the second is refused (an error toast),
//      one pick remains with its Delete, the focus is on that Delete; finishing the job works.
//   5  The open asset among the picks: the page moves to its parent as soon as it is gone; the open asset below a picked branch: it moves to the
//      branch's parent.
//   6  A role with assets.view + assets.edit and no assets.delete: picks and Move to..., no Delete, and the API answers 403.  (cases 6 and 8 make the role and the account themselves, not beforeAll, so a refusal of the role fails those two cases only)
//   7  Keyboard: Tab to Delete, Enter opens, the focus is on Cancel, Escape closes, the focus is back on Delete.
//   8  The bar at the widths that matter, for the admin (two lines at 275 px of room or less, one line above, never cut) and for the role without
//      Delete (always one line): the stored column width at 1440 (220, 276, 277, 300 and the default), 1024 px with the sidebar both ways and 800 px.
//
// Locators. The tree is the region "Asset tree"; a row is its `.node` found by its own link (names are unique per run); the pick bar is the group
// "Selection". Playwright matches names by case-insensitive SUBSTRING and the page behind a dialog has buttons named Delete too (the bar's, the asset
// page's header trash `Delete <name>`): every button and dialog name below is `exact: true` and every lookup is scoped to the dialog, the tree
// region or the Selection group. A toast is found by its whole text inside the toast stack (`exactly`), never by a substring that a longer toast
// contains. The bar's Delete is named after the picks (`Delete the 2 picked assets`, then `Delete the picked asset` for one); the dialog's confirm
// button reads `Delete`, and `Delete anyway` when more than the picks goes (an unpicked sub-asset, a mapping, a tariff).

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse" };
const RUN = Date.now().toString();
const PREFIX = `W7s ${RUN}`;

const EDITOR_ROLE = "w7s-editor-role"; // assets.view + assets.edit: it can pick and move, not delete
const EDITOR = { username: "w7s-editor", password: "w7s-editor-pass", role: EDITOR_ROLE };
/** localStorage key of the tree column's width (lib/treeWidth.ts). */
const TREE_WIDTH_KEY = "dcdash.assetTreeWidth";
/** The bar is two lines when the tree body (the column less its 1px border) is this many px wide or less (the container query in styles/tree-move.css). */
const TWO_LINES_AT = 275;

const OPEN_NOT_COUNTED = "The open asset is not counted unless it is also picked.";
const GREW = "More was added while this was open. The numbers above are updated; delete again to confirm.";
const BLOCKED = "Some of the picked assets were already deleted by someone else. The tree has been refreshed; pick again.";
const LOSS = (assets: number, mappings: number, tariffs: number) =>
  `${assets} ${assets === 1 ? "asset" : "assets"}, ${mappings} ${mappings === 1 ? "mapping" : "mappings"} and ${tariffs} ${tariffs === 1 ? "tariff" : "tariffs"} will be deleted; their past energy and cost figures disappear from Billing and dashboards.`;
const UNDONE = "This can't be undone.";

interface ApiAsset { id: number; parent_id: number | null; name: string }
interface ApiUser { id: number; username: string }
interface ApiRole { id: number; name: string; builtin: boolean }
interface ApiAuditEntry { id: number; action: string; detail: Record<string, unknown> }

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A whole-text match (an anchored regular expression: `hasText` with a string is a case-insensitive substring). */
const exactly = (text: string) => new RegExp(`^${escapeRe(text)}$`);
/** The assets any run of this spec made (the digits-only run suffix after `W7s `). */
const anyRun = (name: string) => /^W7s \d+( |$)/.test(name);
/** The assets this run made. */
const mine = (name: string) => name === PREFIX || name.startsWith(`${PREFIX} `);

// ---------------------------------------------------------------------------------------------------------------------------------
// Requests

async function signInAs(page: Page, who: { username: string; password: string }): Promise<void> {
  const login = await page.request.post("/api/login", { data: { username: who.username, password: who.password } });
  expect(login.ok(), `signing in as ${who.username}: ${login.status()} ${await login.text()}`).toBe(true);
}

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
/** The ids (from `ids`) that are still in the asset list. */
async function stillThere(request: APIRequestContext, ids: number[]): Promise<number[]> {
  const present = new Set((await assetsOf(request)).map((a) => a.id));
  return ids.filter((id) => present.has(id));
}

/** Every account whose name starts with w7s-, then every custom role that does (a role an account holds cannot be deleted). */
async function removeAccounts(request: APIRequestContext): Promise<void> {
  for (const user of (await json<ApiUser[]>(request, "/api/users")).filter((u) => u.username.startsWith("w7s-"))) {
    const gone = await request.delete(`/api/users/${user.id}`);
    expect([204, 404], `deleting ${user.username}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
  for (const role of (await json<ApiRole[]>(request, "/api/roles")).filter((r) => !r.builtin && r.name.toLowerCase().startsWith("w7s-"))) {
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

/** The asset.deleted rows whose name starts with `label` (the audit search is a substring match on the entry, so it is filtered by the exact name here). */
async function deletedEntries(request: APIRequestContext, label: string): Promise<ApiAuditEntry[]> {
  const log = await json<{ items: ApiAuditEntry[] }>(request, `/api/audit?action=asset.deleted&q=${encodeURIComponent(label)}&limit=100`);
  return log.items.filter((entry) => typeof entry.detail.name === "string" && (entry.detail.name === label || entry.detail.name.startsWith(`${label} `)));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The plants: one small tree per case, made through the API

interface NodeDef {
  key: string;
  /** The parent's key; left out = directly under the plant's root. */
  parent?: string;
  sort?: number;
  /** A tariff of its own from 2020-01-01. */
  rate?: number;
}
interface Plant {
  /** The asset id of every key; "" is the plant's root. */
  id: Record<string, number>;
  name(key: string): string;
}

/** Every id this case made (also the ones added late): afterEach removes them. */
const made: number[] = [];

async function addAsset(request: APIRequestContext, plant: Plant, key: string, parent: string | null, sort = 0): Promise<void> {
  const created = await request.post("/api/assets", {
    data: { name: plant.name(key), parent_id: parent === null ? null : plant.id[parent], kind: "generic", sort_order: sort },
  });
  expect(created.status(), `creating ${plant.name(key)}: ${await created.text()}`).toBe(201);
  plant.id[key] = ((await created.json()) as { id: number }).id;
  made.push(plant.id[key]);
}

async function makePlant(request: APIRequestContext, label: string, nodes: NodeDef[]): Promise<Plant> {
  const plant: Plant = { id: {}, name: (key) => (key === "" ? `${PREFIX} ${label}` : `${PREFIX} ${label} ${key}`) };
  await addAsset(request, plant, "", null);
  for (const node of nodes) {
    await addAsset(request, plant, node.key, node.parent ?? "", node.sort ?? 0);
    if (node.rate !== undefined) {
      const rate = await request.post("/api/tariffs", { data: { asset_id: plant.id[node.key], rate_per_kwh: node.rate, effective_from: "2020-01-01" } });
      expect(rate.status(), `the rate of ${node.key}: ${await rate.text()}`).toBe(201);
    }
  }
  return plant;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The browser

interface Box { x: number; y: number; width: number; height: number }

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const tree = (page: Page) => page.getByRole("region", { name: "Asset tree" });
const slot = (page: Page) => tree(page).getByRole("group", { name: "Selection", exact: true });
/** A button of the pick bar by its whole name. */
const barButton = (page: Page, name: string) => slot(page).getByRole("button", { name, exact: true });
/** A tree row (`div.node`, the element that is marked), found by its own link. */
const rowOf = (page: Page, name: string) => tree(page).locator(".node").filter({ has: page.getByRole("link", { name, exact: true }) });
const picked = (page: Page) => tree(page).locator(".node[data-picked]");
/** A toast by its whole text (and its kind, when it matters): a longer toast that contains the text does not match. */
const toast = (page: Page, text: string, kind?: "success" | "info" | "error") =>
  page
    .locator(kind ? `.toast-stack .toast[data-kind="${kind}"]` : ".toast-stack .toast")
    .filter({ has: page.locator(".toast-text", { hasText: exactly(text) }) });
const deleteDialog = (page: Page, title: string) => page.getByRole("dialog", { name: title, exact: true });
const confirmButton = (dialog: Locator, label: "Delete" | "Delete anyway") => dialog.getByRole("button", { name: label, exact: true });

/** Two animation frames: whatever the page does about a viewport change or an update has happened by then. */
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

async function boxOf(locator: Locator, what: string): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  return box!;
}

/** The ids of the picked rows, sorted. */
const pickedIds = (page: Page) =>
  picked(page).evaluateAll((rows) => rows.map((row) => Number((row as HTMLElement).dataset.assetId)).sort((a, b) => a - b));

async function expectPicked(page: Page, plant: Plant, keys: string[]): Promise<void> {
  await expect.poll(() => pickedIds(page), { message: `exactly ${keys.join(", ")} are picked` }).toEqual(keys.map((key) => plant.id[key]).sort((a, b) => a - b));
  await expect(slot(page)).toContainText(`${keys.length} picked`);
}

/**
 * Opens the Assets Tree (`/assets`, or `/assets/<id>` of the plant's `open` key) and waits for the plant's root row. `width` sets the stored column
 * width first (a number in px, null = forget it) through a first visit that gives localStorage its origin; the app reads it when it loads.
 */
async function openTree(page: Page, plant: Plant, options: { open?: string; width?: number | null } = {}): Promise<void> {
  if (options.width !== undefined) {
    await page.goto("/assets");
    await page.evaluate(
      ([key, px]) => {
        if (px === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, String(px));
      },
      [TREE_WIDTH_KEY, options.width] as [string, number | null],
    );
  }
  await page.goto(options.open === undefined ? "/assets" : `/assets/${plant.id[options.open]}`);
  await expect(treeLink(page, plant.name(""))).toBeVisible();
  if (options.open !== undefined) {
    await expect(treeLink(page, plant.name(options.open))).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/assets/${plant.id[options.open]}$`));
  }
}

/** Ctrl-clicks the rows' links: each is picked and nothing is opened. */
async function pick(page: Page, plant: Plant, ...keys: string[]): Promise<void> {
  for (const key of keys) await treeLink(page, plant.name(key)).click({ modifiers: ["Control"] });
  await expectPicked(page, plant, keys);
}

/** Presses the bar's Delete and returns the dialog once it has asked and answered; the confirm button is on then. */
async function openDeleteDialog(page: Page, barName: string, title: string, confirm: "Delete" | "Delete anyway" = "Delete") {
  await barButton(page, barName).click();
  const dialog = deleteDialog(page, title);
  await expect(dialog).toBeVisible();
  // Native disabled while it asks the server what the delete takes: enabled means the numbers are in (the checking line has gone).
  await expect(confirmButton(dialog, confirm)).toBeEnabled();
  return { dialog, confirm: confirmButton(dialog, confirm), body: dialog.locator(".confirm-body") };
}

/** Where the focus is: "(body)" when nothing named has it, else the region it is in and its name. */
const focusPlace = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "(body)";
    const where = el.closest(".tree-col") ? "tree" : el.closest("#main") ? "main" : "elsewhere";
    return `${where}: ${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 60)}`;
  });

/** How far the page is scrolled, and how far it could be. */
const scrollNow = (page: Page) =>
  page.evaluate(() => ({ y: window.scrollY, max: document.documentElement.scrollHeight - window.innerHeight }));

/** The colour a token has in the page's current look, as the browser prints a computed colour (rgb(...)). */
function tokenColour(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.documentElement.appendChild(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);
}

/** Makes sure the sidebar is the way wanted (it starts the way the first width chose, and has no resize listener) and the tree column has stopped moving. */
async function sidebar(page: Page, want: "expanded" | "minimized"): Promise<void> {
  const shell = page.locator(".shell");
  if ((await shell.getAttribute("data-sidebar")) !== want) await page.locator(".side-toggle").click();
  await expect(shell).toHaveAttribute("data-sidebar", want);
  await columnStill(page);
}

/** The tree column has stopped moving (the stored width is clamped once the room is measured, and the sidebar animates). */
async function columnStill(page: Page): Promise<void> {
  let last = -1;
  await expect
    .poll(async () => {
      const width = (await boxOf(tree(page), "the tree column")).width;
      const same = width === last;
      last = width;
      return same;
    }, { message: "the tree column has stopped moving" })
    .toBe(true);
}

// ---------------------------------------------------------------------------------------------------------------------------------

test.beforeAll(async ({ browser }) => {
  await asAdmin(browser, async (request) => {
    await removeAccounts(request); // an earlier run that stopped half way
    await deleteAssets(request, (await assetsOf(request)).filter((a) => anyRun(a.name)).map((a) => a.id));
  });
});

/**
 * The role that may pick and move but not delete, and its account, for the two cases that need them (made there and not in beforeAll, so a refusal
 * of the role takes down those two cases and not the whole file). Whatever an earlier case left is removed first; afterAll removes them.
 */
async function makeEditor(browser: Browser): Promise<void> {
  await asAdmin(browser, async (request) => {
    await removeAccounts(request);
    const role = await request.post("/api/roles", { data: { name: EDITOR_ROLE, description: "made by w7s.spec.ts", permissions: ["assets.view", "assets.edit"] } });
    expect(role.status(), `creating the role: ${await role.text()}`).toBe(201);
    const user = await request.post("/api/users", { data: { username: EDITOR.username, password: EDITOR.password, role: EDITOR.role } });
    expect(user.status(), `creating the account: ${await user.text()}`).toBe(201);
  });
}

test.afterEach(async ({ browser }) => {
  // What the case that just ran made and did not delete, whatever happened to it (a tariff goes with its asset).
  const ids = made.splice(0);
  if (ids.length === 0) return;
  await asAdmin(browser, (request) => deleteAssets(request, ids));
});

test.afterAll(async ({ browser }) => {
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
    await attempt("the assets", async () => deleteAssets(request, (await assetsOf(request)).filter((a) => mine(a.name)).map((a) => a.id)));
    await attempt("the account and the role", () => removeAccounts(request));
  });
  expect(failures, "the clean-up left something behind").toEqual([]);
});

test.beforeEach(async ({ page }) => {
  await signInAs(page, ADMIN);
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7s: deleting the picked assets", () => {
  test("two leaves picked while a third is open: the open row has a bar and no tint, the bar counts 2 and says the open one is left out, Delete removes both, and the page stays put with the focus on a named element", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const plant = await makePlant(page.request, "c1", [{ key: "Rack 1", sort: 10 }, { key: "Rack 2", sort: 20 }, { key: "Rack 3", sort: 30 }]);
    const [r1, r2, r3] = [plant.name("Rack 1"), plant.name("Rack 2"), plant.name("Rack 3")];
    await openTree(page, plant, { open: "Rack 3" });

    await test.step("the picks have the tint, the open row only its bar, and the bar says what it counts", async () => {
      await pick(page, plant, "Rack 1", "Rack 2");
      await expect(page, "picking opens nothing").toHaveURL(new RegExp(`/assets/${plant.id["Rack 3"]}$`));
      await page.mouse.move(700, 450); // off the rows: a hovered row has its own background
      const tint = await tokenColour(page, "--accent-tint");
      await expect(rowOf(page, r1), "a pick is on the tint").toHaveCSS("background-color", tint);
      await expect(rowOf(page, r2), "a pick is on the tint").toHaveCSS("background-color", tint);
      await expect(rowOf(page, r3)).toHaveClass(/is-selected/);
      await expect(rowOf(page, r3), "the open row has no tint").toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(rowOf(page, r3), "the open row is not a pick").not.toHaveAttribute("data-picked", /.*/);
      await expect(slot(page).locator(".tree-slot-count")).toHaveText("2 picked");
      await expect(slot(page).locator(".tree-slot-count"), "the count says the open asset is left out").toHaveAttribute("title", OPEN_NOT_COUNTED);
      await expect(slot(page).locator(".sr-only")).toHaveText(`The open asset, ${r3}, is not counted.`);
    });

    await test.step("Delete lists both and nothing else; confirming deletes both and leaves the open asset", async () => {
      await page.evaluate(() => window.scrollTo(0, 300)); // as far as the page can go: the delete must not change it
      await settled(page);
      const before = await scrollNow(page);
      const ask = await openDeleteDialog(page, "Delete the 2 picked assets", "Delete 2 assets?");
      await expect(ask.body).toHaveText(`${r1}, ${r2}. ${UNDONE}`);
      await expect(confirmButton(ask.dialog, "Delete anyway"), "nothing but the picks goes: the plain button").toHaveCount(0);
      await ask.confirm.click();

      await expect(ask.dialog).toBeHidden();
      await expect(treeLink(page, r1)).toHaveCount(0);
      await expect(treeLink(page, r2)).toHaveCount(0);
      await expect(toast(page, "Deleted 2 assets", "success")).toBeVisible();
      await expect(picked(page), "the picks went with the assets").toHaveCount(0);
      await expect(slot(page)).toContainText("Ctrl-click to pick several");
      await expect(treeLink(page, r3), "the open asset is still there").toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/assets/${plant.id["Rack 3"]}$`));
      await expect.poll(() => focusPlace(page), { message: "the focus is on a named element in the tree column or the main area, not the page body" }).toMatch(/^(tree|main): /);
      await settled(page);
      const after = await scrollNow(page);
      expect(Math.abs(after.y - Math.min(before.y, after.max)), `scrollY went from ${before.y} to ${after.y} (the most it could be: ${after.max})`).toBeLessThanOrEqual(1);
      expect(await asAdmin(browser, (request) => stillThere(request, [plant.id["Rack 1"], plant.id["Rack 2"], plant.id["Rack 3"]])), "only the open asset is left").toEqual([plant.id["Rack 3"]]);
    });
  });

  test("a picked parent and its picked child: the child goes with the parent, the totals count the branch and its tariff, and the audit log has one row, for the parent", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const plant = await makePlant(page.request, "c2", [
      { key: "Hall", sort: 10, rate: 0.111 },
      { key: "Rack 1", parent: "Hall", sort: 10 },
      { key: "Rack 2", parent: "Hall", sort: 20 },
    ]);
    const [hall, r1, r2] = [plant.name("Hall"), plant.name("Rack 1"), plant.name("Rack 2")];
    await openTree(page, plant);
    await pick(page, plant, "Hall", "Rack 1");

    // Two names picked, three assets go: the dialog counts the picks in its title and the branch in its totals.
    const ask = await openDeleteDialog(page, "Delete the 2 picked assets", "Delete 2 assets?", "Delete anyway");
    await expect(ask.body).toHaveText(`${hall}, ${r1}. ${r1} is inside ${hall}, which is also picked, so it goes with it. ${LOSS(3, 0, 1)} ${UNDONE}`);
    await ask.confirm.click();

    await expect(ask.dialog).toBeHidden();
    await expect(toast(page, "Deleted 3 assets", "success")).toBeVisible();
    for (const name of [hall, r1, r2]) await expect(treeLink(page, name), `${name} is gone from the tree`).toHaveCount(0);
    await expect(treeLink(page, plant.name("")), "the plant's root stays").toBeVisible();
    expect(await asAdmin(browser, (request) => stillThere(request, [plant.id["Hall"], plant.id["Rack 1"], plant.id["Rack 2"], plant.id[""]]))).toEqual([plant.id[""]]);

    const rows = await asAdmin(browser, (request) => deletedEntries(request, plant.name("")));
    const named = (name: string) => rows.filter((entry) => entry.detail.name === name);
    expect(named(hall), "one asset.deleted row for the parent").toHaveLength(1);
    expect(named(hall)[0].detail, "the row holds the branch's numbers").toMatchObject({ asset_id: plant.id["Hall"], assets: 3, mappings: 0, tariffs: 1 });
    expect(named(r1), "none for the child that went with it").toHaveLength(0);
    expect(named(r2), "none for the sub-asset nobody picked").toHaveLength(0);
  });

  test("a child added after the dialog showed its numbers: the first Delete is refused with the new numbers and deletes nothing, the second deletes the whole branch", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const plant = await makePlant(page.request, "c3", [{ key: "Rack 1", sort: 10 }]);
    const r1 = plant.name("Rack 1");
    await openTree(page, plant);
    await pick(page, plant, "Rack 1");

    const ask = await openDeleteDialog(page, "Delete the picked asset", "Delete 1 asset?");
    await expect(ask.body).toHaveText(`${r1}. ${UNDONE}`);

    await test.step("a second person adds a child; Delete is refused, the dialog shows the new numbers and asks again", async () => {
      await addAsset(page.request, plant, "Rack 1 Sub", "Rack 1");
      await ask.confirm.click();
      await expect(ask.dialog.getByRole("alert")).toHaveText(GREW);
      await expect(ask.dialog, "the dialog stays open").toBeVisible();
      await expect(ask.body).toHaveText(`${r1}. ${LOSS(2, 0, 0)} ${UNDONE}`);
      await expect(confirmButton(ask.dialog, "Delete anyway")).toBeEnabled();
      await expect(confirmButton(ask.dialog, "Delete"), "the plain button has become Delete anyway").toHaveCount(0);
      expect(await asAdmin(browser, (request) => stillThere(request, [plant.id["Rack 1"], plant.id["Rack 1 Sub"]])), "nothing was deleted").toEqual([plant.id["Rack 1"], plant.id["Rack 1 Sub"]]);
    });

    await test.step("delete again: the branch goes, both assets, and the toast counts both", async () => {
      await confirmButton(ask.dialog, "Delete anyway").click();
      await expect(ask.dialog).toBeHidden();
      await expect(toast(page, "Deleted 2 assets", "success")).toBeVisible();
      await expect(treeLink(page, r1)).toHaveCount(0);
      expect(await asAdmin(browser, (request) => stillThere(request, [plant.id["Rack 1"], plant.id["Rack 1 Sub"]]))).toEqual([]);
    });
  });

  test("a pick that somebody else deleted before the dialog opened: the dialog is blocked with only Close, the tree refreshes and drops that pick, and the next Delete works", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const plant = await makePlant(page.request, "c3b", [{ key: "Rack 1", sort: 10 }, { key: "Rack 2", sort: 20 }]);
    const [r1, r2] = [plant.name("Rack 1"), plant.name("Rack 2")];
    await openTree(page, plant);
    await pick(page, plant, "Rack 1", "Rack 2");

    await test.step("Rack 2 is deleted behind the page's back; Delete is pressed on the stale list", async () => {
      const gone = await page.request.delete(`/api/assets/${plant.id["Rack 2"]}?confirm=true`);
      expect(gone.status(), `deleting Rack 2 behind the page: ${await gone.text()}`).toBe(204);
      // An early refetch would have pruned the pick and made this a different test: the bar must still say 2.
      await expect(slot(page)).toContainText("2 picked");
      await barButton(page, "Delete the 2 picked assets").click();
      const dialog = deleteDialog(page, "Delete 2 assets?");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("alert")).toHaveText(BLOCKED);
      await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: /^Delete/ }), "nothing can be confirmed").toHaveCount(0);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toBeHidden();
    });

    await test.step("the tree has refreshed: the vanished pick is gone, the other stays picked", async () => {
      await expect(treeLink(page, r2)).toHaveCount(0);
      await expectPicked(page, plant, ["Rack 1"]);
      expect(await asAdmin(browser, (request) => stillThere(request, [plant.id["Rack 1"]]))).toEqual([plant.id["Rack 1"]]);
    });

    await test.step("the next Delete works", async () => {
      const ask = await openDeleteDialog(page, "Delete the picked asset", "Delete 1 asset?");
      await expect(ask.body).toHaveText(`${r1}. ${UNDONE}`);
      await ask.confirm.click();
      await expect(ask.dialog).toBeHidden();
      await expect(toast(page, "Deleted 1 asset", "success")).toBeVisible();
      await expect(treeLink(page, r1)).toHaveCount(0);
      expect(await asAdmin(browser, (request) => stillThere(request, [plant.id["Rack 1"]]))).toEqual([]);
    });
  });

  test("a partial failure: of two picks the first goes and the second, which grew meanwhile, is refused; the error toast says so, the second stays picked with its Delete, and finishing the job works", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const plant = await makePlant(page.request, "c4", [{ key: "Rack 1", sort: 10 }, { key: "Rack 2", sort: 20 }]);
    const [r1, r2] = [plant.name("Rack 1"), plant.name("Rack 2")];
    await openTree(page, plant);
    await pick(page, plant, "Rack 1", "Rack 2");

    const ask = await openDeleteDialog(page, "Delete the 2 picked assets", "Delete 2 assets?");
    await expect(ask.body).toHaveText(`${r1}, ${r2}. ${UNDONE}`);

    await test.step("a child is added to the second pick after the dialog loaded; the first is deleted, the second refused", async () => {
      await addAsset(page.request, plant, "Rack 2 Sub", "Rack 2");
      await ask.confirm.click();
      await expect(ask.dialog).toBeHidden();
      await expect(
        toast(page, `Deleted 1 asset. "${r2}" could not be deleted: More was added under it since the numbers were shown.`, "error"),
      ).toBeVisible();
      await expect(treeLink(page, r1), "the first is gone").toHaveCount(0);
      await expect(treeLink(page, r2), "the second stays").toBeVisible();
    });

    await test.step("one pick remains, with its Delete, and the focus is on that Delete", async () => {
      await expectPicked(page, plant, ["Rack 2"]);
      await expect(barButton(page, "Delete the picked asset")).toBeVisible();
      await expect(barButton(page, "Delete the picked asset"), "the focus went back to the button that opened the dialog").toBeFocused();
      expect(await asAdmin(browser, (request) => stillThere(request, [plant.id["Rack 1"], plant.id["Rack 2"], plant.id["Rack 2 Sub"]]))).toEqual([plant.id["Rack 2"], plant.id["Rack 2 Sub"]]);
    });

    await test.step("pressing Delete again shows the branch as it is now, and confirming finishes the job", async () => {
      const again = await openDeleteDialog(page, "Delete the picked asset", "Delete 1 asset?", "Delete anyway");
      await expect(again.body).toHaveText(`${r2}. ${LOSS(2, 0, 0)} ${UNDONE}`);
      await again.confirm.click();
      await expect(again.dialog).toBeHidden();
      await expect(toast(page, "Deleted 2 assets", "success")).toBeVisible();
      expect(await asAdmin(browser, (request) => stillThere(request, [plant.id["Rack 2"], plant.id["Rack 2 Sub"]]))).toEqual([]);
    });
  });

  test("the open asset among the picks: the page moves to its parent as soon as it is gone; the open asset below a picked branch: it moves to the branch's parent", async ({ page }) => {
    test.setTimeout(150_000);
    const plant = await makePlant(page.request, "c5", [
      { key: "Hall A", sort: 10 },
      { key: "Rack A1", parent: "Hall A", sort: 10 },
      { key: "Rack A2", parent: "Hall A", sort: 20 },
      { key: "Hall B", sort: 20 },
      { key: "Rack B1", parent: "Hall B", sort: 10 },
    ]);

    await test.step("Rack A1 is open and picked with Rack A2: both go and the page is Hall A's", async () => {
      await openTree(page, plant, { open: "Rack A1" });
      await pick(page, plant, "Rack A1", "Rack A2");
      await expect(slot(page).locator(".tree-slot-count"), "the open asset is a pick, so nothing is left out of the count").not.toHaveAttribute("title", /./);
      const ask = await openDeleteDialog(page, "Delete the 2 picked assets", "Delete 2 assets?");
      await ask.confirm.click();
      await expect(ask.dialog).toBeHidden();
      await expect(toast(page, "Deleted 2 assets", "success")).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/assets/${plant.id["Hall A"]}$`));
      await expect(heading1(page, plant.name("Hall A"))).toBeVisible();
      await expect(treeLink(page, plant.name("Rack A1"))).toHaveCount(0);
      await expect(treeLink(page, plant.name("Rack A2"))).toHaveCount(0);
    });

    await test.step("Rack B1 is open and only Hall B, above it, is picked: both go and the page is the plant's root", async () => {
      await openTree(page, plant, { open: "Rack B1" });
      await pick(page, plant, "Hall B");
      const ask = await openDeleteDialog(page, "Delete the picked asset", "Delete 1 asset?", "Delete anyway");
      await expect(ask.body).toContainText(LOSS(2, 0, 0));
      await ask.confirm.click();
      await expect(ask.dialog).toBeHidden();
      await expect(toast(page, "Deleted 2 assets", "success")).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/assets/${plant.id[""]}$`));
      await expect(heading1(page, plant.name(""))).toBeVisible();
      await expect(treeLink(page, plant.name("Hall B"))).toHaveCount(0);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7s: who may delete, and the keyboard", () => {
  test("a role that can pick and move but not delete has no Delete in the bar, and the API answers 403 to a delete", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const plant = await makePlant(page.request, "c6", [{ key: "Rack 1", sort: 10 }, { key: "Rack 2", sort: 20 }]);
    await makeEditor(browser);
    await signInAs(page, EDITOR);
    await openTree(page, plant);

    await test.step("it can pick, and the bar offers Move to... and Clear, nothing else", async () => {
      await pick(page, plant, "Rack 1", "Rack 2");
      await expect(slot(page).getByRole("button")).toHaveText(["Move to...", "Clear"]);
      await expect(slot(page).getByRole("button", { name: /^Delete/ })).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    await test.step("the API answers 403 to the preview and to the delete, and nothing is deleted", async () => {
      const impact = await page.request.get(`/api/assets/${plant.id["Rack 1"]}/impact`);
      expect(impact.status(), "the impact route as an editor").toBe(403);
      const gone = await page.request.delete(`/api/assets/${plant.id["Rack 1"]}?confirm=true&expect_assets=1&expect_mappings=0&expect_tariffs=0`);
      expect(gone.status(), `deleting as an editor: ${await gone.text()}`).toBe(403);
      expect(await asAdmin(browser, (request) => stillThere(request, [plant.id["Rack 1"], plant.id["Rack 2"]]))).toEqual([plant.id["Rack 1"], plant.id["Rack 2"]]);
    });
  });

  test("keyboard: Tab reaches Delete, Enter opens the dialog with the focus on Cancel, Escape closes it with the focus back on Delete, and so does Cancel", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const plant = await makePlant(page.request, "c7", [{ key: "Rack 1", sort: 10 }, { key: "Rack 2", sort: 20 }]);
    await openTree(page, plant);
    await pick(page, plant, "Rack 1", "Rack 2");
    const del = barButton(page, "Delete the 2 picked assets");
    const dialog = deleteDialog(page, "Delete 2 assets?");
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });

    await test.step("Tab from Move to... lands on Delete, Enter opens the dialog, the focus is on Cancel", async () => {
      await barButton(page, "Move to...").focus();
      await expect(barButton(page, "Move to...")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(del, "Delete comes right after Move to...").toBeFocused();
      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      await expect(cancel).toBeFocused();
    });

    await test.step("Escape closes only the dialog, and the focus is back on Delete", async () => {
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(del).toBeFocused();
      await expectPicked(page, plant, ["Rack 1", "Rack 2"]);
    });

    await test.step("the same by Cancel", async () => {
      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      await expect(cancel).toBeFocused();
      await cancel.click();
      await expect(dialog).toBeHidden();
      await expect(del).toBeFocused();
      expect(await asAdmin(browser, (request) => stillThere(request, [plant.id["Rack 1"], plant.id["Rack 2"]])), "nothing was deleted").toEqual([plant.id["Rack 1"], plant.id["Rack 2"]]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * The pick bar at the page's current width: the height is decided by the room and the permission, never by the picks, and nothing is cut.
 * `hasDelete` is whether the viewer may delete assets: only then is the bar two lines when the tree body is 275 px wide or less.
 */
async function checkBar(page: Page, plant: Plant, hasDelete: boolean, where: string): Promise<void> {
  const room = (await boxOf(tree(page).locator(".tree-body"), "the tree body")).width;
  const want = hasDelete && room <= TWO_LINES_AT ? 64 : 32;
  const note = `${where} (the tree body is ${room} px wide, ${hasDelete ? "with" : "without"} Delete)`;
  const idle = await boxOf(slot(page), "the pick bar");
  expect(idle.height, `the bar is ${want} px high at ${note}`).toBe(want);
  // W7t: the two-line bar (Delete, narrow) shows the SHORT hint so that Move to... can sit beside the words; everywhere else the long hint stays.
  await expect(slot(page).locator(want === 64 ? ".tree-slot-short" : ".tree-slot-long"), `the idle hint at ${note}`).toBeVisible();
  await expect(slot(page).locator(want === 64 ? ".tree-slot-long" : ".tree-slot-short"), `the other idle hint at ${note}`).toBeHidden();
  const idleText = await boxOf(slot(page).locator(".tree-slot-text"), "the idle hint");

  await treeLink(page, plant.name("Rack 1")).click({ modifiers: ["Control"] });
  await expect(slot(page)).toContainText("1 picked");
  const bar = await boxOf(slot(page), "the pick bar with a pick");
  expect(Math.abs(bar.height - idle.height), `the first pick changed the bar's height at ${note}: ${idle.height} to ${bar.height}`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(bar.y - idle.y), `the first pick moved the bar at ${note}`).toBeLessThanOrEqual(0.5);

  // Nothing is cut: the count and every button lie inside the bar, the count is not shortened with "...", and the bar does not scroll sideways.
  const count = await boxOf(slot(page).locator(".tree-slot-count"), "the count");
  const buttons = barButton(page, "Move to...").or(barButton(page, "Clear")).or(slot(page).getByRole("button", { name: /^Delete/ }));
  const parts: [string, Box][] = [["the count", count]];
  for (const [at, button] of (await buttons.all()).entries()) parts.push([`button ${at + 1}`, await boxOf(button, `button ${at + 1}`)]);
  expect(parts.length, `the bar has the count, Move to..., Clear${hasDelete ? " and Delete" : ""} at ${note}`).toBe(hasDelete ? 4 : 3);
  for (const [what, box] of parts) {
    expect(box.x, `${what} starts inside the bar at ${note}`).toBeGreaterThanOrEqual(bar.x - 0.5);
    expect(box.x + box.width, `${what} ends inside the bar at ${note}`).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
    expect(box.y, `${what} starts inside the bar at ${note}`).toBeGreaterThanOrEqual(bar.y - 0.5);
    expect(box.y + box.height, `${what} ends inside the bar at ${note}`).toBeLessThanOrEqual(bar.y + bar.height + 0.5);
  }
  const overflow = await slot(page).evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow, `the bar scrolls sideways by ${overflow} px at ${note}`).toBeLessThanOrEqual(1);
  const cut = await slot(page).locator(".tree-slot-count").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(cut, `the count is cut by ${cut} px at ${note}`).toBeLessThanOrEqual(1); // scrollWidth and clientWidth are rounded separately
  // The words stand still at the first pick: the hint and the count have the same box (the bar's first line never moves).
  expect(Math.abs(count.y - idleText.y), `the first pick moved the words at ${note}: ${idleText.y} to ${count.y}`).toBeLessThanOrEqual(0.5);
  if (hasDelete) {
    const del = await boxOf(barButton(page, "Delete the picked asset"), "Delete");
    if (want === 64) {
      // W7t: Move to... is beside the count on line 1; Delete (and Clear) are on line 2, below both.
      const move = await boxOf(barButton(page, "Move to..."), "Move to...");
      expect(Math.abs(move.y + move.height / 2 - (count.y + count.height / 2)), `Move to... is on the count's line at ${note}`).toBeLessThanOrEqual(2);
      expect(del.y, `Delete is on the second line, below the count and Move to..., at ${note}`).toBeGreaterThanOrEqual(Math.max(count.y + count.height, move.y + move.height) - 0.5);
      const clear = await boxOf(barButton(page, "Clear"), "Clear");
      expect(Math.abs(clear.y - del.y), `Clear is on Delete's line at ${note}`).toBeLessThanOrEqual(1);
    } else expect(Math.abs(del.y + del.height / 2 - (count.y + count.height / 2)), `Delete is on the count's line at ${note}`).toBeLessThanOrEqual(2);
  } else {
    await expect(slot(page).getByRole("button", { name: /^Delete/ })).toHaveCount(0);
  }
  for (const selector of [".tree-scroll", "ul.tree"]) {
    const sideways = await tree(page).locator(selector).first().evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(sideways, `${selector} scrolls sideways by ${sideways} px at ${note}`).toBeLessThanOrEqual(1);
  }

  await barButton(page, "Clear").click(); // the next width starts from a first pick again
  await expect(picked(page)).toHaveCount(0);
  await expect(slot(page)).toContainText("Ctrl-click to pick several");
}

/** The same widths for every viewer: the stored column width at 1440 (the narrowest, both sides of the 275 px line, wider, the default) and the small windows. */
async function runWidths(page: Page, plant: Plant, hasDelete: boolean): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440);
  // The column is the stored width plus nothing: the body is one pixel less (the column's border), so 276 px is two lines and 277 px is one.
  for (const stored of [220, 276, 277, 300]) {
    await test.step(`1440 px, the column stored at ${stored} px`, async () => {
      await openTree(page, plant, { width: stored });
      await expect.poll(async () => Math.round((await boxOf(tree(page), "the tree column")).width), { message: `the column takes the stored ${stored} px` }).toBe(stored);
      await columnStill(page);
      if (stored === 276 || stored === 277) {
        const room = (await boxOf(tree(page).locator(".tree-body"), "the tree body")).width;
        expect(room, `the body is the column less its 1px border at ${stored} px`).toBe(stored - 1);
      }
      await checkBar(page, plant, hasDelete, `1440 px, the column stored at ${stored} px`);
    });
  }
  await test.step("1440 px, the default width", async () => {
    await openTree(page, plant, { width: null });
    await columnStill(page);
    await checkBar(page, plant, hasDelete, "1440 px, the default width");
  });

  for (const [width, height, bars] of [[1024, 640, ["minimized", "expanded"]], [800, 600, [null]]] as [number, number, ("minimized" | "expanded" | null)[]][]) {
    for (const bar of bars) {
      await test.step(`${width} px${bar ? `, sidebar ${bar}` : ""}`, async () => {
        await page.setViewportSize({ width, height });
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
        await openTree(page, plant, { width: null }); // the sidebar reads the window once, when the page loads
        if (bar) await sidebar(page, bar);
        else await columnStill(page);
        await checkBar(page, plant, hasDelete, `${width} px${bar ? `, sidebar ${bar}` : ""}`);
      });
    }
  }
}

test.describe("W7s: the pick bar at every width", () => {
  test("the admin's bar is two lines at 275 px of room or less and one line above it, whole and the same height before and after a pick", async ({ page }) => {
    test.setTimeout(240_000);
    const plant = await makePlant(page.request, "c8", [{ key: "Rack 1", sort: 10 }, { key: "Rack 2", sort: 20 }]);
    await runWidths(page, plant, true);
  });

  test("the bar of a role without Delete stays one 32 px line at every width, with Move to... and Clear whole", async ({ page, browser }) => {
    test.setTimeout(240_000);
    const plant = await makePlant(page.request, "c8e", [{ key: "Rack 1", sort: 10 }, { key: "Rack 2", sort: 20 }]);
    await makeEditor(browser);
    await signInAs(page, EDITOR);
    await runWidths(page, plant, false);
  });
});
