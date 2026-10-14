import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { treeLink } from "./shell";

// W7p (moving assets in the Assets Tree: pick with Ctrl/Cmd and Shift, drag onto a row, Move to..., a warning only when a rate changes, Undo, audit
// rows in names) on the state the earlier projects leave behind: admin `admin` / `correct-horse`. Everything the spec makes carries the digits-only run
// suffix: assets start `W7p <run>` (one root per case, `W7p <run> <case>`, with the case's halls and racks under it), the account and the role start
// `w7p-`. Each case builds its OWN small plant through the API before the page is opened (the cases mutate the tree, so none may depend on another),
// afterEach removes the plant, and beforeAll/afterAll sweep what a stopped run left (assets by name, the account and the role, then the tariffs go with
// their assets). The admin signs in through the API: the sign-in page is not what is tested here.
//
// Dragging. The tree uses native HTML5 drag and drop, so the cases drive it with `page.mouse` (move to the source, down, move to the target in steps, one
// more 1 px move on the same row, up) and not with `locator.dragTo`: `dragTo` takes no modifier keys (case 1 holds Ctrl at the drop through
// `keyboard.down("Control")`, which the mouse events pick up) and cannot stop in the middle (case 4 reads the invalid mark WHILE the pointer is over the
// row). The mouse path is the one W7p's own Chromium trace used (the second small move is the dragover a real drag would repeat every 50 ms; the marker
// and the drop do not depend on it). A zone is a height on the target row: 10% = before, 50% = inside, 90% = after (the row is `.node`, which is what
// the tree measures; the bottom quarter of an OPEN row with children means "first child", so no case aims there). Every case recentres its plant first
// (the shared tree holds every earlier project's assets, and Chromium's native drag autoscroll starts near the scroll box's edge).
//
// The cases (independent; workers is 1, so they still run in file order):
//   1  Ctrl-click two racks of different halls and drag one onto a third place, Ctrl still held at the drop: both arrive, each with its subtree.
//   2  Shift-click picks the visible rows between the anchor and the clicked row (a folded branch is skipped, a later Shift-click replaces the range,
//      Shift upwards works); a plain click opens an asset and clears the picks.
//   3  A parent picked with its child moves alone; the child stays inside it, and the audit log has one row.
//   4  A drop onto an own descendant is refused: the mark `data-drop="invalid"`, the reason in the title and the live line; nothing changes.
//   5  Move to... from the keyboard: focus a row, M, type in "Search places", Tab and the arrow to a place, Tab to Move, Enter; the focus lands on the
//      moved asset's link.
//   6  The warning only when the effective rate changes: a drag that changes it asks (both rates, "Move anyway"), Cancel moves nothing; a reorder, a
//      move between two places with the same rate and a pump with its own rate never ask; the Move to... dialog warns inside itself.
//   7  Undo puts parents AND sibling order back (two picks that are not neighbours, then a reorder).
//   8  The audit log reads the rows in names ("Moved ... from ... to ... together with 1 other") and the audit drawer says the same.
//   9  A viewer sees no picking, no draggable rows and no M key, and the API answers 403 on both routes.
//   10 Layout at 1440 and 1024 px (the sidebar minimised and expanded): the tree title, rows that do not move on the first pick, no sideways scroll.
//
// Locators. The tree is the region "Asset tree"; a row is its `.node` found by its own link (the name is unique per run); the Selection slot is the
// group "Selection". Playwright matches names by case-insensitive SUBSTRING: every button and dialog name below is `exact: true` ("Move" is also the start
// of "Move to..." and "Move anyway"; "Undo" and "Clear" have the dashboard editor's twins).

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse" };
const RUN = Date.now().toString();
const PREFIX = `W7p ${RUN}`;

const VIEWER_ROLE = "w7p-viewer-role"; // See the Assets Tree and nothing else
const VIEWER = { username: "w7p-viewer", password: "w7p-viewer-pass", role: VIEWER_ROLE };
/** Every fixture rate starts on the same past day: the preview compares the rates on EVERY effective_from, so a later start of one row would change the answer for the days before it. */
const THE_PAST = "2020-01-01";
const TOP = "(top)";
const ROOT = "(root)";

