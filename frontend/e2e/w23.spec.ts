import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";

// W23 (the asset picker of the widget editor): a search box and a kind filter over a folded tree of checkboxes (radios for a stat and a gauge), the picks as removable chips, "Pick all under" a
// row. Admin `admin` / `correct-horse`, as in the earlier projects.
//
// IT MAKES ITS OWN DATA: beforeAll creates, through POST /api/assets, `W23 Site` > `W23 Hall 1` and `W23 Hall 2` > `W23 Row 1`..`W23 Row 3` under each hall > `W23 Rack 01`..`W23 Rack 10` under each
// row (69 assets; the same names repeat under the two halls, so the picker labels them with their parent path), and the dashboard `w23 <run>` (the dialog is only opened and cancelled, nothing is
// saved). afterAll deletes the dashboard and the whole `W23 Site` subtree, also after a failed case (and sweeps what an earlier run that stopped half way left). The cases are SERIAL. Every case
// stores its own look (PUT /api/me/preferences) before the page opens; afterAll puts it back to Light and Navy and gold. Nothing is mocked: the page talks to the real API of the stack. In every
// dialog the widget is a Bar chart on the Energy source, so every asset of the stack is offered (and, with the other projects' assets, there are more than 60: the picker opens folded). Names are
// matched by SUBSTRING, so every lookup is `exact: true`.
//   1   find by typing: `w23 rack 05` says `6 match` and lists six checkboxes named like `W23 Rack 05 (W23 Site / W23 Hall 1 / W23 Row 2)`; ticking one makes a chip with a Remove button; Escape in
//       the box clears the search and keeps the dialog, the pick is in place (its branch open, its box ticked); a second Escape, in the empty box, closes the dialog and leaves the page in edit mode.
//   2   kind and search: the kind filter counts what the search finds (Rack 30, Row 3, Hall 1 for `w23 hall 2`, and 34 for all kinds: the hall and what is inside it).
//   3   Pick all under: a row of ten racks picks ten; a hall with more than the room left (23 to add, room 10) picks NOTHING and says so; Clear all empties the chips and is then aria-disabled; at
//       20 picks the unpicked boxes are disabled, and unticking one enables them again.
//   4   keyboard: Tab goes from the search box to the kind list and on to the first chip's Remove button; Enter removes a chip and the focus lands on its neighbour, then on the search box after
//       the last chip (never on the page); Space ticks a focused checkbox.
//   5   a stat picks ONE asset: a group named Asset with radios, no Pick all under, no Clear all, no `N selected`, one chip without a Remove button that the next pick replaces; a gauge too (or
//       the empty message when no asset of the stack has the metric).
//   6   the layout does not move: at 1024 x 640 the list keeps its top and height through a search, one pick, 20 picks and the clearing of both, and Save widget stays reachable; at 800 x 600
//       the boxes stay inside the dialog, which has no horizontal scroll.
//   7   dark: a pick shows as a chip whose ground differs from the dialog's; the picker has exactly one aria-live line and no role="status".

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";

interface Look { mode: "light" | "dark"; theme: string }
interface Box { top: number; left: number; right: number; height: number }
const LIGHT: Look = { mode: "light", theme: "navy-gold" };
const DARK: Look = { mode: "dark", theme: "desert-gold" };

const RUN = Date.now().toString(36);
const DASHBOARD = `w23 ${RUN}`;
/** What an earlier run that stopped half way may have left behind: `w23 ` and a run id (Date.now() in base 36 is 8 characters until 2059), nothing a person named. */
const LEFTOVER = /^w23 [0-9a-z]{8}$/;

const SITE = "W23 Site";
const HALLS = [1, 2] as const;
const ROWS = [1, 2, 3] as const;
const RACKS = 10;
const MAX = 20; // lib/dashboardEdit.ts: a widget has at most 20 assets

test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------------------------------------------------------------
// The data, the dashboard and the look

let dashboardId = 0;
let siteId = 0;

/** The names and labels the picker gives the assets (lib/pickerRows.ts: a name used twice carries its parent path). */
const rackName = (n: number) => `W23 Rack ${String(n).padStart(2, "0")}`;
const rowLabel = (hall: number, row: number) => `W23 Row ${row} (${SITE} / W23 Hall ${hall})`;
const rackLabel = (hall: number, row: number, n: number) => `${rackName(n)} (${SITE} / W23 Hall ${hall} / W23 Row ${row})`;
const hallLabel = (hall: number) => `W23 Hall ${hall}`;

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

