import { expect, test, type APIRequestContext, type Browser, type Locator, type Page, type Route } from "@playwright/test";
import { userBlock } from "./shell";

// W7k (the Save button that turns green, the one styled delete dialog that first asks the server what goes, and toasts) on the state the
// earlier projects leave behind: admin `admin` / `correct-horse`, a source with mapped points (the first-run journey's simulator source), the
// site currency and time zone. Every thing the spec makes carries the run suffix (`W7k ... <run>`) and is removed again by name in afterAll,
// whatever happened; the admin's look is put back to Light and Navy and gold (what a re-run and the gallery expect).
//
// What it pins:
//   1. The three Save buttons that save in place (Settings General, Settings Sign-in protection, Tariffs Site currency), at 1440 px in light
//      and dark: idle -> "Saving..." (the PUT is held) -> "Saved" on the --ok colour -> back to "Save" about 3 s later, in that order, with
//      one width (+-0.5 px) in all four phases, no toast and no loose "saved" word beside the button. The values are SAVED UNCHANGED: the
//      button turns green on any successful save, and an unchanged save needs no restore (a changed currency would also open the relabel
//      confirmation, which is not this spec's business). The phases are read by a MutationObserver in the page, because the fading phase is
//      600 ms long and a polling expect would miss it.
//   2. A leaf asset: the trash opens ONE styled dialog (the browser's own box never opens), "Checking what this deletes..." while the
//      preview is held with the confirm button off, then `Delete "NAME"?` with "Delete"; Cancel keeps the asset and gives the focus back to
//      the trash; Delete sends the counts the dialog showed, removes the asset, and the toast `Asset "NAME" deleted` sits bottom right and
//      is gone within 6 s.
//   3. A branch asset (a child and a tariff): the impact sentence and "Delete anyway"; a child added through the API while the dialog is
//      open makes the first confirm answer with the new numbers (409, nothing deleted) and only the second confirm deletes.
//   4. A source: a mapped one (read only: the dialog is opened and cancelled, never confirmed) shows the sources wording; a fresh one with no
//      points shows the plain sentence and is really deleted, with its toast.
//   5. Toasts: "Asset created" after the Add asset dialog; it does not cover the profile menu; it can be dismissed; Esc inside a dialog still
//      closes the dialog while a toast shows; under reduced motion a toast still appears and leaves.
//   6. Toasts and row menus: with "Source added" showing, the open menu of the last Sources row is inside the window and nothing covers any
//      item, at 1440x900 and 1024x768; below 720 px the full-width toast keeps its 16 px margins and does not cover a dialog's Save.
//   7. The keyboard: Tab goes from Cancel to the enabled confirm button and wraps round inside the dialog in both directions; Cancel (Enter)
//      and Esc give the focus back to the button that opened it.
//
// "Asset created" and "Source added" come from the toast wiring of Task 5 (the strings are R14). Toasts are found as
// `.toast-stack .toast` (the stack has no role: a `getByRole("status")` would not find them). The dialog's buttons are looked up inside
// `getByRole("dialog", ...)` with `exact: true`: while the preview loads the confirm button is the disabled "Delete", and a row's
// trash button is named "Delete NAME" too. Only the PUT of a Save is held (a held GET would also hold the page's own first load).

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse" };
const DEFAULT_LOOK = { mode: "light", theme: "navy-gold" };

const RUN = Date.now().toString(36);
const WIDTH_TOLERANCE = 0.5; // px: the Save button is one width in all four phases
const CORNER_MAX = 40; // px: a toast is within this of the bottom and right edges (the stylesheet says 16, and it slides in from 8 px lower)

// "..." in the page's words is one character, U+2026.
const CHECKING = /Checking what this deletes…/;
const SAVING = /^Saving…$/;

/** Signs the admin in through the API: the session cookie belongs to the page's browser context. */
async function signIn(page: Page): Promise<void> {
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in: ${login.status()}`).toBe(true);
}

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

async function getJson<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}

/**
 * Keeps the answer to every `method` request for `path` back until `release()`, then lets it (and every later one) through. Other methods
 * for the path go on at once. `stop()` takes the route off the page.
 */
async function hold(page: Page, path: string, method: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  const matches = (url: URL) => url.pathname === path;
  const handler = async (route: Route) => {
    if (route.request().method() !== method) {
      await route.fallback();
      return;
    }
    requests += 1;
    await gate;
    await route.continue().catch(() => undefined); // the page may be gone by now
  };
  await page.route(matches, handler);
  return { release, requests: () => requests, stop: () => page.unroute(matches, handler) };
}

/** The browser's own confirm/alert boxes the page opens: the list must stay empty (W7k took them away everywhere). */
function watchBrowserBoxes(page: Page): string[] {
  const seen: string[] = [];
  page.on("dialog", async (dialog) => {
    seen.push(`${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss();
  });
  return seen;
}

