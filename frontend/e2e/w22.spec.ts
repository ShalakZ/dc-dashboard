import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { markGuideSeen } from "./shell";

test.beforeEach(({ page }) => markGuideSeen(page)); // w27: the dashboard guide is not what this spec looks at

// W22 (the Text widget): a sixth widget type with no data, a heading, a paragraph or a divider that explains a dashboard. Admin `admin` / `correct-horse`, as in the earlier projects.
//
// IT MAKES ITS OWN DASHBOARDS: beforeAll creates `w22 <run>` (the light flow, then every other case) and `w22 <run> dark` (the dark flow of case 1) through POST /api/dashboards, and afterAll
// deletes both, also after a failed case (and sweeps what an earlier run that stopped half way left). The cases are SERIAL: case 1 builds the three text cards through the dialog on the first
// dashboard, the later cases work on them. Every case stores its own look (PUT /api/me/preferences) before the page opens; afterAll puts it back to Light and Navy and gold. Nothing is mocked:
// the page talks to the real API of the stack. Names are matched by SUBSTRING, so every lookup is `exact: true`.
//   1   a heading, a paragraph and a divider added through the dialog (the Title field shows the automatic title), saved, reloaded: the heading is an h2 and NOT a named region, the paragraph keeps
//       its three lines and shows `<b>not bold</b>` as typed, exactly one separator, no Details or Download CSV button on any of them; light and dark (the look is stored before the page opens),
//       the three cards visible and none wider than the page.
//   2   no `/api/widget-data` request for a page of text widgets: not in view mode, not in edit mode, not while the dialog's preview is on screen; a stat added after them makes its own request
//       (type stat, never type text).
//   3   edit mode: each text card has the grip, the title, `Edit <title>` and `Delete <title>`; one card is moved with the mouse by its title bar and one resized from its south edge to ONE row;
//       at 1024 x 640 the one-row heading shows its text fully and keeps both buttons inside the card; Save; the positions come back from the API and after a reload.
//   4   the dialog by keyboard: Enter on Add widget opens it, Tab goes Type, Title, Style, Text, Cancel, Save widget; Escape closes the dialog (not the editor) and gives the focus back; an empty
//       heading and a heading with a line break are refused with their sentence and Save widget stays disabled.
//   5   counting: three emoji count 3 (not 6) in a heading's "N of 200 characters" and in a paragraph's "N of 2,000 characters"; a divider hides the Text field, can be saved at once and takes the
//       automatic title `Divider` (`Divider 2` when the dashboard already has one).
//   6   the server refuses what the dialog never sends (page.request, the signed-in cookies): a NUL and a heading with a line break answer 422 naming `text` and store nothing; a paragraph saved
//       with CRLF comes back with LF (the dashboard is put back as it was); POST /api/widget-data and /api/widget-data/csv with type text answer 422 `no data`.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";

interface Look { mode: "light" | "dark"; theme: string }
interface Box { x: number; y: number; width: number; height: number }
type TextStyle = "heading" | "paragraph" | "divider";
const LIGHT: Look = { mode: "light", theme: "navy-gold" };
const DARK: Look = { mode: "dark", theme: "desert-gold" };

const RUN = Date.now().toString(36);
const DASHBOARD = `w22 ${RUN}`;
const DASHBOARD_DARK = `w22 ${RUN} dark`;
/** What an earlier run that stopped half way may have left behind. */
const LEFTOVER = /^w22 [0-9a-z]+( dark)?$/;

const HEADING = "Hall A overview";
const LINES = ["Racks 01 to 24 are fed from Feed A.", "<b>not bold</b>", "Call the duty engineer on a fault."];
const PARAGRAPH = LINES.join("\n");
const PARAGRAPH_TITLE = LINES[0]; // the automatic title: the first line
const DIVIDER = "Divider";
const EMOJI = String.fromCodePoint(0x1f600); // one code point, two UTF-16 units
const ROW = 90; // lib/gridMetrics.ts: 80 px rows with 10 px gaps

test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------------------------------------------------------------
// The dashboards and the look

let dashboardId = 0;
let darkId = 0;
let assetName = "";