async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

async function createAsset(request: APIRequestContext, name: string, parentId: number | null, kind: string, order: number): Promise<number> {
  const made = await request.post("/api/assets", { data: { name, parent_id: parentId, kind, sort_order: order } });
  expect(made.status(), `creating ${name}: ${made.status()} ${await made.text()}`).toBe(201);
  return ((await made.json()) as { id: number }).id;
}

/** Deletes every top-level `W23 Site` with everything below it (an earlier run's, or this run's). */
async function removeSites(request: APIRequestContext): Promise<void> {
  const assets = await json<{ id: number; parent_id: number | null; name: string }[]>(request, "/api/assets");
  for (const old of assets.filter((a) => a.parent_id === null && a.name === SITE)) {
    const gone = await request.delete(`/api/assets/${old.id}?confirm=true`);
    expect([200, 204, 404], `deleting ${SITE} (${old.id}): ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  await asAdmin(browser, async (request) => {
    const prefs = await request.put("/api/me/preferences", { data: LIGHT });
    expect(prefs.ok(), `starting from the light look: ${prefs.status()} ${await prefs.text()}`).toBe(true);
    const listed = await json<{ id: number; name: string }[]>(request, "/api/dashboards");
    for (const old of listed.filter((d) => LEFTOVER.test(d.name))) await request.delete(`/api/dashboards/${old.id}`);
    await removeSites(request);

    // One at a time: the server serialises the sibling-name check, and the numbers of the names are the order.
    siteId = await createAsset(request, SITE, null, "Site", 1);
    for (const hall of HALLS) {
      const hallId = await createAsset(request, `W23 Hall ${hall}`, siteId, "Hall", hall);
      for (const row of ROWS) {
        const rowId = await createAsset(request, `W23 Row ${row}`, hallId, "Row", row);
        for (let rack = 1; rack <= RACKS; rack++) await createAsset(request, rackName(rack), rowId, "Rack", rack);
      }
    }
    const created = await request.post("/api/dashboards", { data: { name: DASHBOARD, range: "24h" } });
    expect(created.ok(), `creating ${DASHBOARD}: ${created.status()} ${await created.text()}`).toBe(true);
    dashboardId = ((await created.json()) as { id: number }).id;
  });
});

test.afterAll(async ({ browser }) => {
  test.setTimeout(300_000);
  await asAdmin(browser, async (request) => {
    await request.put("/api/me/preferences", { data: LIGHT });
    if (dashboardId) await request.delete(`/api/dashboards/${dashboardId}`);
    await removeSites(request); // the whole subtree, whether or not beforeAll got to the end
  });
});

/** Signs in and stores the look the case needs (the account's saved look wins over the browser's mirror, so it is set through the API before a page opens). */
async function signIn(page: Page, look: Look = LIGHT): Promise<void> {
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in: ${login.status()} ${await login.text()}`).toBe(true);
  const saved = await page.request.put("/api/me/preferences", { data: look });
  expect(saved.ok(), `storing ${JSON.stringify(look)}: ${saved.status()} ${await saved.text()}`).toBe(true);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Locators and readings

const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const addButton = (page: Page) => button(page, "Add widget");
const addDialog = (page: Page) => page.getByRole("dialog", { name: "Add widget", exact: true });
const fieldOf = (dialog: Locator, label: string) => dialog.getByLabel(label, { exact: true });
const saveWidget = (dialog: Locator) => dialog.getByRole("button", { name: "Save widget", exact: true });

/** The picker: the fieldset, named Assets (Asset for a stat and a gauge). */
const pickerOf = (dialog: Locator, name = "Assets") => dialog.getByRole("group", { name, exact: true });
const searchOf = (picker: Locator) => picker.getByLabel("Search assets", { exact: true });
const kindOf = (picker: Locator) => picker.getByLabel("Filter by kind", { exact: true });
const liveOf = (picker: Locator) => picker.locator("[aria-live]");
const chipsOf = (picker: Locator) => picker.locator('ul[aria-label="Picked assets"] > li');
const removeOf = (picker: Locator, label: string) => picker.getByRole("button", { name: `Remove ${label}`, exact: true });
const tickOf = (picker: Locator, label: string) => picker.getByRole("checkbox", { name: label, exact: true });
const pickAllOf = (picker: Locator, label: string) => picker.getByRole("button", { name: `Pick all under ${label}`, exact: true });
const foldOf = (picker: Locator, label: string) => picker.getByRole("button", { name: `Children of ${label}`, exact: true });
const countOf = (picker: Locator, n: number) => picker.getByText(`${n} selected (up to ${MAX})`, { exact: true });
const clearAllOf = (picker: Locator) => picker.getByRole("button", { name: "Clear all", exact: true });

/** 0 (black) to 1 (white) for a computed colour (`rgb(...)`, or `color(srgb r g b)` with channels 0 to 1); NaN for anything else. */
function brightness(css: string): number {
  const numbers = (css.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  if (numbers.length < 3) return NaN;
  const scale = css.startsWith("color(") ? 1 : 255;
  const [r, g, b] = numbers.slice(0, 3).map((n) => n / scale);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Opens the dashboard in edit mode and waits until Add widget can be used (it waits for the asset list). */
async function openEditor(page: Page): Promise<void> {
  await page.goto(`/dashboards/${dashboardId}`);
  await button(page, "Edit").click();
  await expect(button(page, "Save")).toBeVisible();
  await expect(addButton(page)).toBeEnabled();
  await settled(page);
}

/** The Add widget dialog on a Bar chart over Energy (every asset is offered) or another type; the source is left alone when `source` is null. */
async function openAddDialog(page: Page, type: "bar" | "stat" | "gauge" = "bar", source: "energy" | null = "energy"): Promise<Locator> {
  await addButton(page).click();
  const dialog = addDialog(page);
  await expect(dialog).toBeVisible();
  await fieldOf(dialog, "Type").selectOption({ value: type });
  if (source !== null) await fieldOf(dialog, "Source").selectOption({ value: source });
  await settled(page);
  return dialog;
}

/** The value of the kind filter's option whose text starts `<name> (`; the option reads "<name> (<count>)", and the count includes the other projects' assets. */
async function kindValue(picker: Locator, name: string): Promise<string> {
  const options = await kindOf(picker).locator("option").evaluateAll((els: Element[]) => els.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent ?? "" })));
  const found = options.find((o) => o.text.toLowerCase().startsWith(`${name.toLowerCase()} (`));
  expect(found, `the kind filter offers ${name}: ${JSON.stringify(options)}`).toBeTruthy();
  expect(found!.text, `the ${name} option reads "<name> (<count>)"`).toMatch(/^.+ \(\d+\)$/);
  return found!.value;
}

/** Whether the focus is on an element of the dialog (never on the page behind it). */
async function expectFocusInside(dialog: Locator, step: string): Promise<void> {
  const inside = await dialog.evaluate((el) => el.contains(document.activeElement) && document.activeElement !== el && document.activeElement !== document.body);
  expect(inside, `${step}: the focus is on an element of the dialog`).toBe(true);
}

/** Where the picker's parts stand, relative to the dialog's own scrolling content (so scrolling the dialog moves nothing), and how much the dialog overflows sideways. */
async function measure(dialog: Locator): Promise<{ list: Box; chips: Box; tools: Box; foot: Box; inner: number; over: number }> {
  return dialog.evaluate((el) => {
    const frame = el.getBoundingClientRect();
    const at = (selector: string): Box => {
      const target = el.querySelector(selector);
      if (!target) throw new Error(`no ${selector} in the dialog`);
      const r = target.getBoundingClientRect();
      return { top: r.top - frame.top + el.scrollTop, left: r.left - frame.left, right: r.right - frame.left, height: r.height };
    };
    return { list: at(".picker-list"), chips: at(".picker-chip-box"), tools: at(".picker-tools"), foot: at(".picker-foot"), inner: el.clientWidth, over: el.scrollWidth - el.clientWidth };
  });
}

type Measured = Awaited<ReturnType<typeof measure>>;

/** The list and the chip box keep their top and height (within 1 px) through whatever the person did. */
function expectUnmoved(now: Measured, base: Measured, step: string): void {
  for (const part of ["list", "chips", "tools"] as const) {
    expect(Math.abs(now[part].top - base[part].top), `${step}: the top of the ${part} did not move`).toBeLessThanOrEqual(1);
    expect(Math.abs(now[part].height - base[part].height), `${step}: the height of the ${part} did not change`).toBeLessThanOrEqual(1);
  }
}

/** Scrolls the button into view and checks that it is on the screen and is what a click at its centre would reach. */
async function expectReachable(target: Locator, step: string): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const reading = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { onScreen: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth, reached: hit === el || el.contains(hit) };
  });
  expect(reading.onScreen, `${step}: Save widget is inside the window`).toBe(true);
  expect(reading.reached, `${step}: nothing covers Save widget`).toBe(true);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. Find by typing