interface ApiAsset { id: number; parent_id: number | null; name: string; sort_order: number }
interface ApiUser { id: number; username: string }
interface ApiRole { id: number; name: string; builtin: boolean }
interface ApiAuditEntry { id: number; action: string; detail: Record<string, unknown> }
interface MoveAnswer { request_id: string; moved: { id: number }[] }

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The assets this run made (the prefix alone would also catch an earlier run's leftovers, which beforeAll removes). */
const mine = (name: string) => name === PREFIX || name.startsWith(`${PREFIX} `);
const anyRun = (name: string) => /^W7p \d+( |$)/.test(name);

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

/** Every account whose name starts with w7p-, then every custom role that does (a role an account holds cannot be deleted). */
async function removeAccounts(request: APIRequestContext): Promise<void> {
  for (const user of (await json<ApiUser[]>(request, "/api/users")).filter((u) => u.username.startsWith("w7p-"))) {
    const gone = await request.delete(`/api/users/${user.id}`);
    expect([204, 404], `deleting ${user.username}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
  for (const role of (await json<ApiRole[]>(request, "/api/roles")).filter((r) => !r.builtin && r.name.toLowerCase().startsWith("w7p-"))) {
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

// ---------------------------------------------------------------------------------------------------------------------------------
// The plants: one small tree per case, made through the API

interface NodeDef {
  key: string;
  /** The parent's key; left out = directly under the plant's root. */
  parent?: string;
  sort?: number;
  /** A tariff of its own from THE_PAST. */
  rate?: number;
}
interface Plant {
  /** The asset id of every key; "" is the plant's root. */
  id: Record<string, number>;
  /** The key near the middle of the plant: the row the page is scrolled to, so every source and target is on screen together. */
  middle: string;
  name(key: string): string;
}

const plants: Plant[] = [];

async function makePlant(request: APIRequestContext, label: string, middle: string, nodes: NodeDef[]): Promise<Plant> {
  const id: Record<string, number> = {};
  const nameOf = (key: string) => (key === "" ? `${PREFIX} ${label}` : `${PREFIX} ${label} ${key}`);
  const plant: Plant = { id, middle, name: nameOf };
  plants.push(plant);
  const create = async (key: string, parent: string | null, sort: number) => {
    const made = await request.post("/api/assets", {
      data: { name: nameOf(key), parent_id: parent === null ? null : id[parent], kind: "generic", sort_order: sort },
    });
    expect(made.status(), `creating ${nameOf(key)}: ${await made.text()}`).toBe(201);
    id[key] = ((await made.json()) as { id: number }).id;
  };
  await create("", null, 0);
  for (const node of nodes) {
    await create(node.key, node.parent ?? "", node.sort ?? 0);
    if (node.rate !== undefined) {
      const rate = await request.post("/api/tariffs", { data: { asset_id: id[node.key], rate_per_kwh: node.rate, effective_from: THE_PAST } });
      expect(rate.status(), `the rate of ${node.key}: ${await rate.text()}`).toBe(201);
    }
  }
  return plant;
}

/** Two halls with a rack each (the first with a pump below it), a spare rack, and an empty third place. */
const STD: NodeDef[] = [
  { key: "Hall A" },
  { key: "Rack A1", parent: "Hall A" },
  { key: "Pump A1", parent: "Rack A1" },
  { key: "Rack A2", parent: "Hall A" },
  { key: "Hall B" },
  { key: "Rack B1", parent: "Hall B" },
  { key: "Pump B1", parent: "Rack B1" },
  { key: "Row C" },
];
const STD_SHAPE: Record<string, string> = {
  "Hall A": ROOT, "Rack A1": "Hall A", "Pump A1": "Rack A1", "Rack A2": "Hall A",
  "Hall B": ROOT, "Rack B1": "Hall B", "Pump B1": "Rack B1", "Row C": ROOT,
};

/** Hall A bills 0.111, Hall B 0.222, a pump under Hall A 0.333 of its own; Plant D and Plant E have no rate. */
const RATES: NodeDef[] = [
  { key: "Hall A", rate: 0.111 },
  { key: "Rack A1", parent: "Hall A" },
  { key: "Pump A1", parent: "Rack A1", rate: 0.333 },
  { key: "Rack A2", parent: "Hall A" },
  { key: "Hall B", rate: 0.222 },
  { key: "Rack B1", parent: "Hall B" },
  { key: "Plant D" },
  { key: "Rack D1", parent: "Plant D" },
  { key: "Plant E" },
];
const RATES_SHAPE: Record<string, string> = {
  "Hall A": ROOT, "Rack A1": "Hall A", "Pump A1": "Rack A1", "Rack A2": "Hall A",
  "Hall B": ROOT, "Rack B1": "Hall B", "Plant D": ROOT, "Rack D1": "Plant D", "Plant E": ROOT,
};

/** Where every key of the plant stands, as its parent's KEY ("(root)" = under the plant's root, "(top)" = top level): the whole shape in one comparison. */
async function shapeOf(request: APIRequestContext, plant: Plant): Promise<Record<string, string>> {
  const all = await assetsOf(request);
  const keyOfId = new Map(Object.entries(plant.id).map(([key, id]) => [id, key]));
  const out: Record<string, string> = {};
  for (const [key, id] of Object.entries(plant.id)) {
    if (key === "") continue;
    const asset = all.find((a) => a.id === id);
    if (!asset) {
      out[key] = "(gone)";
    } else if (asset.parent_id === null) {
      out[key] = TOP;
    } else {
      const parent = keyOfId.get(asset.parent_id);
      out[key] = parent === undefined ? "(outside)" : parent === "" ? ROOT : parent;
    }
  }
  return out;
}

/** The keys of the children of `parentKey` in the order the tree shows them: (sort_order, name, id). */
async function orderUnder(request: APIRequestContext, plant: Plant, parentKey: string): Promise<string[]> {
  const all = await assetsOf(request);
  const keyOfId = new Map(Object.entries(plant.id).map(([key, id]) => [id, key]));
  const parent = plant.id[parentKey];
  return all
    .filter((a) => a.parent_id === parent && keyOfId.has(a.id))
    .sort((x, y) => x.sort_order - y.sort_order || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0) || x.id - y.id)
    .map((a) => keyOfId.get(a.id)!);
}

async function movedEntries(request: APIRequestContext, q: string): Promise<ApiAuditEntry[]> {
  const log = await json<{ items: ApiAuditEntry[] }>(request, `/api/audit?action=asset.moved&q=${encodeURIComponent(q)}&limit=100`);
  return log.items;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The browser

interface Box { x: number; y: number; width: number; height: number }

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const tree = (page: Page) => page.getByRole("region", { name: "Asset tree" });
const slot = (page: Page) => tree(page).getByRole("group", { name: "Selection", exact: true });
/** A tree row (`div.node`, the element the tree measures and marks), found by its own link. */
const rowOf = (page: Page, name: string) => tree(page).locator(".node").filter({ has: page.getByRole("link", { name, exact: true }) });
const picked = (page: Page) => tree(page).locator(".node[data-picked]");
/** The links of a row's children, in tree order (the list that follows the row inside its `li`; folded is hidden, not removed, so the text is there). */
const kids = (page: Page, parent: string) => rowOf(page, parent).locator("xpath=./following-sibling::ul[1]/li/div/a");
const toast = (page: Page, text: string) => page.locator(".toast-stack .toast").filter({ hasText: text });
const undoOf = (page: Page, text: string) => toast(page, text).getByRole("button", { name: "Undo", exact: true });
const dialogs = (page: Page) => page.getByRole("dialog");

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
const idsOf = (plant: Plant, ...keys: string[]) => keys.map((key) => plant.id[key]).sort((a, b) => a - b);

async function expectPicked(page: Page, plant: Plant, keys: string[]): Promise<void> {
  await expect.poll(() => pickedIds(page), { message: `exactly ${keys.join(", ")} are picked` }).toEqual(idsOf(plant, ...keys));
  await expect(slot(page)).toContainText(`${keys.length} picked`);
}

/** Scrolls the row near the plant's middle to the middle of the tree, so that every row of the plant is on screen at once. */
async function centre(page: Page, plant: Plant): Promise<void> {
  await rowOf(page, plant.name(plant.middle)).evaluate((row) => row.scrollIntoView({ block: "center" }));
  await settled(page);
}

async function openTree(page: Page, plant: Plant): Promise<void> {
  await page.goto("/assets");
  await expect(treeLink(page, plant.name(""))).toBeVisible();
  await centre(page, plant);
}

type Zone = "before" | "inside" | "after";
const HEIGHT_OF: Record<Zone, number> = { before: 0.1, inside: 0.5, after: 0.9 };

interface DragOptions {
  /** Ctrl is down from before the first move to after the drop (a modifier changes nothing about a move; Windows maps Ctrl+drag to copy). */
  ctrl?: boolean;
  /** Runs with the pointer over the target and the button still down. */
  whileOver?: () => Promise<void>;
}

/** Drags a row onto a zone of another row with the mouse. The caller waits for the result (a toast, a row that moved). */
async function dragRow(page: Page, source: Locator, target: Locator, zone: Zone, options: DragOptions = {}): Promise<void> {
  // A page that is busy (a preview, a confirmation, a move or the dialog is open) makes the rows undraggable: wait for it, or the mouse would only select text.
  await expect(source, "the source row can be dragged").toHaveAttribute("draggable", "true");
  await settled(page);
  const [from, to] = [await boxOf(source, "the source row"), await boxOf(target, "the target row")];
  const start = { x: from.x + from.width * 0.5, y: from.y + from.height * 0.5 };
  const end = { x: to.x + to.width * 0.5, y: to.y + to.height * HEIGHT_OF[zone] };
  if (options.ctrl) await page.keyboard.down("Control");
  try {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    try {
      await page.mouse.move(end.x, end.y, { steps: 6 });
      await page.mouse.move(end.x + 1, end.y); // the dragover a real drag repeats; the Chromium protocol does not
      await options.whileOver?.();
    } finally {
      await page.mouse.up();
    }
  } finally {
    if (options.ctrl) await page.keyboard.up("Control");
  }
}

/** Makes sure the sidebar is the way wanted (it starts the way the first width chose, and has no resize listener) and the tree column has stopped moving. */
async function sidebar(page: Page, want: "expanded" | "minimized"): Promise<void> {
  const shell = page.locator(".shell");
  if ((await shell.getAttribute("data-sidebar")) !== want) await page.locator(".side-toggle").click();
  await expect(shell).toHaveAttribute("data-sidebar", want);
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

/** The move dialog and its parts. */
function moveDialog(page: Page, name: string) {
  const dialog = page.getByRole("dialog", { name: `Move "${name}" to...`, exact: true });
  return {
    dialog,
    search: dialog.getByRole("searchbox", { name: "Search places", exact: true }),
    radio: (place: string) => dialog.getByRole("radio", { name: place, exact: true }),
    go: dialog.getByRole("button", { name: "Move", exact: true }),
    goAnyway: dialog.getByRole("button", { name: "Move anyway", exact: true }),
    cancel: dialog.getByRole("button", { name: "Cancel", exact: true }),
    message: dialog.locator(".place-message"),
  };
}

/** What the rate warning says for one root (a currency may follow each rate; `from` and `to` are the plain numbers). */
const warning = (name: string, from: string, to: string) =>
  new RegExp(`^Moving "${escapeRe(name)}" changes its rate from ${escapeRe(from)}( \\S+)? to ${escapeRe(to)}( \\S+)? per kWh\\. Past periods are recalculated at the new place, and the totals of both branches change\\.$`);

// ---------------------------------------------------------------------------------------------------------------------------------

test.beforeAll(async ({ browser }) => {
  await asAdmin(browser, async (request) => {
    await removeAccounts(request); // an earlier run that stopped half way
    const left = (await assetsOf(request)).filter((a) => anyRun(a.name)).map((a) => a.id);
    await deleteAssets(request, left);
  });
});

test.afterEach(async ({ browser }) => {
  // The plant of the case that just ran, whatever happened to it (a tariff goes with its asset). Assets moved out of the plant are in its id list too.
  const ids = plants.splice(0).flatMap((plant) => Object.values(plant.id));
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

test.describe("W7p: picking assets", () => {
  test("Ctrl-click two racks of different halls and drag one onto a third place: both arrive there with their pumps, Ctrl still held at the drop", async ({ page }) => {
    test.setTimeout(120_000);
    const plant = await makePlant(page.request, "pick", "Hall B", STD);
    const [a1, b1, c] = [plant.name("Rack A1"), plant.name("Rack B1"), plant.name("Row C")];
    await openTree(page, plant);

    await test.step("two Ctrl-clicks pick two rows and open nothing", async () => {
      await treeLink(page, a1).click({ modifiers: ["Control"] });
      await treeLink(page, b1).click({ modifiers: ["Control"] });
      await expectPicked(page, plant, ["Rack A1", "Rack B1"]);
      await expect(page, "picking does not open an asset").toHaveURL(/\/assets$/);
    });

    await test.step("dragging one of them drags both: Row C gets two children, each with its subtree", async () => {
      await dragRow(page, rowOf(page, a1), rowOf(page, c), "inside", { ctrl: true });
      await expect(toast(page, `Moved 2 assets to ${c}`)).toBeVisible();
      expect(await shapeOf(page.request, plant)).toEqual({ ...STD_SHAPE, "Rack A1": "Row C", "Rack B1": "Row C" });
      await expect(kids(page, c)).toHaveText([a1, b1]);
      await expect(kids(page, a1)).toHaveText([plant.name("Pump A1")]);
      await expect(kids(page, b1)).toHaveText([plant.name("Pump B1")]);
      await expect(picked(page), "the picks end with the move").toHaveCount(0);
    });
  });

  test("Shift-click picks the visible rows between the anchor and the clicked row; a folded branch is skipped; a plain click opens an asset and clears the picks", async ({ page }) => {
    test.setTimeout(120_000);
    const plant = await makePlant(page.request, "range", "Hall B", STD);
    const [hallA, hallB, a1] = [plant.name("Hall A"), plant.name("Hall B"), plant.name("Rack A1")];
    await openTree(page, plant);
    const twisty = (name: string) => rowOf(page, name).getByRole("button", { name: `Children of ${name}`, exact: true });

    await test.step("fold Hall B, anchor on Rack A1, Shift-click Hall B: the four rows between, and not the two hidden under Hall B", async () => {
      await twisty(hallB).click();
      await expect(treeLink(page, plant.name("Rack B1"))).toBeHidden();
      await treeLink(page, a1).click({ modifiers: ["Control"] });
      await treeLink(page, hallB).click({ modifiers: ["Shift"] });
      await expectPicked(page, plant, ["Rack A1", "Pump A1", "Rack A2", "Hall B"]);
      await expect(page, "a Shift-click opens nothing").toHaveURL(/\/assets$/);
    });

    await test.step("a second Shift-click replaces the range, from the same anchor", async () => {
      await treeLink(page, plant.name("Rack A2")).click({ modifiers: ["Shift"] });
      await expectPicked(page, plant, ["Rack A1", "Pump A1", "Rack A2"]);
    });

    await test.step("a Shift-click above the anchor picks upwards", async () => {
      await treeLink(page, hallA).click({ modifiers: ["Shift"] });
      await expectPicked(page, plant, ["Hall A", "Rack A1"]);
    });

    await test.step("unfolding Hall B shows its rows unpicked", async () => {
      await twisty(hallB).click();
      await expect(treeLink(page, plant.name("Rack B1"))).toBeVisible();
      await expectPicked(page, plant, ["Hall A", "Rack A1"]);
    });

    await test.step("a plain click on a row opens its asset and clears the picks", async () => {
      await treeLink(page, plant.name("Row C")).click();
      await expect(page).toHaveURL(new RegExp(`/assets/${plant.id["Row C"]}$`));
      await expect(picked(page)).toHaveCount(0);
      await expect(slot(page)).toContainText("Ctrl-click to pick several");
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7p: moving assets", () => {
  test("a parent picked together with its child moves alone: the child stays inside it, and the audit log has one row", async ({ page }) => {
    test.setTimeout(120_000);
    const plant = await makePlant(page.request, "alone", "Hall B", STD);
    const [a1, pump, c] = [plant.name("Rack A1"), plant.name("Pump A1"), plant.name("Row C")];
    await openTree(page, plant);

    await treeLink(page, a1).click({ modifiers: ["Control"] });
    await treeLink(page, pump).click({ modifiers: ["Control"] });
    await expectPicked(page, plant, ["Rack A1", "Pump A1"]);
    await dragRow(page, rowOf(page, a1), rowOf(page, c), "inside");

    await expect(toast(page, `Moved ${a1} to ${c}`), "one asset moved, not two").toBeVisible();
    expect(await shapeOf(page.request, plant)).toEqual({ ...STD_SHAPE, "Rack A1": "Row C" });
    await expect(kids(page, a1)).toHaveText([pump]);
    const rows = await movedEntries(page.request, `${PREFIX} alone`);
    expect(rows.map((row) => row.detail.name), "one audit row, for the parent").toEqual([a1]);
    expect(rows[0].detail.moved_with, "nothing else moved with it").toBe(0);
  });

  test("a drop onto an own descendant is refused: the mark, the reason in the title and the live line, and nothing changes", async ({ page }) => {
    test.setTimeout(120_000);
    const plant = await makePlant(page.request, "descendant", "Hall B", STD);
    const [hallA, pump] = [plant.name("Hall A"), plant.name("Pump A1")];
    await openTree(page, plant);
    const reason = `"${hallA}" cannot be moved into "${pump}", which is inside it.`;

    await dragRow(page, rowOf(page, hallA), rowOf(page, pump), "inside", {
      whileOver: async () => {
        await expect(rowOf(page, pump)).toHaveAttribute("data-drop", "invalid");
        await expect(rowOf(page, pump), "the reason is the row's title").toHaveAttribute("title", reason);
        await expect(tree(page).locator('div.sr-only[aria-live="polite"]'), "and the tree's live line").toHaveText(reason);
      },
    });

    await expect(rowOf(page, pump), "the mark is gone once the drag is over").not.toHaveAttribute("data-drop", /.*/);
    await page.waitForTimeout(400); // a move that should not happen would show its toast by now
    await expect(page.locator(".toast-stack .toast")).toHaveCount(0);
    expect(await shapeOf(page.request, plant)).toEqual(STD_SHAPE);
  });

  test("Move to... from the keyboard: M on a row, type, Tab and the arrow key to a place, Tab to Move, Enter; the focus lands on the moved asset", async ({ page }) => {
    test.setTimeout(120_000);
    const plant = await makePlant(page.request, "keys", "Hall B", STD);
    const [a2, c] = [plant.name("Rack A2"), plant.name("Row C")];
    await openTree(page, plant);
    const form = moveDialog(page, a2);

    await treeLink(page, a2).focus();
    await page.keyboard.press("M");
    await expect(form.dialog).toBeVisible();
    await expect(form.search, "the first focus is the search box").toBeFocused();

    await page.keyboard.type(c);
    await expect(form.dialog.getByRole("radio"), "Top level and the one place that matches").toHaveCount(2);
    await page.keyboard.press("Tab");
    await expect(form.radio("Top level")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(form.radio(c)).toBeChecked();

    // Tab to the Move button (the Cancel button comes first), without counting the presses.
    for (let i = 0; i < 4 && !(await form.go.evaluate((button) => button === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(form.go).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(form.dialog).toBeHidden();
    await expect(toast(page, `Moved ${a2} to ${c}`)).toBeVisible();
    expect(await shapeOf(page.request, plant)).toEqual({ ...STD_SHAPE, "Rack A2": "Row C" });
    await expect(treeLink(page, a2), "the focus is on the moved asset's link").toBeFocused();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7p: the rate warning", () => {
  test("a drag that changes the rate asks first with both rates; Cancel moves nothing, Move anyway moves", async ({ page }) => {
    test.setTimeout(120_000);
    const plant = await makePlant(page.request, "warn", "Hall B", RATES);
    const [a2, hallB] = [plant.name("Rack A2"), plant.name("Hall B")];
    await openTree(page, plant);
    const ask = page.getByRole("dialog", { name: "This changes the rate", exact: true });

    await test.step("the drag opens the confirmation with the two rates, and Cancel moves nothing", async () => {
      await dragRow(page, rowOf(page, a2), rowOf(page, hallB), "inside");
      await expect(ask).toBeVisible();
      await expect(ask.locator(".confirm-body")).toHaveText(warning(a2, "0.111", "0.222"));
      await ask.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(ask).toBeHidden();
      await page.waitForTimeout(400);
      await expect(page.locator(".toast-stack .toast"), "nothing was moved, so there is no toast").toHaveCount(0);
      expect(await shapeOf(page.request, plant)).toEqual(RATES_SHAPE);
    });

    await test.step("the same drag again, and Move anyway", async () => {
      await dragRow(page, rowOf(page, a2), rowOf(page, hallB), "inside");
      await expect(ask).toBeVisible();
      await ask.getByRole("button", { name: "Move anyway", exact: true }).click();
      await expect(ask).toBeHidden();
      await expect(toast(page, `Moved ${a2} to ${hallB}`)).toBeVisible();
      expect(await shapeOf(page.request, plant)).toEqual({ ...RATES_SHAPE, "Rack A2": "Hall B" });
    });
  });

  test("a reorder, a move between two places with the same rate and a pump with a rate of its own never ask", async ({ page }) => {
    test.setTimeout(150_000);
    const plant = await makePlant(page.request, "same", "Hall B", RATES);
    const [hallA, a1, a2, pump, hallB] = [plant.name("Hall A"), plant.name("Rack A1"), plant.name("Rack A2"), plant.name("Pump A1"), plant.name("Hall B")];
    const [d1, plantE] = [plant.name("Rack D1"), plant.name("Plant E")];
    await openTree(page, plant);

    await test.step("Rack A2 before Rack A1 inside Hall A: a reorder", async () => {
      await dragRow(page, rowOf(page, a2), rowOf(page, a1), "before");
      await expect(toast(page, `Reordered ${a2}`)).toBeVisible();
      await expect(dialogs(page), "no confirmation: nothing was asked").toHaveCount(0);
      await expect(kids(page, hallA)).toHaveText([a2, a1]);
      expect(await orderUnder(page.request, plant, "Hall A")).toEqual(["Rack A2", "Rack A1"]);
    });

    await test.step("a rack from Plant D to Plant E: neither has a rate, so the rate cannot change", async () => {
      await dragRow(page, rowOf(page, d1), rowOf(page, plantE), "inside");
      await expect(toast(page, `Moved ${d1} to ${plantE}`)).toBeVisible();
      await expect(dialogs(page)).toHaveCount(0);
      await expect(kids(page, plantE)).toHaveText([d1]);
    });

    await test.step("a pump with its own rate from Hall A's rack to Hall B (0.111 to 0.222 above it): its rate stays 0.333", async () => {
      await dragRow(page, rowOf(page, pump), rowOf(page, hallB), "inside");
      await expect(toast(page, `Moved ${pump} to ${hallB}`)).toBeVisible();
      await expect(dialogs(page)).toHaveCount(0);
      expect(await shapeOf(page.request, plant)).toEqual({ ...RATES_SHAPE, "Rack D1": "Plant E", "Pump A1": "Hall B" });
    });
  });

  test("Move to... warns inside its own dialog: Move anyway after the warning, Cancel moves nothing", async ({ page }) => {
    test.setTimeout(120_000);
    const plant = await makePlant(page.request, "dialog", "Hall B", RATES);
    const [b1, hallA] = [plant.name("Rack B1"), plant.name("Hall A")];
    await openTree(page, plant);
    const form = moveDialog(page, b1);
    const asked = async () => {
      await treeLink(page, b1).focus();
      await page.keyboard.press("M");
      await expect(form.dialog).toBeVisible();
      await form.search.fill(hallA);
      await form.radio(hallA).check();
      await form.go.click();
      await expect(form.goAnyway, "the button now asks again").toBeVisible();
      await expect(form.message).toHaveText(warning(b1, "0.222", "0.111"));
      expect(await shapeOf(page.request, plant), "the warning moved nothing").toEqual(RATES_SHAPE);
    };

    await test.step("the warning, then Cancel", async () => {
      await asked();
      await form.cancel.click();
      await expect(form.dialog).toBeHidden();
      expect(await shapeOf(page.request, plant)).toEqual(RATES_SHAPE);
      await expect(page.locator(".toast-stack .toast")).toHaveCount(0);
    });

    await test.step("the warning again, then Move anyway", async () => {
      await asked();
      await form.goAnyway.click();
      await expect(form.dialog).toBeHidden();
      await expect(toast(page, `Moved ${b1} to ${hallA}`)).toBeVisible();
      expect(await shapeOf(page.request, plant)).toEqual({ ...RATES_SHAPE, "Rack B1": "Hall A" });
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7p: Undo and the audit log", () => {
  test("Undo puts the parents and the sibling order back: two picks that are not neighbours, then a reorder", async ({ page }) => {
    test.setTimeout(150_000);
    // Hall A's racks are numbered 10, 20, 30, 40 and so NOT in the order of their names (Q, B, M, C): a name sort would fake the result.
    const plant = await makePlant(page.request, "undo", "Hall A", [
      { key: "Hall A" },
      { key: "Rack Q", parent: "Hall A", sort: 10 },
      { key: "Rack B", parent: "Hall A", sort: 20 },
      { key: "Rack M", parent: "Hall A", sort: 30 },
      { key: "Rack C", parent: "Hall A", sort: 40 },
      { key: "Hall B" },
    ]);
    const [hallA, hallB] = [plant.name("Hall A"), plant.name("Hall B")];
    const [q, b, m, c] = [plant.name("Rack Q"), plant.name("Rack B"), plant.name("Rack M"), plant.name("Rack C")];
    await openTree(page, plant);
    await expect(kids(page, hallA)).toHaveText([q, b, m, c]);

    await test.step("Rack B and Rack C (Rack M between them) go to Hall B", async () => {
      await treeLink(page, b).click({ modifiers: ["Control"] });
      await treeLink(page, c).click({ modifiers: ["Control"] });
      await expectPicked(page, plant, ["Rack B", "Rack C"]);
      await dragRow(page, rowOf(page, b), rowOf(page, hallB), "inside");
      await expect(toast(page, `Moved 2 assets to ${hallB}`)).toBeVisible();
      await expect(kids(page, hallA)).toHaveText([q, m]);
      await expect(kids(page, hallB)).toHaveText([b, c]);
    });

    await test.step("Undo: both come back, to their places between the racks that stayed", async () => {
      await undoOf(page, `Moved 2 assets to ${hallB}`).click();
      await expect(toast(page, "Undone")).toBeVisible();
      await expect(kids(page, hallA)).toHaveText([q, b, m, c]);
      await expect(kids(page, hallB)).toHaveCount(0);
      expect(await orderUnder(page.request, plant, "Hall A")).toEqual(["Rack Q", "Rack B", "Rack M", "Rack C"]);
      expect((await shapeOf(page.request, plant))["Rack B"]).toBe("Hall A");
    });

    await test.step("a reorder (Rack C after Rack Q) and its Undo", async () => {
      await dragRow(page, rowOf(page, c), rowOf(page, q), "after");
      await expect(toast(page, `Reordered ${c}`)).toBeVisible();
      await expect(kids(page, hallA)).toHaveText([q, c, b, m]);
      await undoOf(page, `Reordered ${c}`).click();
      await expect(kids(page, hallA)).toHaveText([q, b, m, c]);
      expect(await orderUnder(page.request, plant, "Hall A")).toEqual(["Rack Q", "Rack B", "Rack M", "Rack C"]);
    });
  });

  test("the audit log reads the moves in names, and the audit drawer says the same with the others that moved along", async ({ page }) => {
    test.setTimeout(150_000);
    const plant = await makePlant(page.request, "audit", "Hall B", [
      { key: "Hall A" },
      { key: "Rack A1", parent: "Hall A" },
      { key: "Rack A2", parent: "Hall A" },
      { key: "Rack A3", parent: "Hall A" },
      { key: "Rack A4", parent: "Hall A" },
      { key: "Hall B" },
      { key: "Rack B1", parent: "Hall B" },
      { key: "Row C" },
    ]);
    const n = (key: string) => plant.name(key);
    const move = async (moves: { ids: number[]; parent_id: number | null; before_id: number | null }[]) => {
      const made = await page.request.post("/api/assets/move", { data: { moves } });
      expect(made.status(), `moving: ${await made.text()}`).toBe(200);
      return (await made.json()) as MoveAnswer;
    };
    // The drags are the other cases' business: here the API makes three requests, one with two roots, one to the top level, one reorder.
    const together = await move([{ ids: [plant.id["Rack A1"], plant.id["Rack B1"]], parent_id: plant.id["Row C"], before_id: null }]);
    await move([{ ids: [plant.id["Rack A2"]], parent_id: null, before_id: null }]);
    await move([{ ids: [plant.id["Rack A4"]], parent_id: plant.id["Hall A"], before_id: plant.id["Rack A3"] }]);

    const entries = await movedEntries(page.request, `${PREFIX} audit`);
    expect(entries, "one row per moved root: two, one, one").toHaveLength(4);
    const entryOf = (key: string) => {
      const found = entries.find((entry) => entry.detail.name === n(key));
      expect(found, `an asset.moved row for ${key}`).toBeDefined();
      return found!;
    };
    const sentences = [
      [entryOf("Rack A1"), `Moved ${n("Rack A1")} from ${n("Hall A")} to ${n("Row C")} together with 1 other`],
      [entryOf("Rack B1"), `Moved ${n("Rack B1")} from ${n("Hall B")} to ${n("Row C")} together with 1 other`],
      [entryOf("Rack A2"), `Moved ${n("Rack A2")} to the top level`],
      [entryOf("Rack A4"), `Reordered ${n("Rack A4")} within ${n("Hall A")}`],
    ] as const;
    expect(entryOf("Rack A1").detail.request_id, "the two roots of one gesture share a request id").toBe(together.request_id);
    expect(entryOf("Rack B1").detail.request_id).toBe(together.request_id);

    await page.goto(`/audit?action=asset.moved&q=${encodeURIComponent(`${PREFIX} audit`)}`);
    await expect(heading1(page, "Audit log")).toBeVisible();
    const row = (id: number) => page.locator(`.audit-table tr[data-entry-id="${id}"]`);

    await test.step("every row reads in names, with no id", async () => {
      for (const [entry, sentence] of sentences) {
        await expect(row(entry.id).locator(".what"), sentence).toHaveText(sentence);
        await expect(row(entry.id).locator("td.cell-what")).not.toContainText("#");
      }
    });

    await test.step("the drawer of a grouped row says the same, shows what changed, and keeps the shared request id in its details", async () => {
      const first = entryOf("Rack A1");
      await row(first.id).getByRole("button", { name: `Details of entry #${first.id}`, exact: true }).click();
      const drawer = page.getByRole("dialog", { name: "Audit entry", exact: true });
      await expect(drawer).toBeVisible();
      await expect(drawer.locator("dd .what")).toHaveText(sentences[0][1]);
      await expect(drawer.getByRole("heading", { name: "What changed", level: 3, exact: true })).toBeVisible();
      await expect(drawer).toContainText(n("Hall A"));
      await expect(drawer.locator("pre.entry-json")).toContainText(`"request_id": "${together.request_id}"`);
      await expect(drawer.locator("pre.entry-json")).toContainText('"moved_with": 1');
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7p: who may move, and the layout", () => {
  test("a viewer sees no picking and no draggable rows, M does nothing, and the API answers 403 on both routes", async ({ page, browser }) => {
    test.setTimeout(150_000);
    await asAdmin(browser, async (request) => {
      await removeAccounts(request);
      const role = await request.post("/api/roles", { data: { name: VIEWER_ROLE, description: "made by w7p.spec.ts", permissions: ["assets.view"] } });
      expect(role.status(), `creating the role: ${await role.text()}`).toBe(201);
      const user = await request.post("/api/users", { data: { username: VIEWER.username, password: VIEWER.password, role: VIEWER.role } });
      expect(user.status(), `creating the account: ${await user.text()}`).toBe(201);
    });
    const plant = await makePlant(page.request, "viewer", "Hall B", STD);
    const a1 = plant.name("Rack A1");
    await signInAs(page, VIEWER);
    await openTree(page, plant);

    await test.step("the tree is plain links: no pick handle, no draggable row, no Selection slot, no top-level area", async () => {
      await expect(treeLink(page, a1)).toBeVisible();
      await expect(tree(page).locator("[data-asset-id]")).toHaveCount(0);
      await expect(tree(page).locator(".node[draggable]")).toHaveCount(0);
      await expect(slot(page)).toHaveCount(0);
      await expect(tree(page).locator(".tree-root-drop")).toHaveCount(0);
    });

    await test.step("M and Space on a focused row do nothing", async () => {
      await treeLink(page, a1).focus();
      await page.keyboard.press("M");
      await page.keyboard.press("Space");
      await settled(page);
      await expect(dialogs(page)).toHaveCount(0);
      await expect(picked(page)).toHaveCount(0);
      await expect(page).toHaveURL(/\/assets$/);
    });

    await test.step("both routes answer 403 to a valid request and nothing moves", async () => {
      const body = { moves: [{ ids: [plant.id["Rack A1"]], parent_id: plant.id["Row C"], before_id: null }] };
      const preview = await page.request.post("/api/assets/move-preview", { data: body });
      expect(preview.status(), "move-preview as a viewer").toBe(403);
      const moved = await page.request.post("/api/assets/move", { data: body });
      expect(moved.status(), "move as a viewer").toBe(403);
      expect(await asAdmin(browser, (request) => shapeOf(request, plant))).toEqual(STD_SHAPE);
      expect(await asAdmin(browser, (request) => movedEntries(request, `${PREFIX} viewer`)), "no audit row").toEqual([]);
    });
  });

  test("layout at 1440 and 1024 px, sidebar minimised and expanded: the tree title stays, the first pick moves no row, the tree has no sideways scroll", async ({ page }) => {
    test.setTimeout(180_000);
    const plant = await makePlant(page.request, "layout", "Hall B", STD);
    const a1 = plant.name("Rack A1");
    const names = ["", "Hall A", "Rack A1", "Pump A1", "Rack A2", "Hall B", "Rack B1", "Pump B1", "Row C"].map((key) => plant.name(key));
    await openTree(page, plant);

    /** Every number that a pick must not change: the rows' tops inside the scroll box (scroll adjusted: a click may scroll it), the slot, the title. */
    const geometry = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const name of names) {
        out[`top of ${name}`] = await rowOf(page, name).evaluate((row) => {
          const scroller = row.closest(".tree-scroll")!;
          return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        });
      }
      const [column, box, title, scroll] = [
        await boxOf(tree(page), "the tree column"), await boxOf(slot(page), "the slot"),
        await boxOf(tree(page).locator(".tree-title"), "the title"), await boxOf(tree(page).locator(".tree-scroll"), "the scroll box"),
      ];
      out["slot height"] = box.height;
      out["slot top in the column"] = box.y - column.y;
      out["title width"] = title.width;
      out["scroll box height"] = scroll.height;
      return out;
    };

    const cases: [number, number, ("minimized" | "expanded")[]][] = [[1440, 900, ["expanded"]], [1024, 800, ["minimized", "expanded"]]];
    for (const [width, height, bars] of cases) {
      for (const bar of bars) {
        await test.step(`${width} px, sidebar ${bar}`, async () => {
          await page.setViewportSize({ width, height });
          await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
          await sidebar(page, bar);
          await centre(page, plant);

          // The column's own title is still there. (At 1024 px with the sidebar expanded it is cut to "Asse..." by the five tool buttons; that is older than
          // W7p and in the backlog, so it is its box and its words that are asserted, not that it fits.)
          const title = tree(page).locator(".tree-title");
          await expect(title).toBeVisible();
          await expect(title).toHaveText("Assets Tree");

          const before = await geometry();
          await treeLink(page, a1).click({ modifiers: ["Control"] });
          await expect(slot(page)).toContainText("1 picked");
          const after = await geometry();
          for (const [what, value] of Object.entries(before)) {
            expect(Math.abs(after[what] - value), `${what} moved by the first pick: ${value} to ${after[what]}`).toBeLessThanOrEqual(0.5);
          }
          expect(before["slot height"], "the slot is one fixed line, picked or not").toBe(32);

          for (const selector of [".tree-scroll", "ul.tree"]) {
            const overflow = await tree(page).locator(selector).first().evaluate((el) => el.scrollWidth - el.clientWidth);
            expect(overflow, `${selector} scrolls sideways by ${overflow} px`).toBeLessThanOrEqual(1);
          }

          await slot(page).getByRole("button", { name: "Clear", exact: true }).click(); // the next width starts from a first pick again
          await expect(picked(page)).toHaveCount(0);
          await expect(slot(page)).toContainText("Ctrl-click to pick several");
        });
      }
    }
  });
});