/** Two animation frames: whatever the page does about a changed layout has happened by then. */
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

async function setWidth(page: Page, width: number, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
}

/** The size of the layout viewport (what a `position: fixed; right: 16px` is measured against; `viewportSize()` includes a scrollbar). */
const layoutSize = (page: Page) => page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }));

interface Box { x: number; y: number; width: number; height: number }
/** The box of the one element the locator finds, in the viewport. */
async function boxOf(locator: Locator, what: string): Promise<Box> {
  await expect(locator, `${what} is on the page`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  return box!;
}

/** The two boxes share some area. */
const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

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

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const heading2 = (page: Page, name: string) => page.getByRole("heading", { level: 2, name, exact: true });
const dialogNamed = (page: Page, title: string) => page.getByRole("dialog", { name: title, exact: true });
const deleteTitle = (name: string) => `Delete "${name}"?`;
const button = (scope: Page | Locator, name: string) => scope.getByRole("button", { name, exact: true });
const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The toasts of the page (the stack has no role of its own: only an error toast has one). */
const toasts = (page: Page) => page.locator(".toast-stack .toast");
const toastWith = (page: Page, text: string) => toasts(page).filter({ hasText: text });

/** The toast is in the lower right corner of the window, near the edges. */
async function expectInLowerRight(page: Page, toast: Locator, what: string): Promise<Box> {
  const box = await boxOf(toast, what);
  const { width, height } = await layoutSize(page);
  expect(box.x + box.width / 2, `${what}: its middle is in the right half of the window`).toBeGreaterThan(width / 2);
  expect(box.y + box.height / 2, `${what}: its middle is in the lower half of the window`).toBeGreaterThan(height / 2);
  const right = width - (box.x + box.width);
  const bottom = height - (box.y + box.height);
  expect(right, `${what}: the gap to the right edge (${right} px)`).toBeGreaterThanOrEqual(0);
  expect(right, `${what}: the gap to the right edge (${right} px)`).toBeLessThanOrEqual(CORNER_MAX);
  expect(bottom, `${what}: the gap to the bottom edge (${bottom} px)`).toBeGreaterThanOrEqual(0);
  expect(bottom, `${what}: the gap to the bottom edge (${bottom} px)`).toBeLessThanOrEqual(CORNER_MAX);
  return box;
}

/** A pointer parked in the top left corner: a toast that is hovered or has the pointer over it waits, and the "gone within 6 s" checks must not. */
const parkPointer = (page: Page) => page.mouse.move(2, 2);

/** The open menu lies inside the window and nothing (the toast included) covers or cuts off any of its items. */
async function expectMenuReachable(page: Page, menu: Locator): Promise<void> {
  const { width, height } = await layoutSize(page);
  await expect(async () => {
    const box = await menu.boundingBox();
    expect(box, "the open menu has a box").not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(height);
  }).toPass({ timeout: 5_000 });
  // At the middle of every item, the element that is really there is the item (or something inside it).
  const hidden = await menu.evaluate((el) =>
    Array.from(el.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .filter((item) => {
        const box = item.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return hit === null || !el.contains(hit);
      })
      .map((item) => item.textContent ?? ""),
  );
  expect(hidden, "menu items covered by something else or cut off").toEqual([]);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Things the spec makes through the API

async function makeAsset(page: Page, name: string, parentId: number | null = null): Promise<number> {
  const made = await page.request.post("/api/assets", { data: { name, parent_id: parentId, kind: "generic", sort_order: 0 } });
  expect(made.ok(), `creating the asset ${name}: ${made.status()} ${await made.text()}`).toBe(true);
  return ((await made.json()) as { id: number }).id;
}

/** A source of the simulator connector, switched off (nothing polls it) and with no points. */
async function makeSource(page: Page, name: string): Promise<number> {
  const body = { name, connector_type: "simulator", config: { url: "http://simulator:9000" }, secret: null, enabled: false };
  const made = await page.request.post("/api/sources", { data: body });
  expect(made.ok(), `creating the source ${name}: ${made.status()} ${await made.text()}`).toBe(true);
  return ((await made.json()) as { id: number }).id;
}

const assetIds = async (page: Page) => (await getJson<{ id: number }[]>(page, "/api/assets")).map((a) => a.id);
const sourceIds = async (page: Page) => (await getJson<{ id: number }[]>(page, "/api/sources")).map((s) => s.id);

/** Removes the source with this name through the API (afterAll does the same for anything left); a source made by the spec has no points. */
async function dropSourceNamed(page: Page, name: string): Promise<void> {
  const sources = await getJson<{ id: number; name: string }[]>(page, "/api/sources");
  for (const source of sources.filter((s) => s.name === name)) await page.request.delete(`/api/sources/${source.id}?confirm=true`);
}

/** Adds a source through the Add source dialog, switched off, and waits for the dialog to close. */
async function addSourceInTheDialog(page: Page, name: string): Promise<void> {
  await button(page, "Add source").click();
  const dialog = dialogNamed(page, "Add source");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  // A label that wraps a select has the options' words in its text, so an exact "Connector" would never match (w3a does the same with /^Kind/).
  await dialog.getByLabel(/^Connector/).selectOption("simulator");
  await dialog.getByLabel(/^Url/i).fill("http://simulator:9000"); // as the first-run journey does; nothing connects, the source is off
  await dialog.getByLabel(/^Enabled/).uncheck();
  await button(dialog, "Save").click();
  await expect(dialog).toBeHidden();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. The Save button

interface SaveCase {
  name: string;
  path: string;
  title: string; // the page's h1
  put: string; // the request the Save sends
  /** Found by its class, which never changes with the phase (its accessible name does: "Save", "Saving...", "Saved"). */
  save: (page: Page) => Locator;
}

const cardOf = (page: Page, area: string, title: string) => page.locator(`${area} .page-card`).filter({ has: heading2(page, title) });

const SAVE_CASES: SaveCase[] = [
  { name: "Settings, General (time zone)", path: "/settings", title: "Settings", put: "/api/settings/general", save: (page) => cardOf(page, ".settings-page", "General").locator("button.save-btn") },
  { name: "Settings, Sign-in protection", path: "/settings", title: "Settings", put: "/api/settings/sign-in", save: (page) => cardOf(page, ".settings-page", "Sign-in protection").locator("button.save-btn") },
  { name: "Tariffs, Site currency", path: "/tariffs", title: "Tariffs", put: "/api/settings/billing", save: (page) => page.getByRole("form", { name: "Site currency" }).locator("button.save-btn") },
];

/** The face of the button that is showing (the other two are aria-hidden). */
const face = (save: Locator) => save.locator(".save-face:not([aria-hidden])");

interface PhaseEntry { phase: string | null; width: number; at: number }

/** Starts writing down every `data-phase` the button has, with its width and the time, until the page goes. */
async function recordPhases(save: Locator): Promise<void> {
  await save.evaluate((el) => {
    const log: PhaseEntry[] = [];
    (window as unknown as { __w7kPhases: PhaseEntry[] }).__w7kPhases = log;
    const read = () => log.push({ phase: el.getAttribute("data-phase"), width: el.getBoundingClientRect().width, at: performance.now() });
    read();
    new MutationObserver(read).observe(el, { attributes: true, attributeFilter: ["data-phase"] });
  });
}

/** Elements near the button (its card) whose own text says "saved", other than the button and its live line. */
function looseSavedWords(save: Locator): Promise<string[]> {
  return save.evaluate((el) => {
    const scope = el.closest(".page-card") ?? el.closest("form") ?? document.body;
    const ownText = (node: Element) => Array.from(node.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join(" ");
    return Array.from(scope.querySelectorAll("*"))
      .filter((node) => !el.contains(node) && !node.classList.contains("save-live") && /\bsaved\b/i.test(ownText(node)))
      .map((node) => `${node.tagName.toLowerCase()}: ${ownText(node).trim()}`);
  });
}

async function checkOneSave(page: Page, entry: SaveCase, mode: string): Promise<void> {
  const what = `${entry.name} (${mode})`;
  await page.goto(entry.path);
  await expect(heading1(page, entry.title)).toBeVisible();
  const save = entry.save(page);
  await expect(save, `${what}: the Save button`).toBeVisible();
  await expect(page.locator(".sk-region"), `${what}: no skeleton is left`).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
  await settled(page);

  await expect(save).toHaveAttribute("data-phase", "idle");
  await expect(face(save)).toHaveText("Save");
  const idle = await boxOf(save, `${what}: the idle button`);
  const ok = await tokenColour(page, "--ok");
  const onOk = await tokenColour(page, "--bg");
  await recordPhases(save);

  const held = await hold(page, entry.put, "PUT");
  try {
    await save.click();
    await expect(save).toHaveAttribute("data-phase", "saving");
    await expect(save, `${what}: a button that is saving is off (it is the double-click guard)`).toBeDisabled();
    await expect(face(save)).toHaveText(SAVING);
    const saving = await boxOf(save, `${what}: the saving button`);
    expect(Math.abs(saving.width - idle.width), `${what}: width while saving (${saving.width}) against idle (${idle.width})`).toBeLessThanOrEqual(WIDTH_TOLERANCE);
    await expect.poll(() => held.requests(), { message: `${what}: the PUT reached the route once` }).toBe(1);
    held.release();

    await expect(save).toHaveAttribute("data-phase", "saved");
    await expect(face(save)).toHaveText("Saved");
    // The fill takes 150 ms to arrive; the button then has the --ok fill and the --bg text.
    await expect
      .poll(() => save.evaluate((el) => { const style = getComputedStyle(el); return `${style.backgroundColor}|${style.color}`; }), { timeout: 2_000, message: `${what}: the saved colours` })
      .toBe(`${ok}|${onOk}`);
    expect(await looseSavedWords(save), `${what}: a loose "saved" word beside the button`).toEqual([]);
    await expect(toasts(page), `${what}: a form that saves in place does not toast`).toHaveCount(0);

    // Back to idle by itself, in about 3 s (2.5 s green, 0.6 s fade).
    await expect(save).toHaveAttribute("data-phase", "idle", { timeout: 4_500 });
    await expect(face(save)).toHaveText("Save");
    await expect(save).toBeEnabled();
  } finally {
    await held.stop();
  }

  const log = await page.evaluate(() => (window as unknown as { __w7kPhases: PhaseEntry[] }).__w7kPhases);
  const seen = log.filter((entry, i) => i === 0 || entry.phase !== log[i - 1].phase);
  expect(seen.map((entry) => entry.phase), `${what}: the phases, in order`).toEqual(["idle", "saving", "saved", "fading", "idle"]);
  for (const entry of seen) {
    expect(Math.abs(entry.width - idle.width), `${what}: width in the ${entry.phase} phase (${entry.width}) against idle (${idle.width})`).toBeLessThanOrEqual(WIDTH_TOLERANCE);
  }
  const wasGreen = seen[4].at - seen[2].at;
  expect(wasGreen, `${what}: green then fading back took ${Math.round(wasGreen)} ms`).toBeGreaterThanOrEqual(2_000);
  expect(wasGreen, `${what}: green then fading back took ${Math.round(wasGreen)} ms`).toBeLessThanOrEqual(4_000);
}

// ---------------------------------------------------------------------------------------------------------------------------------

// Not serial: the cases are independent, and one failure must not hide the others (workers is 1, so they still run in file order).
test.describe("W7k: the Save button, the one delete dialog, toasts", () => {
  test.beforeAll(async ({ browser }) => {
    await asAdmin(browser, async (request) => {
      const saved = await request.put("/api/me/preferences", { data: DEFAULT_LOOK });
      expect(saved.ok(), `starting from the default look: ${saved.status()} ${await saved.text()}`).toBe(true);
    });
  });

  test.afterAll(async ({ browser }) => {
    await asAdmin(browser, async (request) => {
      await request.put("/api/me/preferences", { data: DEFAULT_LOOK });
      // Whatever this run made, by its suffix. Newest first; deleting a parent takes its children, so a later 404 is fine.
      const assets = (await (await request.get("/api/assets")).json()) as { id: number; name: string }[];
      for (const asset of assets.filter((a) => a.name.includes(RUN)).sort((a, b) => b.id - a.id)) {
        await request.delete(`/api/assets/${asset.id}?confirm=true`).catch(() => undefined);
      }
      const sources = (await (await request.get("/api/sources")).json()) as { id: number; name: string }[];
      for (const source of sources.filter((s) => s.name.includes(RUN))) {
        await request.delete(`/api/sources/${source.id}?confirm=true`).catch(() => undefined);
      }
    });
  });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  for (const mode of ["light", "dark"] as const) {
    test(`the Save button turns green, reads Saved and fades back with one width in all four phases (${mode}, 1440 px)`, async ({ page }) => {
      test.setTimeout(150_000);
      const stored = await page.request.put("/api/me/preferences", { data: { mode, theme: "navy-gold" } });
      expect(stored.ok(), `storing the ${mode} look: ${stored.status()}`).toBe(true);
      await setWidth(page, 1440);
      for (const entry of SAVE_CASES) {
        await test.step(`${entry.name}`, () => checkOneSave(page, entry, mode));
      }
    });
  }

  // -------------------------------------------------------------------------------------------------------------------------------
  test("a leaf asset: the trash opens ONE styled dialog that checks first, Cancel keeps it, Delete removes it and a toast confirms", async ({ page }) => {
    test.setTimeout(120_000);
    const name = `W7k leaf ${RUN}`;
    const id = await makeAsset(page, name);
    const boxes = watchBrowserBoxes(page);
    const held = await hold(page, `/api/assets/${id}/impact`, "GET");

    await page.goto(`/assets/${id}`);
    await expect(heading1(page, name)).toBeVisible();
    const trash = button(page, `Delete ${name}`);
    await trash.click();

    const dialog = dialogNamed(page, deleteTitle(name));
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("dialog"), "exactly one dialog").toHaveCount(1);
    await expect(dialog).toContainText(CHECKING);
    // While the preview is held nothing can be confirmed: the confirm button is the disabled "Delete" ("anyway" is for a branch, once known).
    await expect(button(dialog, "Delete")).toBeDisabled();
    await expect(button(dialog, "Delete anyway")).toHaveCount(0);
    await expect(button(dialog, "Cancel")).toBeFocused();
    await expect.poll(() => held.requests(), { message: "the preview was asked for once" }).toBe(1);
    held.release();

    const confirm = button(dialog, "Delete");
    await expect(confirm).toBeEnabled();
    await expect(dialog).toContainText("This can't be undone.");
    await expect(dialog).not.toContainText(CHECKING);
    await expect(button(dialog, "Delete anyway")).toHaveCount(0);

    await button(dialog, "Cancel").click();
    await expect(dialog).toBeHidden();
    await expect(trash, "the focus goes back to the trash button").toBeFocused();
    expect(await assetIds(page), "Cancel keeps the asset").toContain(id);

    // Opened again, the preview is asked for again (it is never cached between two openings).
    await trash.click();
    await expect(confirm).toBeEnabled();
    expect(held.requests(), "a second opening asks the server again").toBe(2);
    const deleting = page.waitForRequest((r) => r.method() === "DELETE" && new URL(r.url()).pathname === `/api/assets/${id}`);
    await confirm.click();
    const query = Object.fromEntries(new URL((await deleting).url()).searchParams);
    expect(query, "the delete carries the counts the dialog showed").toEqual({ confirm: "true", expect_assets: "1", expect_mappings: "0", expect_tariffs: "0" });

    const toast = toastWith(page, `Asset "${name}" deleted`);
    await expect(toast).toBeVisible();
    await expectInLowerRight(page, toast, "the delete toast");
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/assets$/);
    expect(await assetIds(page), "the asset is gone").not.toContain(id);
    await parkPointer(page);
    await expect(toast, "a success toast goes away by itself").toBeHidden({ timeout: 6_000 });
    expect(boxes, "the browser's own confirm box never opened").toEqual([]);
    await held.stop();
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  test("a branch asset: the impact sentence, and a child added while the dialog is open is refused until the new numbers are confirmed", async ({ page }) => {
    test.setTimeout(120_000);
    const name = `W7k branch ${RUN}`;
    const parent = await makeAsset(page, name);
    const child = await makeAsset(page, `W7k child ${RUN}`, parent);
    const rate = await page.request.post("/api/tariffs", { data: { asset_id: parent, rate_per_kwh: 0.2, effective_from: "2020-01-01" } });
    expect(rate.ok(), `a rate for the branch: ${rate.status()} ${await rate.text()}`).toBe(true);
    const boxes = watchBrowserBoxes(page);

    await page.goto(`/assets/${parent}`);
    await expect(heading1(page, name)).toBeVisible();
    await button(page, `Delete ${name}`).click();

    const dialog = dialogNamed(page, deleteTitle(name));
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("2 assets, 0 mappings and 1 tariff will be deleted");
    const confirm = button(dialog, "Delete anyway");
    await expect(confirm).toBeEnabled();
    await expect(button(dialog, "Delete"), "a branch has no plain Delete").toHaveCount(0);

    // Somebody adds a child while the dialog is open.
    const second = await makeAsset(page, `W7k second child ${RUN}`, parent);

    const [refused] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "DELETE" && new URL(r.url()).pathname === `/api/assets/${parent}`),
      confirm.click(),
    ]);
    expect(refused.status(), "the server refuses to delete more than the dialog showed").toBe(409);
    expect(await refused.json()).toMatchObject({ assets: 3, mappings: 0, tariffs: 1 });
    await expect(dialog, "the dialog stays open").toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText("More was added while this was open");
    await expect(dialog).toContainText("3 assets, 0 mappings and 1 tariff will be deleted");
    const still = await assetIds(page);
    expect([parent, child, second].filter((id) => !still.includes(id)), "nothing was deleted by the refused request").toEqual([]);

    const [gone] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "DELETE" && new URL(r.url()).pathname === `/api/assets/${parent}`),
      confirm.click(),
    ]);
    expect(gone.status()).toBe(204);
    expect(new URL(gone.url()).searchParams.get("expect_assets"), "the second confirm carries the new numbers").toBe("3");
    await expect(toastWith(page, `Asset "${name}" deleted`)).toBeVisible();
    await expect(dialog).toBeHidden();
    const left = await assetIds(page);
    expect([parent, child, second].filter((id) => left.includes(id)), "the branch and both children are gone").toEqual([]);
    const tariffs = await getJson<{ asset_id: number | null }[]>(page, "/api/tariffs");
    expect(tariffs.filter((t) => t.asset_id === parent), "its rate went with it").toEqual([]);
    expect(boxes, "the browser's own confirm box never opened").toEqual([]);
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  test("a source: the preview of a mapped source (read only), and a fresh source with no points is deleted with its toast", async ({ page }) => {
    test.setTimeout(120_000);
    const boxes = watchBrowserBoxes(page);

    // A mapped source is only looked at: Cancel, never Delete anyway.
    const all = await getJson<{ id: number; name: string; mapped_points: number }[]>(page, "/api/sources");
    const mapped = all.find((s) => s.mapped_points > 0);
    expect(mapped, "a source with a mapped point (the simulator source of the first-run journey)").toBeDefined();
    const impact = await getJson<{ points: number; mappings: number }>(page, `/api/sources/${mapped!.id}/impact`);
    expect(impact.points, "the preview counts the mapped points").toBeGreaterThan(0);

    await page.goto("/sources");
    await expect(heading1(page, "Sources")).toBeVisible();
    await button(page, `Delete ${mapped!.name}`).click();
    const asked = dialogNamed(page, `Delete source "${mapped!.name}"?`);
    await expect(asked).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(asked).toContainText(`${counted(impact.points, "mapped point")} and ${counted(impact.mappings, "mapping")} will be deleted`);
    await expect(button(asked, "Delete anyway")).toBeEnabled();
    await expect(button(asked, "Delete"), "a source with mapped points has no plain Delete").toHaveCount(0);
    await button(asked, "Cancel").click();
    await expect(asked).toBeHidden();
    expect(await sourceIds(page), "Cancel keeps the mapped source").toContain(mapped!.id);

    // A fresh source with no points: the plain sentence, then a real delete.
    const name = `W7k source ${RUN}`;
    const id = await makeSource(page, name);
    const held = await hold(page, `/api/sources/${id}/impact`, "GET");
    await page.goto("/sources");
    await expect(heading1(page, "Sources")).toBeVisible();
    await button(page, `Delete ${name}`).click();
    const plain = dialogNamed(page, `Delete source "${name}"?`);
    await expect(plain).toBeVisible();
    await expect(plain).toContainText(CHECKING);
    await expect(button(plain, "Delete")).toBeDisabled();
    held.release();
    await expect(plain).toContainText("Its points go with it. This can't be undone.");
    const confirm = button(plain, "Delete");
    await expect(confirm).toBeEnabled();
    const deleting = page.waitForRequest((r) => r.method() === "DELETE" && new URL(r.url()).pathname === `/api/sources/${id}`);
    await confirm.click();
    const query = Object.fromEntries(new URL((await deleting).url()).searchParams);
    expect(query, "the delete carries the counts the dialog showed").toEqual({ confirm: "true", expect_points: "0", expect_mappings: "0" });
    const toast = toastWith(page, `Source "${name}" deleted`);
    await expect(toast).toBeVisible();
    await expectInLowerRight(page, toast, "the source delete toast");
    await expect(plain).toBeHidden();
    expect(await sourceIds(page), "the fresh source is gone").not.toContain(id);
    expect(await sourceIds(page), "the mapped source is untouched").toContain(mapped!.id);
    expect(boxes, "the browser's own confirm box never opened").toEqual([]);
    await held.stop();
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  test("toasts: Asset created, clear of the profile menu, dismissable; Esc still closes a dialog under a toast; reduced motion", async ({ page }) => {
    test.setTimeout(150_000);
    const made = `W7k made ${RUN}`;
    const escLeaf = await makeAsset(page, `W7k esc ${RUN}`);
    const quietLeaf = await makeAsset(page, `W7k quiet ${RUN}`);

    await test.step("Asset created appears bottom right, takes no focus and does not cover the profile menu", async () => {
      await page.goto("/assets");
      await expect(heading1(page, "Assets Tree")).toBeVisible();
      await button(page, "Add asset").click();
      const dialog = dialogNamed(page, "Add asset");
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Name", { exact: true }).fill(made);
      await button(dialog, "Save").click();
      await expect(dialog).toBeHidden();

      const toast = toastWith(page, "Asset created");
      await expect(toast).toBeVisible();
      const box = await expectInLowerRight(page, toast, "the Asset created toast");
      const focusInStack = await page.evaluate(() => document.activeElement instanceof Element && document.activeElement.closest(".toast-stack") !== null);
      expect(focusInStack, "a toast never takes the focus").toBe(false);

      // The profile menu opens at the top right; the toast is still up (it lives 4 s), and the two share no area.
      await userBlock(page).click();
      const panel = page.locator("#profile-panel");
      await expect(panel).toBeVisible();
      await expect(toast, "the toast is still showing beside the open profile menu").toBeVisible();
      const panelBox = await boxOf(panel, "the profile menu");
      const toastBox = await boxOf(toast, "the toast");
      expect(overlap(panelBox, toastBox), `the profile menu (${JSON.stringify(panelBox)}) and the toast (${JSON.stringify(toastBox)}) overlap`).toBe(false);
      expect(box.width, "a toast is a small card").toBeLessThanOrEqual(400);
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();

      // Its own close button takes it away at once.
      await button(toast, "Dismiss notification").click();
      await expect(toast).toBeHidden({ timeout: 2_000 });
    });

    await test.step("Esc inside a dialog still closes the dialog while a toast is showing", async () => {
      await page.goto(`/assets/${escLeaf}`);
      const name = `W7k esc ${RUN}`;
      await expect(heading1(page, name)).toBeVisible();
      await button(page, `Delete ${name}`).click();
      const confirmation = dialogNamed(page, deleteTitle(name));
      await expect(button(confirmation, "Delete")).toBeEnabled();
      await button(confirmation, "Delete").click();
      const toast = toastWith(page, `Asset "${name}" deleted`);
      await expect(toast).toBeVisible();
      await toast.hover(); // a hovered toast waits, so it is still there when the dialog opens
      // From the keyboard, so the pointer stays on the toast.
      await button(page, "Add asset").focus();
      await page.keyboard.press("Enter");
      const dialog = dialogNamed(page, "Add asset");
      await expect(dialog).toBeVisible();
      await expect(toast, "the toast is showing while the dialog is open").toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog, "Esc closes the dialog").toBeHidden();
      await expect(toastWith(page, "Asset created"), "nothing was created by closing it").toHaveCount(0);
    });

    await test.step("under reduced motion a toast still appears and still leaves", async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      try {
        expect(await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches), "reduced motion is on").toBe(true);
        const name = `W7k quiet ${RUN}`;
        await page.goto(`/assets/${quietLeaf}`);
        await expect(heading1(page, name)).toBeVisible();
        await button(page, `Delete ${name}`).click();
        const confirmation = dialogNamed(page, deleteTitle(name));
        await expect(button(confirmation, "Delete")).toBeEnabled();
        await button(confirmation, "Delete").click();
        const toast = toastWith(page, `Asset "${name}" deleted`);
        await expect(toast).toBeVisible();
        await parkPointer(page);
        await expect(toast).toBeHidden({ timeout: 6_000 });
      } finally {
        await page.emulateMedia({ reducedMotion: null });
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
    test(`toasts and row menus: with Source added showing, the menu of the last Sources row is reachable (${size.width}x${size.height})`, async ({ page }) => {
      test.setTimeout(120_000);
      const name = `zzz W7k menu ${size.width} ${RUN}`; // sorts last, so it is the last row
      await setWidth(page, size.width, size.height);
      await page.goto("/sources");
      await expect(heading1(page, "Sources")).toBeVisible();
      await addSourceInTheDialog(page, name);

      const toast = toastWith(page, "Source added");
      await expect(toast).toBeVisible();
      const last = page.locator("tbody tr").last();
      const trigger = last.getByRole("button", { name: /^Actions for / });
      await expect(trigger).toBeVisible();
      const label = (await trigger.getAttribute("aria-label")) ?? "";
      expect(label, "the last row has an Actions button").toMatch(/^Actions for ./);
      // The toast is above the menu in the stack of layers (900 over 90): the button the person clicks must not be under it.
      const toastBox = await boxOf(toast, "the Source added toast");
      const triggerBox = await boxOf(trigger, "the Actions button");
      expect(overlap(toastBox, triggerBox), "the toast does not sit over the last row's Actions button").toBe(false);

      const menu = page.getByRole("menu", { name: label, exact: true });
      await trigger.click();
      await expect(menu).toBeVisible();
      await expect(toastWith(page, "Source added"), "the toast is still up beside the open menu").toBeVisible();
      await expectMenuReachable(page, menu);
      const menuBox = await boxOf(menu, "the open menu");
      expect(overlap(toastBox, menuBox), "the toast does not sit over the open menu").toBe(false);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await dropSourceNamed(page, name);
    });
  }

  test("a narrow window: the full-width toast keeps its 16 px margins and does not cover a dialog's Save", async ({ page }) => {
    test.setTimeout(120_000);
    // The app has no sticky Save bar: the Save that a toast could meet is the one in a dialog (which is above the toast, 1000 over 900).
    await setWidth(page, 600, 900);
    await page.goto("/sources");
    await expect(heading1(page, "Sources")).toBeVisible();
    await addSourceInTheDialog(page, `zzz W7k narrow ${RUN}`);

    const toast = toastWith(page, "Source added");
    await expect(toast).toBeVisible();
    await toast.hover(); // wait while the dialog is looked at
    const { width } = await layoutSize(page);
    await expect.poll(async () => Math.round((await boxOf(toast, "the narrow toast")).width), { message: "the toast is the full width between two 16 px margins" }).toBe(width - 32);
    const box = await boxOf(toast, "the narrow toast");
    expect(Math.abs(box.x - 16), `its left margin (${box.x} px)`).toBeLessThanOrEqual(1);
    expect(Math.abs(width - (box.x + box.width) - 16), `its right margin (${width - (box.x + box.width)} px)`).toBeLessThanOrEqual(1);

    await button(page, "Add source").focus();
    await page.keyboard.press("Enter");
    const dialog = dialogNamed(page, "Add source");
    await expect(dialog).toBeVisible();
    const save = button(dialog, "Save");
    await expect(save).toBeVisible();
    const covered = await save.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit === null || !el.contains(hit);
    });
    expect(covered, "nothing covers the dialog's Save button, the toast included").toBe(false);
    await button(dialog, "Cancel").click();
    await expect(dialog).toBeHidden();
    await dropSourceNamed(page, `zzz W7k narrow ${RUN}`);
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  test("the keyboard: Tab goes from Cancel to the confirm button and back, and wraps round at both ends; Cancel and Esc give the focus back to the trash button", async ({ page }) => {
    test.setTimeout(120_000);
    const name = `W7k keys ${RUN}`;
    const id = await makeSource(page, name);
    await page.goto("/sources");
    await expect(heading1(page, "Sources")).toBeVisible();
    // No source or asset delete starts from a row menu: the trash button is the opener, and it is where the focus comes back to.
    const trash = button(page, `Delete ${name}`);

    for (const how of ["Cancel button", "Esc"]) {
      await test.step(`closed with ${how}`, async () => {
        await trash.focus();
        await page.keyboard.press("Enter");
        const dialog = dialogNamed(page, `Delete source "${name}"?`);
        await expect(dialog).toBeVisible();
        const cancel = button(dialog, "Cancel");
        const confirm = button(dialog, "Delete");
        await expect(cancel, "the harmless button has the focus when the dialog opens").toBeFocused();
        await expect(confirm).toBeEnabled();
        await page.keyboard.press("Tab");
        await expect(confirm, "Tab reaches the confirm button").toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(cancel, "Shift+Tab goes back to Cancel").toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(confirm, "Shift+Tab from the first button wraps round to the last").toBeFocused();
        await page.keyboard.press("Tab");
        await expect(cancel, "Tab from the last button wraps round to the first").toBeFocused();
        if (how === "Cancel button") {
          await page.keyboard.press("Enter");
        } else {
          await page.keyboard.press("Escape");
        }
        await expect(dialog).toBeHidden();
        await expect(trash, "the focus is back on the trash button").toBeFocused();
        expect(await sourceIds(page), "nothing was deleted").toContain(id);
      });
    }
  });
});