test("1. light: a rack is found by typing, picked and shown as a chip; Escape clears the search and keeps the dialog, a second Escape closes it and the page stays in edit mode", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await openEditor(page);
  const dialog = await openAddDialog(page);
  const picker = pickerOf(dialog);
  const search = searchOf(picker);
  const live = liveOf(picker);

  // Before any search the list is folded: more than 60 assets, so the halls are closed and no rack shows.
  await expect(foldOf(picker, hallLabel(1)), "the hall opens folded").toHaveAttribute("aria-expanded", "false");
  await expect(picker.getByRole("checkbox", { name: /^W23 Rack / }), "no rack shows before a search").toHaveCount(0);
  await expect(live, "the live line is empty before a search").toBeEmpty();

  await search.fill("w23 rack 05");
  await expect(live).toHaveText("6 match");
  const found = picker.getByRole("checkbox", { name: /^W23 Rack 05 \(W23 Site \/ W23 Hall [12] \/ W23 Row [123]\)$/ });
  await expect(found, "six boxes, each named with its parent path").toHaveCount(6);

  const label = rackLabel(1, 2, 5);
  await tickOf(picker, label).check();
  await expect(chipsOf(picker)).toHaveCount(1);
  await expect(chipsOf(picker).first()).toHaveText(label);
  await expect(removeOf(picker, label), "the chip has a Remove button").toBeVisible();
  await expect(countOf(picker, 1)).toBeVisible();

  // Escape in the box: the box is empty, the dialog is still there, the focus stays in the box.
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(dialog, "the first Escape only clears the search").toBeVisible();
  await expect(search).toBeFocused();
  await expect(live).toBeEmpty();
  // The pick is in place: its row's branch is open and its box is ticked.
  await expect(foldOf(picker, rowLabel(1, 2)), "the branch of the pick is open").toHaveAttribute("aria-expanded", "true");
  await expect(tickOf(picker, label), "the pick is ticked in the tree").toBeChecked();
  await expect(chipsOf(picker)).toHaveCount(1);

  // A second Escape, in the empty box, closes the dialog and only the dialog.
  await search.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(button(page, "Save"), "the page is still in edit mode").toBeVisible();
  await expect(button(page, "Cancel")).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. Kind and search

test("2. the kind filter and the search together count what is inside a match: Rack 30, Row 3, Hall 1 for `w23 hall 2`", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await openEditor(page);
  const dialog = await openAddDialog(page);
  const picker = pickerOf(dialog);
  const live = liveOf(picker);
  const kind = kindOf(picker);

  const rack = await kindValue(picker, "Rack");
  const row = await kindValue(picker, "Row");
  const hall = await kindValue(picker, "Hall");

  await searchOf(picker).fill("w23 hall 2");
  // All kinds: the hall itself, its 3 rows and their 30 racks.
  await expect(live).toHaveText("34 match");

  await kind.selectOption({ value: rack });
  await expect(live).toHaveText("30 match");
  await expect(picker.getByRole("checkbox", { name: /^W23 Rack \d\d \(W23 Site \/ W23 Hall 2 \/ W23 Row [123]\)$/ }), "the thirty racks of Hall 2 are listed").toHaveCount(30);
  await expect(picker.getByRole("checkbox", { name: /^W23 Rack \d\d \(W23 Site \/ W23 Hall 1 /}), "and none of Hall 1").toHaveCount(0);

  await kind.selectOption({ value: row });
  await expect(live).toHaveText("3 match");

  await kind.selectOption({ value: hall });
  await expect(live).toHaveText("1 match");

  await kind.selectOption({ value: "" });
  await expect(live).toHaveText("34 match");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. Pick all under, within and over the maximum

test("3. Pick all under a row picks its ten racks; a hall with more than the room left picks nothing and says so; Clear all empties the chips; at 20 the unpicked boxes are disabled and unticking one frees them", async ({ page }) => {
  test.setTimeout(150_000);
  await signIn(page);
  await openEditor(page);
  const dialog = await openAddDialog(page);
  const picker = pickerOf(dialog);
  const search = searchOf(picker);
  const live = liveOf(picker);
  const chips = chipsOf(picker);

  // Within the maximum.
  await search.fill("w23 row 1");
  await expect(live, "two rows and the 20 racks inside them").toHaveText("22 match");
  await pickAllOf(picker, rowLabel(1, 1)).click();
  await expect(chips).toHaveCount(10);
  await expect(countOf(picker, 10)).toBeVisible();
  await search.press("Escape");
  await expect(dialog).toBeVisible();

  // Over the maximum: Hall 1 holds 33 assets, 10 are picked, 23 would be added, room is 10. Nothing is picked.
  await pickAllOf(picker, hallLabel(1)).click();
  await expect(live).toHaveText("23 assets under W23 Hall 1, room for 10: nothing was picked");
  await expect(chips).toHaveCount(10);
  await expect(countOf(picker, 10)).toBeVisible();
  await pickAllOf(picker, hallLabel(2)).click();
  await expect(live).toHaveText("33 assets under W23 Hall 2, room for 10: nothing was picked");
  await expect(chips).toHaveCount(10);
  await expect(countOf(picker, 10)).toBeVisible();

  // Clear all empties the chips, and the button is then aria-disabled.
  await expect(clearAllOf(picker)).not.toHaveAttribute("aria-disabled", "true");
  await clearAllOf(picker).click();
  await expect(chips).toHaveCount(0);
  await expect(countOf(picker, 0)).toBeVisible();
  await expect(picker.getByText("Nothing picked yet.", { exact: true })).toBeVisible();
  await expect(clearAllOf(picker)).toHaveAttribute("aria-disabled", "true");

  // To the maximum: the first rows of both halls, 10 + 10.
  await search.fill("w23 row 1");
  await pickAllOf(picker, rowLabel(1, 1)).click();
  await expect(chips).toHaveCount(10);
  await pickAllOf(picker, rowLabel(2, 1)).click();
  await expect(chips).toHaveCount(MAX);
  await expect(countOf(picker, MAX)).toBeVisible();
  await search.press("Escape");
  await expect(dialog).toBeVisible();

  await expect(pickAllOf(picker, rowLabel(1, 1)), "everything under the row is picked").toHaveAttribute("aria-disabled", "true");
  await expect(tickOf(picker, rackLabel(1, 1, 1)), "a pick stays enabled").toBeChecked();
  await expect(tickOf(picker, rackLabel(1, 1, 1))).toBeEnabled();
  await expect(tickOf(picker, rowLabel(1, 2)), "at the maximum an unpicked box is disabled").toBeDisabled();
  await expect(tickOf(picker, hallLabel(2))).toBeDisabled();

  await tickOf(picker, rackLabel(1, 1, 1)).uncheck();
  await expect(countOf(picker, MAX - 1)).toBeVisible();
  await expect(tickOf(picker, rowLabel(1, 2)), "with room again an unpicked box is enabled").toBeEnabled();
  await expect(tickOf(picker, hallLabel(2))).toBeEnabled();
  await expect(pickAllOf(picker, rowLabel(1, 1)), "and the row has something to pick again").not.toHaveAttribute("aria-disabled", "true");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. Keyboard

test("4. by keyboard: Tab runs from the search box to the kind list and the first chip; Enter removes a chip and the focus lands on its neighbour, then on the search box; Space ticks a box", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await openEditor(page);
  const dialog = await openAddDialog(page);
  const picker = pickerOf(dialog);
  const search = searchOf(picker);
  const chips = chipsOf(picker);

  await search.fill("w23 rack 05");
  await expect(liveOf(picker)).toHaveText("6 match");
  const [a, b, c] = [rackLabel(1, 1, 5), rackLabel(1, 2, 5), rackLabel(1, 3, 5)];
  for (const label of [a, b, c]) await tickOf(picker, label).check();
  await expect(chips).toHaveCount(3);
  expect(await chips.allTextContents(), "the chips come in the order of the picks").toEqual([a, b, c]);

  await search.focus();
  await page.keyboard.press("Tab");
  await expect(kindOf(picker), "Tab goes on to the kind list").toBeFocused();
  await page.keyboard.press("Tab");
  await expect(removeOf(picker, a), "and then to the first chip's Remove button").toBeFocused();

  // Enter removes the first chip; the focus is on the next chip's button.
  await page.keyboard.press("Enter");
  await expect(chips).toHaveCount(2);
  await expect(removeOf(picker, b), "after the first chip the focus is on the next one").toBeFocused();
  await expectFocusInside(dialog, "after the first removal");

  // The last chip: Tab to it, Enter; the focus is on the previous one.
  await page.keyboard.press("Tab");
  await expect(removeOf(picker, c)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(chips).toHaveCount(1);
  await expect(removeOf(picker, b), "after the last chip the focus is on the previous one").toBeFocused();
  await expectFocusInside(dialog, "after the last removal");

  // The only chip left: the focus goes back to the search box.
  await page.keyboard.press("Enter");
  await expect(chips).toHaveCount(0);
  await expect(search, "with no chip left the focus is on the search box").toBeFocused();
  await expectFocusInside(dialog, "after the last chip");

  // Space on a focused checkbox ticks it.
  const space = rackLabel(2, 1, 5);
  await tickOf(picker, space).focus();
  await expect(tickOf(picker, space)).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(tickOf(picker, space)).toBeChecked();
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toHaveText(space);
  await expect(tickOf(picker, space), "the focus stays on the box").toBeFocused();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. Stat and gauge pick one

test("5. a stat picks one asset (radios, a group named Asset, no Pick all under, no Clear all, no count, one chip without a Remove button); a gauge does too", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await openEditor(page);
  const dialog = await openAddDialog(page, "stat", "energy");
  const picker = pickerOf(dialog, "Asset");
  const search = searchOf(picker);
  const chips = chipsOf(picker);

  await expect(picker, "a stat has a group named Asset").toBeVisible();
  await expect(pickerOf(dialog, "Assets"), "and not one named Assets").toHaveCount(0);
  await search.fill("w23 rack 05");
  await expect(liveOf(picker)).toHaveText("6 match");
  await expect(picker.getByRole("checkbox"), "no checkbox").toHaveCount(0);
  await expect(picker.getByRole("radio", { name: /^W23 Rack 05 \(W23 Site \/ W23 Hall [12] \/ W23 Row [123]\)$/ })).toHaveCount(6);
  await expect(picker.getByRole("button", { name: /^Pick all under / }), "no Pick all under").toHaveCount(0);
  await expect(clearAllOf(picker), "no Clear all").toHaveCount(0);
  await expect(picker.getByText(/\d+ selected/), "no count").toHaveCount(0);
  await expect(picker.getByText("No asset picked yet.", { exact: true })).toBeVisible();

  const first = rackLabel(1, 1, 5);
  await picker.getByRole("radio", { name: first, exact: true }).check();
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toHaveText(first);
  await expect(picker.getByRole("button", { name: /^Remove / }), "the only chip has no Remove button").toHaveCount(0);

  const second = rackLabel(2, 3, 5);
  await picker.getByRole("radio", { name: second, exact: true }).check();
  await expect(chips, "the next pick replaces the first").toHaveCount(1);
  await expect(chips.first()).toHaveText(second);
  await expect(picker.getByRole("radio", { name: first, exact: true })).not.toBeChecked();
  await expect(picker.getByRole("button", { name: /^Remove / })).toHaveCount(0);

  // A gauge: the source goes to the metric, so only the assets that have it are offered (maybe none on this stack).
  await fieldOf(dialog, "Type").selectOption({ value: "gauge" });
  await settled(page);
  await expect(picker, "a gauge has a group named Asset").toBeVisible();
  await expect(picker.getByRole("checkbox")).toHaveCount(0);
  await expect(picker.getByRole("button", { name: /^Pick all under / })).toHaveCount(0);
  await expect(clearAllOf(picker)).toHaveCount(0);
  if ((await search.count()) > 0) await search.fill(""); // the search of the stat is still typed and would hide whatever the gauge offers (no box at all when nothing is offered)
  await settled(page);
  const nothing = picker.getByText(/^No asset has a mapping for /);
  if ((await nothing.count()) > 0) {
    await expect(nothing, "no asset has the metric: the picker says so").toBeVisible();
  } else {
    await expect(picker.getByText("No asset picked yet.", { exact: true }), "the racks of the stat lack the metric and went").toBeVisible();
    if ((await picker.getByRole("radio").count()) > 0) {
      await picker.getByRole("radio").first().check();
      await expect(chips).toHaveCount(1);
      await expect(picker.getByRole("button", { name: /^Remove / }), "the only chip has no Remove button").toHaveCount(0);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 6. The layout does not move

test("6. at 1024 x 640 the list keeps its place through a search, a pick, 20 picks and the clearing, and Save widget is reachable; at 800 x 600 the boxes stay inside the dialog", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1024, height: 640 });
  await signIn(page);
  await openEditor(page);
  const dialog = await openAddDialog(page);
  const picker = pickerOf(dialog);
  const search = searchOf(picker);
  const chips = chipsOf(picker);

  const base = await measure(dialog);
  expect(base.list.height, "the list has a height").toBeGreaterThan(100);
  expect(base.chips.height, "the chip box has a height").toBeGreaterThan(30);
  await expectReachable(saveWidget(dialog), "at the start");

  await search.fill("w23 rack 05");
  await expect(liveOf(picker)).toHaveText("6 match");
  await settled(page);
  expectUnmoved(await measure(dialog), base, "after a search");

  await tickOf(picker, rackLabel(1, 1, 5)).check();
  await expect(chips).toHaveCount(1);
  await settled(page);
  expectUnmoved(await measure(dialog), base, "after one pick");

  await search.press("Escape");
  await search.fill("w23 row 1");
  await expect(liveOf(picker)).toHaveText("22 match");
  await pickAllOf(picker, rowLabel(1, 1)).click(); // 9 more: the rack picked above is under it
  await pickAllOf(picker, rowLabel(2, 1)).click();
  await expect(countOf(picker, MAX)).toBeVisible();
  await settled(page);
  expectUnmoved(await measure(dialog), base, "after 20 picks");
  await expectReachable(saveWidget(dialog), "with 20 picks");

  await search.press("Escape");
  await expect(search).toHaveValue("");
  await settled(page);
  expectUnmoved(await measure(dialog), base, "after clearing the search");
  await clearAllOf(picker).click();
  await expect(chips).toHaveCount(0);
  await settled(page);
  expectUnmoved(await measure(dialog), base, "after Clear all");

  // 800 x 600: the same parts stay inside the dialog, and the dialog does not scroll sideways, with six long chips in the box.
  await page.setViewportSize({ width: 800, height: 600 });
  await settled(page);
  const narrow = await measure(dialog);
  await search.fill("w23 rack 05");
  await expect(liveOf(picker)).toHaveText("6 match");
  for (const [hall, row] of [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3]] as const) await tickOf(picker, rackLabel(hall, row, 5)).check();
  await expect(chips).toHaveCount(6);
  await settled(page);
  const now = await measure(dialog);
  expectUnmoved(now, narrow, "at 800 x 600 after six picks");
  for (const part of ["list", "chips", "tools", "foot"] as const) {
    expect(now[part].left, `at 800 x 600 the ${part} starts inside the dialog`).toBeGreaterThanOrEqual(-1);
    expect(now[part].right, `at 800 x 600 the ${part} ends inside the dialog`).toBeLessThanOrEqual(now.inner + 1);
  }
  expect(now.over, "at 800 x 600 the dialog has no horizontal scroll").toBeLessThanOrEqual(1);
  await expectReachable(saveWidget(dialog), "at 800 x 600");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 7. Dark

test("7. dark: a pick shows as a chip whose ground differs from the dialog's, and the picker has one aria-live line and no status role", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, DARK); // the look is stored before the page opens
  await openEditor(page);
  const dialog = await openAddDialog(page);
  const picker = pickerOf(dialog);
  const search = searchOf(picker);

  const ground = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor);
  const lightness = brightness(ground);
  if (Number.isFinite(lightness)) expect(lightness, "the dialog is dark in the dark look").toBeLessThan(0.5);

  await search.fill("w23 rack 05");
  await expect(liveOf(picker)).toHaveText("6 match");
  const label = rackLabel(2, 3, 5);
  await tickOf(picker, label).check();
  const chip = chipsOf(picker).first();
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText(label);
  await expect(removeOf(picker, label)).toBeVisible();
  const chipGround = await chip.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(chipGround, "the chip's ground differs from the dialog's, so it can be seen").not.toBe(ground);

  await expect(picker.locator("[aria-live]"), "one live line").toHaveCount(1);
  await expect(picker.locator('[role="status"]'), "and no status role").toHaveCount(0);
});