interface ApiWidget { id?: number; type: string; title: string; x: number; y: number; w: number; h: number; config: { style?: string; text?: string } }
interface ApiDashboard { id: number; name: string; range: string; updated_at: string; widgets: ApiWidget[] }

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

async function createDashboard(request: APIRequestContext, name: string): Promise<number> {
  const created = await request.post("/api/dashboards", { data: { name, range: "24h" } });
  expect(created.ok(), `creating ${name}: ${created.status()} ${await created.text()}`).toBe(true);
  return ((await created.json()) as { id: number }).id;
}

test.beforeAll(async ({ browser }) => {
  await asAdmin(browser, async (request) => {
    const prefs = await request.put("/api/me/preferences", { data: LIGHT });
    expect(prefs.ok(), `starting from the light look: ${prefs.status()} ${await prefs.text()}`).toBe(true);
    const listed = await json<{ id: number; name: string }[]>(request, "/api/dashboards");
    for (const old of listed.filter((d) => LEFTOVER.test(d.name))) await request.delete(`/api/dashboards/${old.id}`);
    // The stat of case 2 needs one asset the picker names by its bare name: the first one whose name nothing else shares.
    const assets = (await json<{ id: number; name: string }[]>(request, "/api/assets")).sort((a, b) => a.id - b.id);
    const shared = new Map<string, number>();
    for (const a of assets) shared.set(a.name, (shared.get(a.name) ?? 0) + 1);
    const unique = assets.find((a) => shared.get(a.name) === 1);
    expect(unique, "the stack has an asset whose name is not used twice").toBeTruthy();
    assetName = unique!.name;
    dashboardId = await createDashboard(request, DASHBOARD);
    darkId = await createDashboard(request, DASHBOARD_DARK);
  });
});

test.afterAll(async ({ browser }) => {
  await asAdmin(browser, async (request) => {
    await request.put("/api/me/preferences", { data: LIGHT });
    for (const id of [dashboardId, darkId]) if (id) await request.delete(`/api/dashboards/${id}`);
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
const counterOf = (dialog: Locator) => dialog.locator("p.widget-text-count");
const issuesOf = (dialog: Locator) => dialog.locator("ul.issues > li");
/** A card of the editor's grid, by its title (every card there is a region named by its title). */
const frameOf = (page: Page, title: string) => page.getByRole("region", { name: title, exact: true });
const itemOf = (page: Page, title: string) => page.locator(".react-grid-item").filter({ has: frameOf(page, title) });

async function boxOf(target: Locator, what: string): Promise<Box> {
  const box = await target.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  expect(box.width * box.height, `${what} has a box`).toBeGreaterThan(0);
  return box;
}

const inside = (inner: Box, outer: Box, slack = 1): boolean =>
  inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;

/** 0 (black) to 1 (white) for a computed colour (`rgb(...)`, or `color(srgb r g b)` with channels 0 to 1); NaN for anything else. */
function brightness(css: string): number {
  const numbers = (css.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  if (numbers.length < 3) return NaN;
  const scale = css.startsWith("color(") ? 1 : 255;
  const [r, g, b] = numbers.slice(0, 3).map((n) => n / scale);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Opens a dashboard in edit mode and waits until Add widget can be used (it waits for the asset list). */
async function openEditor(page: Page, id: number): Promise<void> {
  await page.goto(`/dashboards/${id}`);
  await button(page, "Edit").click();
  await expect(button(page, "Save")).toBeVisible();
  await expect(addButton(page)).toBeEnabled();
  await settled(page);
}

/** In edit mode: Cancel and, when the editor asks, throw the unsaved changes away. */
async function discardEdits(page: Page): Promise<void> {
  await button(page, "Cancel").click();
  const leave = page.getByRole("alertdialog", { name: "Unsaved changes", exact: true });
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Leave and discard changes", exact: true }).click();
  await expect(button(page, "Edit")).toBeVisible();
}

/** The dialog, opened on a text widget: Type is Text and the Style and Text fields are there. */
async function openTextDialog(page: Page): Promise<Locator> {
  await addButton(page).click();
  const dialog = addDialog(page);
  await expect(dialog).toBeVisible();
  await fieldOf(dialog, "Type").selectOption({ value: "text" });
  await expect(fieldOf(dialog, "Style")).toBeVisible();
  return dialog;
}

/** Adds one text widget through the dialog and checks the automatic Title on the way. */
async function addText(page: Page, style: TextStyle, text: string, autoTitle: string): Promise<void> {
  const dialog = await openTextDialog(page);
  await expect(fieldOf(dialog, "Style")).toHaveValue("heading");
  await expect(fieldOf(dialog, "Title"), "until there is text the Title is the style's word").toHaveValue("Heading");
  await fieldOf(dialog, "Style").selectOption({ value: style });
  if (style === "divider") {
    await expect(fieldOf(dialog, "Text"), "a divider has no Text field").toHaveCount(0);
  } else {
    await fieldOf(dialog, "Text").fill(text);
    await expect(dialog.locator(".widget-preview"), "the preview draws the text at once").toContainText(style === "paragraph" ? LINES[1] : text);
  }
  await expect(fieldOf(dialog, "Title"), "the Title follows the text").toHaveValue(autoTitle);
  await expect(saveWidget(dialog)).toBeEnabled();
  await saveWidget(dialog).click();
  await expect(dialog).toBeHidden();
}

/** Every POST the page makes to a widget-data route from now on (the stat query is /api/widget-data; its CSV, never asked here, is /api/widget-data/csv). */
function recordWidgetData(page: Page): { method: string; path: string; type: string | null }[] {
  const seen: { method: string; path: string; type: string | null }[] = [];
  page.on("request", (request) => {
    if (!request.url().includes("/api/widget-data")) return;
    let type: string | null = null;
    try {
      type = (JSON.parse(request.postData() ?? "") as { type?: string }).type ?? null;
    } catch {
      // not JSON: recorded without a type
    }
    seen.push({ method: request.method(), path: new URL(request.url()).pathname, type });
  });
  return seen;
}

/** What the view-mode dashboard must show for the three text widgets of case 1, in the look on screen. */
async function expectTextCards(page: Page, name: string, look: Look): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
  const heading = page.getByRole("heading", { level: 2, name: HEADING, exact: true });
  await expect(heading, "the heading is an h2").toHaveCount(1);
  await expect(heading).toBeVisible();
  await expect(page.getByRole("region", { name: HEADING, exact: true }), "the heading is not a region named by its title").toHaveCount(0);
  await expect(heading.locator(`xpath=ancestor::*[@aria-label="${HEADING}"]`), "no ancestor is named by the heading's title").toHaveCount(0);

  const region = frameOf(page, PARAGRAPH_TITLE);
  await expect(region, "the paragraph is a region named by its title (the first line)").toHaveCount(1);
  await expect(region).toBeVisible();
  const paragraph = region.locator("p");
  await expect(paragraph).toHaveCount(1);
  expect(await paragraph.evaluate((el) => el.textContent), "the paragraph holds the typed text").toBe(PARAGRAPH);
  expect(await paragraph.evaluate((el) => (el as HTMLElement).innerText), "and draws its three lines").toBe(PARAGRAPH);
  await expect(region.locator("b"), "markup is text, never HTML").toHaveCount(0);
  await expect(region).toContainText(LINES[1]);

  await expect(page.getByRole("separator"), "one divider").toHaveCount(1);
  await expect(page.getByRole("separator")).toBeVisible();

  await expect(page.getByRole("button", { name: /^Details for / }), "a text widget has no Details button").toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Download CSV for / }), "a text widget has no CSV button").toHaveCount(0);

  const cards = page.locator(".dash-grid .widget-text");
  await expect(cards, "three text cards").toHaveCount(3);
  for (const i of [0, 1, 2]) await expect(cards.nth(i)).toBeVisible();
  const reading = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      page: doc.scrollWidth - doc.clientWidth,
      width: doc.clientWidth,
      cards: Array.from(document.querySelectorAll<HTMLElement>(".dash-grid .widget-text")).map((el) => {
        const r = el.getBoundingClientRect();
        return { style: el.dataset.style ?? "", right: r.right, left: r.left, over: el.scrollWidth - el.clientWidth, ground: getComputedStyle(el).backgroundColor };
      }),
    };
  });
  expect(reading.page, `${look.mode}: the page does not scroll sideways`).toBeLessThanOrEqual(0);
  for (const card of reading.cards) {
    expect(card.over, `${look.mode}: the ${card.style} card has no horizontal scroll`).toBeLessThanOrEqual(1);
    expect(card.left, `${look.mode}: the ${card.style} card starts inside the window`).toBeGreaterThanOrEqual(-1);
    expect(card.right, `${look.mode}: the ${card.style} card ends inside the window`).toBeLessThanOrEqual(reading.width + 1);
  }
  const ground = brightness(reading.cards.find((c) => c.style === "heading")!.ground);
  if (Number.isFinite(ground)) {
    if (look.mode === "dark") expect(ground, "the heading card is dark in the dark look").toBeLessThan(0.5);
    else expect(ground, "the heading card is light in the light look").toBeGreaterThan(0.5);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. A heading, a paragraph and a divider through the dialog

const FLOWS = [
  { look: LIGHT, name: () => DASHBOARD, id: () => dashboardId },
  { look: DARK, name: () => DASHBOARD_DARK, id: () => darkId },
] as const;

for (const flow of FLOWS) {
  test(`1. ${flow.look.mode}: a heading, a paragraph and a divider added through the dialog are saved and are still there after a reload`, async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, flow.look);
    await openEditor(page, flow.id());
    await addText(page, "heading", HEADING, HEADING);
    await addText(page, "paragraph", PARAGRAPH, PARAGRAPH_TITLE);
    await addText(page, "divider", "", DIVIDER);
    for (const title of [HEADING, PARAGRAPH_TITLE, DIVIDER]) await expect(frameOf(page, title), `${title} is in the editor's grid`).toBeVisible();

    await button(page, "Save").click();
    await expect(button(page, "Edit")).toBeVisible(); // back in view mode
    await page.reload();
    await expect(button(page, "Edit")).toBeVisible();
    await expectTextCards(page, flow.name(), flow.look);

    const saved = await json<ApiDashboard>(page.request, `/api/dashboards/${flow.id()}`);
    expect(saved.widgets.map((w) => [w.type, w.title, w.config.style, w.config.text]), "what the API stored").toEqual([
      ["text", HEADING, "heading", HEADING],
      ["text", PARAGRAPH_TITLE, "paragraph", PARAGRAPH],
      ["text", DIVIDER, "divider", ""],
    ]);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. No data request

test("2. a page of text widgets asks widget-data for nothing, in view mode, in edit mode and with the preview on screen; a stat added after them asks for itself, and only it asks", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const seen = recordWidgetData(page);

  // View mode. A request, if the page made one, leaves at mount: wait until the cards are drawn and a little longer.
  await page.goto(`/dashboards/${dashboardId}`);
  await expectTextCards(page, DASHBOARD, LIGHT);
  await page.waitForTimeout(800);
  expect(seen, "view mode: no widget-data request").toEqual([]);

  // Edit mode.
  await button(page, "Edit").click();
  await expect(button(page, "Save")).toBeVisible();
  await expect(addButton(page)).toBeEnabled();
  for (const title of [HEADING, PARAGRAPH_TITLE, DIVIDER]) await expect(frameOf(page, title)).toBeVisible();
  await settled(page);
  await page.waitForTimeout(800);
  expect(seen, "edit mode: no widget-data request").toEqual([]);

  // The dialog, with a text preview on screen for longer than the 300 ms the preview of a data widget waits.
  const dialog = await openTextDialog(page);
  await fieldOf(dialog, "Text").fill("A note for the night shift");
  await expect(dialog.locator(".widget-preview")).toContainText("A note for the night shift");
  await page.waitForTimeout(800);
  expect(seen, "the text preview: no widget-data request").toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();

  // A stat (energy of one asset) is a data widget: it asks, and what it asks is a stat.
  await addButton(page).click();
  await expect(dialog).toBeVisible();
  await fieldOf(dialog, "Type").selectOption({ value: "stat" });
  await fieldOf(dialog, "Title").fill("w22 stat");
  await fieldOf(dialog, "Source").selectOption({ value: "energy" });
  await dialog.getByLabel("Search assets", { exact: true }).fill(assetName); // a row may sit under a folded branch: search first
  await dialog.getByRole("radio", { name: assetName, exact: true }).check();
  await expect(dialog.locator(".widget-preview .widget-frame")).toBeVisible();
  await expect(saveWidget(dialog)).toBeEnabled();
  await saveWidget(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(frameOf(page, "w22 stat")).toBeVisible();
  await page.waitForTimeout(1_000);
  // One request, or two: the dialog's preview asks, and the card that replaces it asks again when the first answer came back before the
  // card mounted (the query is stale at once, as for every data widget). That count depends on timing and is older than this wave; what
  // this case pins is that ONLY the stat asks, and that it asks for itself (never for the text cards).
  const stats = seen.filter((r) => r.type === "stat");
  expect(stats.length, `the stat asked: ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(1);
  expect(stats.length, `the stat asked: ${JSON.stringify(seen)}`).toBeLessThanOrEqual(2);
  expect(seen.length, "every request is the stat's").toBe(stats.length);
  expect(seen.filter((r) => r.type === "text"), "no request carried type text").toEqual([]);
  expect(seen.every((r) => r.method === "POST" && r.path === "/api/widget-data"), "the only route asked is POST /api/widget-data").toBe(true);

  // The stat was never saved: the dashboard is still the three text widgets.
  await discardEdits(page);
  const stored = await json<ApiDashboard>(page.request, `/api/dashboards/${dashboardId}`);
  expect(stored.widgets.map((w) => w.type)).toEqual(["text", "text", "text"]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. Edit mode: the card's chrome, a move, a resize to one row

test("3. in edit mode each text card has the grip, the title, Edit and Delete; a card moves by its title bar, the heading resizes to one row and still shows its text at 1024 x 640; the positions are saved", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await openEditor(page, dashboardId);

  for (const title of [HEADING, PARAGRAPH_TITLE, DIVIDER]) {
    const frame = frameOf(page, title);
    await expect(frame.locator(".widget-grip"), `${title}: the grip`).toBeVisible();
    await expect(frame.getByRole("heading", { level: 2, name: title, exact: true }), `${title}: the title`).toBeVisible();
    await expect(frame.getByRole("button", { name: `Edit ${title}`, exact: true }), `${title}: Edit`).toBeVisible();
    await expect(frame.getByRole("button", { name: `Delete ${title}`, exact: true }), `${title}: Delete`).toBeVisible();
    await expect(frame.getByRole("button", { name: /^Details for / }), `${title}: no Details button`).toHaveCount(0);
    await expect(frame.getByRole("button", { name: /^Download CSV for / }), `${title}: no CSV button`).toHaveCount(0);
  }

  // The cards sit one under the other: the heading and the paragraph 2 rows each, the divider 1.
  const heading0 = await boxOf(itemOf(page, HEADING), "the heading's cell");
  const paragraph0 = await boxOf(itemOf(page, PARAGRAPH_TITLE), "the paragraph's cell");
  expect(paragraph0.y, "the paragraph starts under the heading").toBeGreaterThan(heading0.y + heading0.height);

  // Move the paragraph by its title bar to the empty place right of the heading (6 columns across, 2 rows up), with real intermediate moves.
  const head = await boxOf(frameOf(page, PARAGRAPH_TITLE).locator(".widget-head"), "the paragraph's title bar");
  const grab = { x: head.x + 44, y: head.y + head.height / 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  try {
    await page.mouse.move(grab.x + 14, grab.y - 14, { steps: 4 });
    await page.mouse.move(grab.x + paragraph0.width + 10, grab.y - 2 * ROW, { steps: 14 });
    await expect(page.locator(".react-grid-placeholder"), "a drag shows the drop placeholder").toBeVisible();
  } finally {
    await page.mouse.up();
  }
  await expect.poll(async () => {
    const moved = await boxOf(itemOf(page, PARAGRAPH_TITLE), "the paragraph's cell");
    return { dx: Math.round(moved.x - (heading0.x + heading0.width + 10)), dy: Math.round(moved.y - heading0.y) };
  }, { message: "the paragraph stands right of the heading, on its row" }).toEqual({ dx: 0, dy: 0 });

  // Resize the heading from its south edge to ONE row (80 px): 90 px up.
  const handle = itemOf(page, HEADING).locator(".react-resizable-handle-s");
  await expect(handle).toHaveCount(1);
  const grip = await boxOf(handle, "the heading's south handle");
  const from = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  try {
    await page.mouse.move(from.x, from.y - 8, { steps: 3 });
    await page.mouse.move(from.x, from.y - ROW, { steps: 12 });
  } finally {
    await page.mouse.up();
  }
  await expect.poll(async () => Math.round((await boxOf(itemOf(page, HEADING), "the heading's cell")).height), { message: "the heading is one row high" }).toBe(80);

  // 1024 x 640: the one-row heading shows its text whole and keeps Edit and Delete inside the card.
  await page.setViewportSize({ width: 1024, height: 640 });
  await settled(page);
  const frame = frameOf(page, HEADING);
  await expect(frame).toBeVisible();
  const reading = await frame.evaluate((el) => {
    const body = el.querySelector<HTMLElement>(".widget-body")!;
    const text = el.querySelector<HTMLElement>(".widget-text-heading")!;
    const range = document.createRange();
    range.selectNodeContents(text);
    const rect = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
    return { card: rect(el.getBoundingClientRect()), body: rect(body.getBoundingClientRect()), text: rect(range.getBoundingClientRect()), clipped: body.scrollHeight - body.clientHeight, shown: text.textContent };
  });
  expect(reading.shown, "the heading's text").toBe(HEADING);
  expect(reading.card.height, "the card is one row high").toBeLessThanOrEqual(81);
  expect(inside(reading.text, reading.card), `the text ${JSON.stringify(reading.text)} lies inside the card ${JSON.stringify(reading.card)}`).toBe(true);
  expect(inside(reading.text, reading.body), `and inside the card's body ${JSON.stringify(reading.body)}`).toBe(true);
  expect(reading.clipped, "the body has nothing hidden below").toBeLessThanOrEqual(1);
  for (const name of [`Edit ${HEADING}`, `Delete ${HEADING}`]) {
    const buttonBox = await boxOf(frame.getByRole("button", { name, exact: true }), name);
    expect(inside(buttonBox, reading.card), `${name} lies inside the card`).toBe(true);
  }

  // Save, and read the positions back: from the API, then on screen after a reload.
  await page.setViewportSize({ width: 1440, height: 900 });
  await settled(page);
  await button(page, "Save").click();
  await expect(button(page, "Edit")).toBeVisible();
  const saved = await json<ApiDashboard>(page.request, `/api/dashboards/${dashboardId}`);
  const places = saved.widgets.map((w) => ({ title: w.title, x: w.x, y: w.y, w: w.w, h: w.h }));
  expect(places, "the stored places").toEqual([
    { title: HEADING, x: 0, y: 0, w: 6, h: 1 },
    { title: PARAGRAPH_TITLE, x: 6, y: 0, w: 6, h: 2 },
    { title: DIVIDER, x: 0, y: 2, w: 12, h: 1 },
  ]);

  await page.reload();
  await expectTextCards(page, DASHBOARD, LIGHT);
  const headingCell = await boxOf(page.locator(".dash-cell").filter({ has: page.getByRole("heading", { level: 2, name: HEADING, exact: true }) }), "the heading's cell");
  const paragraphCell = await boxOf(page.locator(".dash-cell").filter({ has: frameOf(page, PARAGRAPH_TITLE) }), "the paragraph's cell");
  expect(Math.abs(headingCell.height - 80), "after the reload the heading is one row high").toBeLessThanOrEqual(1);
  expect(Math.abs(paragraphCell.height - 170), "and the paragraph two").toBeLessThanOrEqual(1);
  expect(Math.abs(paragraphCell.x - (headingCell.x + headingCell.width + 10)), "the paragraph is right of the heading").toBeLessThanOrEqual(1);
  expect(Math.abs(paragraphCell.y - headingCell.y), "on the same row").toBeLessThanOrEqual(1);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. The dialog by keyboard

test("4. the dialog by keyboard: Enter opens it, Tab walks Type, Title, Style, Text, Cancel, Save widget; Escape closes the dialog and not the editor; an empty heading and a heading with a line break are refused", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await openEditor(page, dashboardId);
  const opener = addButton(page);
  const dialog = addDialog(page);
  const type = fieldOf(dialog, "Type");
  const title = fieldOf(dialog, "Title");
  const style = fieldOf(dialog, "Style");
  const text = fieldOf(dialog, "Text");

  await opener.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(title, "the focus starts on Title").toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(type, "Shift+Tab goes back to Type").toBeFocused();
  await page.keyboard.press("End"); // the last option of the list: Text
  await expect(type).toHaveValue("text");
  await page.keyboard.press("Tab");
  await expect(title, "Tab: Title").toBeFocused();
  await page.keyboard.press("Tab");
  await expect(style, "Tab: Style (a Text widget has it)").toBeFocused();
  await page.keyboard.press("Tab");
  await expect(text, "Tab: Text").toBeFocused();
  await page.keyboard.type("Hall B overview"); // a valid heading, so that Save widget can be reached
  await expect(saveWidget(dialog)).toBeEnabled();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true }), "Tab: Cancel").toBeFocused();
  await page.keyboard.press("Tab");
  await expect(saveWidget(dialog), "Tab: Save widget").toBeFocused();

  // Escape closes the dialog, not the editor, and the focus goes back to the button that opened it.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener, "the focus is back on Add widget").toBeFocused();
  await expect(button(page, "Save"), "the editor is still open").toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(frameOf(page, "Hall B overview"), "nothing was added").toHaveCount(0);

  // An empty heading: Save widget is disabled and the sentence says why.
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("End");
  await expect(type).toHaveValue("text");
  await expect(title).toHaveValue("Heading");
  await expect(saveWidget(dialog)).toBeDisabled();
  await expect(issuesOf(dialog)).toHaveText(["Enter the text."]);

  // A heading with a line break (Enter in the textarea): one line only.
  await text.focus();
  await page.keyboard.type("Line one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Line two");
  await expect(text).toHaveValue("Line one\nLine two");
  await expect(saveWidget(dialog)).toBeDisabled();
  await expect(issuesOf(dialog)).toHaveText(["A heading is one line."]);
  await expect(counterOf(dialog), "the count follows the text, line break included").toHaveText("17 of 200 characters");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(button(page, "Save"), "the editor is still open").toBeVisible();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. Counting

test("5. an emoji counts once, a paragraph counts against 2,000, and a divider has no Text field and the next free Divider title", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await openEditor(page, dashboardId);
  const dialog = await openTextDialog(page);
  const text = fieldOf(dialog, "Text");

  await text.fill(EMOJI.repeat(3));
  await expect(counterOf(dialog), "three emoji are three characters, not six").toHaveText("3 of 200 characters");
  await expect(text, "the counter is the Text field's description").toHaveAccessibleDescription("3 of 200 characters");
  await expect(saveWidget(dialog)).toBeEnabled();

  await fieldOf(dialog, "Style").selectOption({ value: "paragraph" });
  await expect(counterOf(dialog)).toHaveText("3 of 2,000 characters");

  // The dashboard already has a Divider: the next free name is Divider 2.
  await fieldOf(dialog, "Style").selectOption({ value: "divider" });
  await expect(fieldOf(dialog, "Text"), "a divider hides the Text field").toHaveCount(0);
  await expect(counterOf(dialog), "and its counter").toHaveCount(0);
  await expect(saveWidget(dialog), "a divider can be saved at once").toBeEnabled();
  await expect(fieldOf(dialog, "Title")).toHaveValue("Divider 2");
  await expect(issuesOf(dialog)).toHaveCount(0);

  // Back to a paragraph: the text typed before is still there.
  await fieldOf(dialog, "Style").selectOption({ value: "paragraph" });
  await expect(fieldOf(dialog, "Text")).toHaveValue(EMOJI.repeat(3));
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Without the existing Divider (deleted here, not saved) the first free name is Divider itself.
  await button(page, `Delete ${DIVIDER}`).click();
  await expect(frameOf(page, DIVIDER)).toHaveCount(0);
  const again = await openTextDialog(page);
  await fieldOf(again, "Style").selectOption({ value: "divider" });
  await expect(fieldOf(again, "Title")).toHaveValue(DIVIDER);
  await expect(saveWidget(again)).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(again).toBeHidden();

  await discardEdits(page);
  const stored = await json<ApiDashboard>(page.request, `/api/dashboards/${dashboardId}`);
  expect(stored.widgets.map((w) => w.title), "nothing of this case was saved").toEqual([HEADING, PARAGRAPH_TITLE, DIVIDER]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 6. The server refuses what the dialog never sends

test("6. the server refuses a NUL and a heading with a line break, keeps CRLF out of a saved paragraph, and answers 422 `no data` on both widget-data routes for a text widget", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const path = `/api/dashboards/${dashboardId}`;
  const before = await json<ApiDashboard>(page.request, path);
  const keep = before.widgets.map(({ title, type, x, y, w, h, config }) => ({ title, type, x, y, w, h, config }));
  const extra = (style: TextStyle, text: string) => ({ title: "w22 extra", type: "text", x: 0, y: 20, w: 6, h: 2, config: { style, text } });
  const save = (updated: string, widgets: object[]) => page.request.put(path, { data: { name: before.name, range: before.range, updated_at: updated, widgets } });
  const detailOf = async (response: Awaited<ReturnType<typeof save>>) => ((await response.json()) as { detail: string }).detail;

  // A NUL: 422, and the message names the field.
  const nul = await save(before.updated_at, [...keep, extra("paragraph", `a${String.fromCharCode(0)}b`)]);
  expect(nul.status(), "a NUL in a text is refused").toBe(422);
  expect(await detailOf(nul)).toMatch(/\btext\b.*control character/);
  // A heading with a CRLF inside is a heading with a line break.
  const crlfHeading = await save(before.updated_at, [...keep, extra("heading", "one\r\ntwo")]);
  expect(crlfHeading.status(), "a heading with a line break is refused").toBe(422);
  expect(await detailOf(crlfHeading)).toMatch(/\btext\b.*heading is one line/);
  const untouched = await json<ApiDashboard>(page.request, path);
  expect(untouched.updated_at, "the refused saves wrote nothing").toBe(before.updated_at);
  expect(untouched.widgets.length).toBe(before.widgets.length);

  // A paragraph saved with CRLF comes back with LF. The dashboard is put back as it was, whatever happens.
  let latest = before.updated_at;
  try {
    const accepted = await save(latest, [...keep, extra("paragraph", "first\r\nsecond")]);
    expect(accepted.ok(), `a paragraph with CRLF is accepted: ${accepted.status()} ${await accepted.text()}`).toBe(true);
    const stored = (await accepted.json()) as ApiDashboard;
    latest = stored.updated_at;
    const added = stored.widgets.find((w) => w.title === "w22 extra");
    expect(added?.config.text, "the stored paragraph has LF").toBe("first\nsecond");
    const reread = await json<ApiDashboard>(page.request, path);
    expect(reread.widgets.find((w) => w.title === "w22 extra")?.config.text).toBe("first\nsecond");
  } finally {
    const restored = await save(latest, keep);
    expect(restored.ok(), `putting the dashboard back: ${restored.status()} ${await restored.text()}`).toBe(true);
  }
  const after = await json<ApiDashboard>(page.request, path);
  expect(after.widgets.map(({ title, type, x, y, w, h, config }) => ({ title, type, x, y, w, h, config })), "the dashboard is as it was").toEqual(keep);

  // A text widget has no data: both routes refuse it, whatever else the request holds.
  for (const route of ["/api/widget-data", "/api/widget-data/csv"]) {
    const asked = await page.request.post(route, { data: { type: "text", config: { style: "heading", text: "x" }, range: "24h" } });
    expect(asked.status(), `POST ${route} with type text`).toBe(422);
    expect(await detailOf(asked), `POST ${route}`).toMatch(/no data/);
  }
});
