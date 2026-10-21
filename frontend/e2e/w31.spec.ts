import { expect, test, type APIRequestContext, type APIResponse, type Browser, type Locator, type Page } from "@playwright/test";
import { expectNoRowAction, rowAction } from "./shell";

// W31 (importing readings and mapping tags): a source of the type `file` is filled by importing CSV files. Its points come from a tag list, its readings from an import, and it is never polled. Admin `admin` / `correct-horse`.
// The contract is the plan docs/superpowers/plans/2026-10-21-w31-import-tags-and-governance.md (the amendments A1 to A13 override its D1 to D16) and the rulings of .waves/w31.md.
//
// IT MAKES ITS OWN DATA and needs nothing from the stack beyond the sign-in: beforeAll makes two sources through the API, a `file` source `W31 <run> file b` (it only ever gets dialogs opened on it, so it never holds a point) and a disabled
// `simulator` source `W31 <run> sim` (the simulator is the one connector that keeps history, so it is the one that offers Fill older range...); case 1 makes its own `file` source through the UI. Every name starts `W31 <run>`, the tag list
// makes the top-level asset `W31 <run>` with three meters under it, the import profile is `w31-<run>`, and the accounts and roles of case 2 start `w31-`. afterAll removes it all, each step on its own and also after a failed case (accounts
// first, then roles, sources, assets and profiles), and beforeAll sweeps what an earlier run left. The readings an import stores have no foreign key to their point: deleting the source leaves them (the same as every other delete of a source).
//   1  A FILE SOURCE FROM START TO UNDO. Add source: the connector `file` shows its description and no field of its own (no Secret: it has nothing to authenticate). Map tag list...: six lines (three meters, a kWh counter and a kW tag each, every line with
//      interval_seconds 3600, the spacing of the hourly series, which the dialog asks of a file source); the buttons of the dialog and of the Import dialog stay where they are when a report arrives (1 px); without "Create missing assets" every line is a problem
//      and Create stays off; ticking the box takes the report away (it counts only for what is in the dialog now); Check list counts 6 mappings, 4 assets and 6 points with no problem; Create 6 mappings closes the dialog and raises the toast "Created 6
//      mappings" with an Undo (not pressed). Import file...: 24 hourly rows of each of the 6 tags (UTC with Z, the last one one to two hours ago) plus one row for a tag the source does not have, one row with a value that is not a number and one exact
//      repeat of the first row. A new profile `w31-<run>` is named, its unit and quality columns are filled in (the dialog starts them empty), and Check file reads 147 rows, 144 new, 2 rejected and 1 unknown tag, with the unknown tag and the two reasons
//      listed in words; Import 144 rows stores them (the toast, the button reads Imported). A second dialog chooses the saved profile and the same file: 0 new, 144 already there, the button reads "Import 0 rows" and is off, and no audit row was written by the
//      check; a real import of the same file through the API stores nothing new either. Then the Audit page: the `tags.mapped` entry opens in its drawer, "Undo this tag list" removes 6 mappings and 4 assets and says that the 6 points stay because they hold
//      readings; the same drawer's button waits; the drawer opened again answers "already undone" in place. The Points page and the API show the 6 points, unmapped.
//   2  PERMISSIONS. A role with only `sources.view` has no Actions menu at all (and the three routes answer 403); `sources.view`, `sources.edit` and `discovery.accept` sees Map tag list... but not Import file...; `sources.view` and `readings.import`
//      sees Import file... and nothing else. Fill older range... needs `sources.edit` and a connector that keeps history.
//   3  KEYBOARD AND FOCUS. Import file... and Map tag list... are opened from the keyboard (Enter on the menu button, the arrows, Enter): focus lands on the file chooser and on the textarea, Shift+Tab from there goes to the last control and Tab from it
//      back to the first, Escape closes the dialog and the focus is on the row's menu button again.
//   4  FILL OLDER RANGE. Only the simulator source offers it; the dialog opens with the focus on Start date; a range 400 days back is refused in the server's words (nothing older than ... the raw retention), so is one of 51 days (at most 31 days at a
//      time); Start fill stays off and no real fill request is sent.
//   5  THE FILE SOURCE NEVER POLLS. Its status reads "filled by file import", never online or offline; its history line reads "Filled by importing files"; its row menu has no Test and no Check connection (the simulator's has both); its Points page has no Browse
//      points button and says where its points come from.
// Playwright matches names by SUBSTRING and case-insensitively, so every lookup is `exact: true` where a name is part of another ("File" is inside "Profile", "Tag list" inside "Map tag list: ...", "Undo" inside "Undo this tag list"), and every lookup is
// scoped to its dialog or drawer. Assertions that depend on the browser or on timing, which nobody could check while writing this, are listed in the commit's status block.

// The cases do not depend on each other (case 1 makes its own source, the others use the two beforeAll made), so a failing case does not hide the ones after it.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";

const RUN = Date.now().toString(36);
/** A name that belongs to this run. */
const name = (what: string): string => `W31 ${RUN} ${what}`;
/** What an earlier run that stopped half way may have left behind: `W31 ` and a run id (Date.now() in base 36 is 8 characters until 2059). The tag list's top-level asset is `W31 <run>` itself. */
const LEFTOVER = /^W31 [0-9a-z]{8}( |$)/;

const ONE = name("file one");
const FILE_B = name("file b");
const SIM = name("sim");
const ROOT = `W31 ${RUN}`;
const PROFILE = `w31-${RUN}`;
const PASSWORD = `w31-${RUN}-password`;
const FILE_DESCRIPTION = /Filled by importing CSV files/;

/** The row menu's words (three plain dots, not the ellipsis character). */
const MENU = { import: "Import file...", map: "Map tag list...", fill: "Fill older range..." } as const;

// ---------------------------------------------------------------------------------------------------------------------------------
// What the files hold

interface Tag { tag: string; meter: string; metric: string; unit: string }
const METERS = ["Meter 01", "Meter 02", "Meter 03"];
/** W31A-001 is the kWh counter of Meter 01, W31A-002 its kW tag, W31A-003 the kWh counter of Meter 02 ... */
const TAGS: Tag[] = METERS.flatMap((meter, i) => [
  { tag: `W31A-00${2 * i + 1}`, meter, metric: "energy_kwh", unit: "kWh" },
  { tag: `W31A-00${2 * i + 2}`, meter, metric: "active_power_kw", unit: "kW" },
]);
const UNKNOWN_TAG = "W31X-999";
const HOUR = 3_600_000;
const HOURS = 24;
/** Rows read: every non-blank line after the header, the three bad ones included. New: the 24 hours of each tag. Rejected: the value that is not a number and the exact repeat. */
const READ = TAGS.length * HOURS + 3;
const NEW = TAGS.length * HOURS;
const REJECTED = 2;
/** Mappings, new assets (the root and one per meter) and points that the tag list creates. */
const MAPPINGS = TAGS.length;
const ASSETS = METERS.length + 1;

const isoZ = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The spacing of the generated series in seconds: it is hourly. A `file` source's tag list must give it on every active_power_kw line (the engine works a power-only meter's energy out from it); the dialog says so. */
const INTERVAL_SECONDS = 3600;

/** `tag,asset,metric,unit,interval_seconds`: the first line names the columns, then one line per tag. The root asset `W31 <run>` does not exist yet, so the list needs "Create missing assets". */
function tagListText(): string {
  return ["tag,asset,metric,unit,interval_seconds", ...TAGS.map((t) => `${t.tag},${ROOT} / ${t.meter},${t.metric},${t.unit},${INTERVAL_SECONDS}`)].join("\n") + "\n";
}

/** 24 hourly rows of every tag, UTC with Z, from 25 to 2 hours before `nowMs` (the last one is the hour before the current one), then three bad rows. */
function readingsCsv(nowMs: number): string {
  const first = Math.floor(nowMs / HOUR) * HOUR - HOURS * HOUR;
  const rows = ["tag,timestamp,value,unit,quality"];
  TAGS.forEach((t, k) => {
    for (let h = 0; h < HOURS; h++) {
      const value = t.unit === "kWh" ? 1000 + 10 * k + 1.5 * h : 20 + k + (h % 6);
      rows.push(`${t.tag},${isoZ(first + h * HOUR)},${value.toFixed(3)},${t.unit},good`);
    }
  });
  rows.push(rows[1]); // an exact repeat of the first data line
  rows.push(`${UNKNOWN_TAG},${isoZ(first + 2 * HOUR + 15 * 60_000)},1.5,kWh,good`); // a tag the source does not have
  rows.push(`${TAGS[0].tag},${isoZ(first + 3 * HOUR + 30 * 60_000)},not-a-number,kWh,good`); // a value that is not a number
  return rows.join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The API shapes this spec reads (written here, so a change of the server shows up as a failure)

interface ApiSource { id: number; name: string }
interface ApiAsset { id: number; parent_id: number | null; name: string }
interface ApiPoint { id: number; address: string; mapping: unknown }
interface ApiAudit { id: number; action: string; detail: Record<string, unknown> }
interface ApiUser { id: number; username: string }
interface ApiRole { id: number; name: string; builtin: boolean }
interface ImportAnswer { new: number; already: number; differing: number; complete: boolean; sha256: string }

async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
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

/** Runs `use` with a page of a fresh browser context in which `who` is signed in (the project's window size does not reach a context made by hand). */
async function asAccount<T>(browser: Browser, who: { username: string }, use: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 } });
  try {
    const login = await context.request.post("/api/login", { data: { username: who.username, password: PASSWORD } });
    expect(login.ok(), `${who.username} signs in: ${login.status()} ${await login.text()}`).toBe(true);
    return await use(await context.newPage());
  } finally {
    await context.close();
  }
}

async function signIn(page: Page): Promise<void> {
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in: ${login.status()} ${await login.text()}`).toBe(true);
}

async function createSource(request: APIRequestContext, body: Record<string, unknown>): Promise<number> {
  const made = await request.post("/api/sources", { data: { secret: null, ...body } });
  expect(made.status(), `creating ${String(body.name)}: ${made.status()} ${await made.text()}`).toBe(201);
  return ((await made.json()) as ApiSource).id;
}

async function sourceId(request: APIRequestContext, sourceName: string): Promise<number> {
  const found = (await json<ApiSource[]>(request, "/api/sources")).find((s) => s.name === sourceName);
  expect(found, `the source ${sourceName} exists`).toBeDefined();
  return found!.id;
}

async function auditRows(request: APIRequestContext, action: string): Promise<ApiAudit[]> {
  return (await json<{ items: ApiAudit[] }>(request, `/api/audit?action=${action}&limit=200`)).items;
}

/**
 * Everything this spec may have made, in the order that works: accounts, roles, sources (their mappings go with them), the tag list's assets, the saved profiles.
 * `accountsOnly` stops after the roles (case 2 removes its own accounts and leaves the sources the other cases use). Each step on its own; the problems are raised at the end.
 */
async function removeMine(request: APIRequestContext, accountsOnly = false): Promise<void> {
  const problems: string[] = [];
  const gone = async (what: string, call: () => Promise<APIResponse>): Promise<void> => {
    try {
      const response = await call();
      if (![200, 204, 404].includes(response.status())) problems.push(`${what}: ${response.status()} ${await response.text()}`);
    } catch (error) {
      problems.push(`${what}: ${String(error)}`);
    }
  };
  const list = async <T>(path: string): Promise<T[]> => {
    try {
      return await json<T[]>(request, path);
    } catch (error) {
      problems.push(`listing ${path}: ${String(error)}`);
      return [];
    }
  };
  for (const user of (await list<ApiUser>("/api/users")).filter((u) => u.username.startsWith("w31-"))) await gone(`user ${user.username}`, () => request.delete(`/api/users/${user.id}`));
  for (const role of (await list<ApiRole>("/api/roles")).filter((r) => !r.builtin && r.name.startsWith("w31-"))) await gone(`role ${role.name}`, () => request.delete(`/api/roles/${role.id}`));
  if (accountsOnly) {
    expect(problems, "the accounts and roles of this spec were removed").toEqual([]);
    return;
  }
  for (const source of (await list<ApiSource>("/api/sources")).filter((s) => LEFTOVER.test(s.name))) await gone(`source ${source.name}`, () => request.delete(`/api/sources/${source.id}?confirm=true`));
  for (const asset of (await list<ApiAsset>("/api/assets")).filter((a) => a.parent_id === null && LEFTOVER.test(a.name))) await gone(`asset ${asset.name}`, () => request.delete(`/api/assets/${asset.id}?confirm=true`));
  try {
    const profiles = (await json<{ profiles: { name: string }[] }>(request, "/api/import-profiles")).profiles;
    for (const profile of profiles.filter((p) => p.name.startsWith("w31-"))) await gone(`profile ${profile.name}`, () => request.delete(`/api/import-profiles/${encodeURIComponent(profile.name)}`));
  } catch (error) {
    problems.push(`listing the import profiles: ${String(error)}`);
  }
  expect(problems, "everything this spec made was removed").toEqual([]);
}

const ids = { fileB: 0, sim: 0 };

test.beforeAll(async ({ browser }) => {
  await asAdmin(browser, async (request) => {
    await removeMine(request); // what an earlier run that stopped half way left behind (the accounts of case 2 as well)
    ids.fileB = await createSource(request, { name: FILE_B, connector_type: "file", config: {}, enabled: true });
    ids.sim = await createSource(request, { name: SIM, connector_type: "simulator", config: { url: "http://simulator:9000" }, enabled: false });
  });
});

test.afterAll(async ({ browser }) => {
  await asAdmin(browser, (request) => removeMine(request));
});

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Locators

const heading1 = (page: Page, text: string) => page.getByRole("heading", { level: 1, name: text, exact: true });
/** A Sources row, found by the title of its name cell (the cell holds a second line, the history line, so the cell's own name is not the source's). */
const sourceRow = (page: Page, sourceName: string) => page.getByRole("row").filter({ has: page.locator(`.cell-name[title="${sourceName}"]`) });
const actionsOf = (row: Locator) => row.getByRole("button", { name: /^Actions for / });
const toastWith = (page: Page, text: string) => page.locator(".toast-stack .toast").filter({ hasText: text });
const importDialog = (page: Page, sourceName: string) => page.getByRole("dialog", { name: `Import readings: ${sourceName}`, exact: true });
const tagDialog = (page: Page, sourceName: string) => page.getByRole("dialog", { name: `Map tag list: ${sourceName}`, exact: true });
const fillDialog = (page: Page, sourceName: string) => page.getByRole("dialog", { name: `Fill an older range: ${sourceName}`, exact: true });
const auditDrawer = (page: Page) => page.getByRole("dialog", { name: "Audit entry", exact: true });

async function openSources(page: Page): Promise<void> {
  await page.goto("/sources");
  await expect(heading1(page, "Sources")).toBeVisible();
}

/** Opens the row's menu with the mouse, reads the names of its items, and closes it again. */
async function menuItems(page: Page, row: Locator): Promise<string[]> {
  const trigger = actionsOf(row);
  const label = await trigger.getAttribute("aria-label");
  expect(label, "the row has an Actions button").toBeTruthy();
  await trigger.click();
  const menu = page.getByRole("menu", { name: label!, exact: true });
  await expect(menu).toBeVisible();
  const items = (await menu.getByRole("menuitem").allTextContents()).map((text) => text.trim());
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  return items;
}

/** Enter on the row's menu button, the arrow keys down to `item`, Enter. Returns the menu button (the dialog gives the focus back to it). */
async function chooseByKeyboard(page: Page, row: Locator, item: string): Promise<Locator> {
  const trigger = actionsOf(row);
  const label = (await trigger.getAttribute("aria-label")) ?? "";
  await page.mouse.move(0, 0); // a pointer over the button would open the menu by hover
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: label, exact: true });
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitem");
  await expect(items.first(), "Enter puts the focus on the first item").toBeFocused();
  const target = menu.getByRole("menuitem", { name: item, exact: true });
  const count = await items.count();
  for (let step = 0; step < count; step++) {
    if (await target.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(target).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  return trigger;
}

/** The report tile `dt` -> `dd` of the tag list dialog. */
const tile = (report: Locator, title: string) => report.locator(".taglist-tiles > div").filter({ hasText: title }).locator("dd");

/** The top edge, in px from the window's top, of the one element each selector finds inside `dialog`. */
async function tops(dialog: Locator, selectors: string[]): Promise<number[]> {
  const edges: number[] = [];
  for (const selector of selectors) {
    const box = await dialog.locator(selector).boundingBox();
    expect(box, `${selector} is on screen`).not.toBeNull();
    edges.push(box!.y);
  }
  return edges;
}

/** A report that arrives late must not move the buttons: the one just pressed would slide out from under the pointer. 1 px of rounding is allowed. */
function expectStill(selectors: string[], before: number[], after: number[], when: string): void {
  selectors.forEach((selector, i) => {
    expect(Math.abs(after[i] - before[i]), `${selector} ${when}: it was at y=${before[i]} and is at y=${after[i]}`).toBeLessThanOrEqual(1);
  });
}

/** A day for a date input (yyyy-mm-dd), `daysAgo` days before today in the browser's zone. */
function dayInput(daysAgo: number): string {
  const moment = new Date();
  moment.setDate(moment.getDate() - daysAgo);
  return `${moment.getFullYear()}-${String(moment.getMonth() + 1).padStart(2, "0")}-${String(moment.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. A file source, a tag list, a dry run, an import, a second import, an Undo

test("1. a file source: a tag list is checked and created, a file is checked and imported twice, and the Undo takes the mappings back", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 }); // the size the button positions below are measured at
  const csv = readingsCsv(Date.now());
  const fileName = `w31-${RUN}.csv`;
  let id = 0;
  let auditId = 0;

  await test.step("Add source: the connector `file` shows its description and has no field of its own", async () => {
    await openSources(page);
    await page.getByRole("button", { name: "Add source", exact: true }).click();
    const add = page.getByRole("dialog", { name: "Add source", exact: true });
    await expect(add.getByLabel("Name", { exact: true })).toBeVisible(); // the connector list has loaded
    const connector = add.getByLabel(/^Connector/);
    await connector.selectOption("file");
    await expect(add.getByText(FILE_DESCRIPTION)).toBeVisible();
    await expect(connector, "the select is described by it").toHaveAccessibleDescription(FILE_DESCRIPTION);
    await expect(add.getByLabel(/^Url/i), "a file source has no address to fill in").toHaveCount(0);
    await expect(add.locator("input:not([type=checkbox]):not([type=password])"), "the name is the only text field").toHaveCount(1);
    await expect(add.getByLabel("Secret", { exact: true }), "a file reaches nothing, so it has nothing to authenticate").toHaveCount(0);
    await expect(add.locator("input[type=password]")).toHaveCount(0);
    await add.getByLabel("Name", { exact: true }).fill(ONE);
    await add.getByRole("button", { name: "Save", exact: true }).click();
    await expect(add).toBeHidden();
    await expect(sourceRow(page, ONE)).toBeVisible();
    id = await sourceId(page.request, ONE);
  });

  const tags = tagDialog(page, ONE);
  const report = tags.getByRole("region", { name: "Result of the check", exact: true });
  const status = tags.locator(".taglist-status");
  /** Cancel, Check list and Create: the three buttons of the dialog's foot. */
  const footButtons = ["button.taglist-cancel", "button.taglist-check", "button.taglist-go"];

  await test.step("Map tag list...: without 'Create missing assets' every line is a problem, and ticking the box takes the report away", async () => {
    await (await rowAction(page, sourceRow(page, ONE), MENU.map)).click();
    await expect(tags).toBeVisible();
    await tags.getByLabel("Tag list", { exact: true }).fill(tagListText());
    const waiting = await tops(tags, footButtons);
    await tags.getByRole("button", { name: "Check list", exact: true }).click();
    await expect(status).toContainText(`${TAGS.length} lines to fix`);
    await expect(report.getByRole("heading", { name: "Problem lines", exact: true })).toBeVisible();
    await expect(report).toContainText("does not exist");
    expectStill(footButtons, waiting, await tops(tags, footButtons), "after a report with problem lines arrived");
    await expect(tags.getByRole("button", { name: "Create mappings", exact: true }), "nothing can be created from a list with problems").toHaveAttribute("aria-disabled", "true");

    await tags.getByRole("checkbox", { name: "Create missing assets" }).check();
    await expect(report, "the report counts only for what is in the dialog now").toContainText("Press Check list");
    await expect(report.getByRole("heading", { name: "Problem lines", exact: true })).toHaveCount(0);
  });

  await test.step("Check list: the report counts the mappings, the assets and the points, with no problem", async () => {
    const waiting = await tops(tags, footButtons);
    await tags.getByRole("button", { name: "Check list", exact: true }).click();
    await expect(status).toContainText(`Would create ${MAPPINGS} mappings, ${ASSETS} assets and ${TAGS.length} points`);
    await expect(report.getByRole("heading", { name: "New assets", exact: true })).toBeVisible();
    expectStill(footButtons, waiting, await tops(tags, footButtons), "after the clean report arrived");
    await expect(status).toContainText("Nothing is created until you press Create");
    await expect(tile(report, "Points to create")).toHaveText(String(TAGS.length));
    await expect(tile(report, "Assets to create")).toHaveText(String(ASSETS));
    await expect(tile(report, "Mappings to create")).toHaveText(String(MAPPINGS));
    await expect(report.getByRole("heading", { name: "Problem lines", exact: true })).toHaveCount(0);
    await expect(report.getByRole("heading", { name: "New assets", exact: true })).toBeVisible();
    await expect(report.locator(".taglist-paths li"), "the root and one asset per meter").toHaveCount(ASSETS);
    await expect(report.locator(".taglist-paths li", { hasText: `${ROOT} / ${METERS[0]}` })).toHaveCount(1);
  });

  await test.step(`Create ${MAPPINGS} mappings: the dialog closes and the toast offers an Undo`, async () => {
    const create = tags.getByRole("button", { name: `Create ${MAPPINGS} mappings`, exact: true });
    await expect(create).not.toHaveAttribute("aria-disabled", "true");
    const answered = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/sources\/\d+\/tag-list\?/.test(r.url()) && r.url().includes("dry_run=0"));
    await create.click();
    const done = (await (await answered).json()) as { audit_id: number | null; mappings_to_create: number };
    expect(done.mappings_to_create, "the real run created the mappings it was shown").toBe(MAPPINGS);
    expect(done.audit_id, "the run wrote the audit row the Undo works on").not.toBeNull();
    auditId = done.audit_id!;
    await expect(tags).toBeHidden();
    await expect(actionsOf(sourceRow(page, ONE)), "the focus went back to the row's menu button").toBeFocused();
    const created = toastWith(page, `Created ${MAPPINGS} mappings`);
    await expect(created).toBeVisible();
    await expect(created.getByRole("button", { name: "Undo", exact: true })).toHaveAttribute("title", "Undo this tag list");
    await created.getByRole("button", { name: "Dismiss notification" }).click(); // the Undo is not pressed here: this spec's Undo is the Audit drawer's
    await expect(created).toBeHidden();
  });

  await test.step("the Points page lists the six points, mapped", async () => {
    await page.goto(`/sources/${id}/points`);
    await expect(heading1(page, "Points")).toBeVisible();
    const rows = page.locator("tbody tr[data-point]");
    await expect(rows).toHaveCount(TAGS.length);
    await expect(rows.filter({ hasText: "unmapped" })).toHaveCount(0);
  });

  const dialog = importDialog(page, ONE);
  const sentence = dialog.locator(".import-sentence").first();

  await test.step("Import file...: a new profile, Check file reads the counts and lists what was left out, Import stores the new rows", async () => {
    await openSources(page);
    await (await rowAction(page, sourceRow(page, ONE), MENU.import)).click();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("File", { exact: true }).setInputFiles({ name: fileName, mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
    await expect(dialog).toContainText(`${fileName} (`);
    await dialog.getByLabel("Profile name", { exact: true }).fill(PROFILE);
    // The dialog starts with the unit and the quality column empty: the file has both.
    await expect(dialog.getByLabel("Tag column", { exact: true })).toHaveValue("tag");
    await expect(dialog.getByLabel("Time column", { exact: true })).toHaveValue("timestamp");
    await expect(dialog.getByLabel("Value column", { exact: true })).toHaveValue("value");
    await dialog.getByLabel("Unit column (optional)", { exact: true }).fill("unit");
    await dialog.getByLabel("Quality column (optional)", { exact: true }).fill("quality");

    await dialog.getByRole("button", { name: "Check file", exact: true }).click();
    await expect(sentence).toContainText(`Checked: ${READ} rows read, ${NEW} new, 0 already there, 0 differing, ${REJECTED} rejected`);
    await expect(sentence).toContainText("Nothing is stored until you import");
    await expect(dialog).toContainText(`Profile "${PROFILE}" saved before the check.`);
    await expect(dialog.getByText("Tags this source does not have", { exact: true })).toBeVisible();
    await expect(dialog.locator(".import-cell", { hasText: UNKNOWN_TAG })).toHaveCount(1);
    await expect(dialog.getByText("Rows that were not accepted", { exact: true })).toBeVisible();
    await expect(dialog.getByText("The value is not a number: 1 row", { exact: true })).toBeVisible();
    await expect(dialog.getByText("The same reading is in the file more than once: 1 row", { exact: true })).toBeVisible();

    const go = dialog.getByRole("button", { name: `Import ${NEW} rows`, exact: true });
    await expect(go).not.toHaveAttribute("aria-disabled", "true");
    await go.click();
    await expect(sentence).toContainText(`Imported: ${READ} rows read, ${NEW} new, 0 already there, 0 differing, ${REJECTED} rejected`);
    await expect(dialog.getByRole("button", { name: "Imported", exact: true }), "an import that is done cannot be pressed again").toHaveAttribute("aria-disabled", "true");
    await expect(toastWith(page, `Imported ${NEW} rows into ${ONE}`)).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step("the same file again: the saved profile is chosen, Check file finds 0 new and Import 0 rows is off, and nothing is stored", async () => {
    const before = (await auditRows(page.request, "readings.imported")).filter((e) => e.detail.source_id === id);
    expect(before, "one import so far").toHaveLength(1);
    await (await rowAction(page, sourceRow(page, ONE), MENU.import)).click();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("File", { exact: true }).setInputFiles({ name: fileName, mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
    await dialog.getByLabel("Profile", { exact: true }).selectOption(PROFILE);
    const footButtons = ["button.import-close", "button.import-check", "button.import-go"];
    const waiting = await tops(dialog, footButtons);
    await dialog.getByRole("button", { name: "Check file", exact: true }).click();
    await expect(sentence).toContainText(`Checked: ${READ} rows read, 0 new, ${NEW} already there, 0 differing, ${REJECTED} rejected`);
    await expect(dialog.getByText("There is nothing new to import from this file.", { exact: true })).toBeVisible();
    // The report holds the unknown tag and the reasons for the two rejected rows, so it is the long kind: Check file, just pressed, must be where it was (the report's room is reserved, not a minimum).
    expectStill(footButtons, waiting, await tops(dialog, footButtons), "after the report of the check arrived");
    await expect(dialog.getByRole("button", { name: "Import 0 rows", exact: true })).toHaveAttribute("aria-disabled", "true");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();

    const after = (await auditRows(page.request, "readings.imported")).filter((e) => e.detail.source_id === id);
    expect(after, "a check writes no audit row").toHaveLength(1);

    // The server agrees: the same file imported for real stores nothing new.
    const headers = { "Content-Type": "text/csv" };
    const checked = await page.request.post(`/api/sources/${id}/import?profile=${encodeURIComponent(PROFILE)}&dry_run=1`, { headers, data: csv });
    expect(checked.status(), await checked.text()).toBe(200);
    const sha = ((await checked.json()) as ImportAnswer).sha256;
    const again = await page.request.post(`/api/sources/${id}/import?profile=${encodeURIComponent(PROFILE)}&dry_run=0&expect_sha256=${sha}`, { headers, data: csv });
    expect(again.status(), await again.text()).toBe(200);
    const answer = (await again.json()) as ImportAnswer;
    expect({ complete: answer.complete, new: answer.new, already: answer.already, differing: answer.differing }, "nothing new is stored").toEqual({ complete: true, new: 0, already: NEW, differing: 0 });
  });

  await test.step("the Audit page: the entry opens in its drawer, Undo this tag list takes the mappings and the assets back and keeps the points", async () => {
    await page.goto("/audit?action=tags.mapped");
    await expect(heading1(page, "Audit log")).toBeVisible();
    const chevron = page.locator(`.audit-table tr[data-entry-id="${auditId}"]`).getByRole("button", { name: `Details of entry #${auditId}`, exact: true });
    await chevron.click();
    const drawer = auditDrawer(page);
    await expect(drawer).toBeVisible();
    await expect(drawer.locator("dd .what")).toContainText("Mapped a tag list");
    await expect(drawer.locator("dd .what")).toContainText(`${MAPPINGS} mappings`);
    const undo = drawer.getByRole("button", { name: "Undo this tag list", exact: true });
    await expect(undo).not.toHaveAttribute("aria-disabled", "true");
    await undo.click();
    // The server's sentence: the assets and mappings go, the points stay because the import gave them readings.
    await expect(drawer.locator(".audit-undo-slot")).toContainText(`Removed ${MAPPINGS} mappings, ${ASSETS} assets and 0 points.`);
    await expect(drawer.locator(".audit-undo-slot"), "the points hold readings, so they stay").toContainText(`${TAGS.length} points stay because they hold readings.`);
    await expect(undo, "the button waits once the Undo is done").toHaveAttribute("aria-disabled", "true");

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await chevron.click();
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: "Undo this tag list", exact: true }).click();
    await expect(drawer.getByRole("alert"), "a second Undo of the same list is refused in place").toContainText(/already undone/i);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });

  await test.step("afterwards: the six points are still there, unmapped, and the assets are gone", async () => {
    await page.goto(`/sources/${id}/points`);
    await expect(heading1(page, "Points")).toBeVisible();
    const rows = page.locator("tbody tr[data-point]");
    await expect(rows).toHaveCount(TAGS.length);
    await expect(rows.filter({ hasText: "unmapped" })).toHaveCount(TAGS.length);
    const points = await json<ApiPoint[]>(page.request, `/api/sources/${id}/points`);
    expect(points.map((p) => p.address).sort(), "the points stay: they hold readings").toEqual(TAGS.map((t) => t.tag).sort());
    expect(points.every((p) => p.mapping === null), "and none of them is mapped").toBe(true);
    const roots = (await json<ApiAsset[]>(page.request, "/api/assets")).filter((a) => a.parent_id === null && a.name === ROOT);
    expect(roots, "the assets the list created are gone").toHaveLength(0);
    expect((await auditRows(page.request, "tags.unmapped")).filter((e) => e.detail.audit_id === auditId), "one Undo, one audit row").toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. Permissions

test("2. permissions: Import file..., Map tag list... and Fill older range... follow readings.import, discovery.accept and sources.edit", async ({ browser }) => {
  test.setTimeout(240_000);
  const accounts = [
    { username: "w31-viewer", role: "w31-viewer", permissions: ["sources.view"] },
    { username: "w31-mapper", role: "w31-mapper", permissions: ["sources.view", "sources.edit", "discovery.accept"] },
    { username: "w31-importer", role: "w31-importer", permissions: ["sources.view", "readings.import"] },
  ];
  await asAdmin(browser, async (request) => {
    for (const account of accounts) {
      const role = await request.post("/api/roles", { data: { name: account.role, description: "made by w31.spec.ts", permissions: account.permissions } });
      expect(role.status(), `creating the role ${account.role}: ${await role.text()}`).toBe(201);
      const user = await request.post("/api/users", { data: { username: account.username, password: PASSWORD, role: account.role } });
      expect(user.status(), `creating the account ${account.username}: ${await user.text()}`).toBe(201);
    }
  });
  const tagListBody = { headers: { "Content-Type": "text/csv" }, data: "tag,asset,metric\n" };
  const range = { start: "2026-01-01T00:00:00+00:00", end: "2026-01-02T00:00:00+00:00" };
  /** The three routes behind the three menu items, called with the account's own session: 403 for the ones it lacks. */
  const refused = async (who: Page, lacks: { import: boolean; map: boolean; fill: boolean }) => {
    const calls = [
      ["import", () => who.request.post(`/api/sources/${ids.fileB}/import?profile=${PROFILE}&dry_run=1`, tagListBody), lacks.import],
      ["tag list", () => who.request.post(`/api/sources/${ids.fileB}/tag-list?dry_run=1`, tagListBody), lacks.map],
      ["fill", () => who.request.post(`/api/sources/${ids.sim}/history/fill?dry_run=1`, { data: range }), lacks.fill],
    ] as const;
    for (const [what, call, lacking] of calls) {
      if (!lacking) continue;
      const response = await call();
      expect(response.status(), `${what} without the permission: ${await response.text()}`).toBe(403);
    }
  };

  try {
    await test.step("only sources.view: the rows have no Actions menu at all, and the three routes say 403", async () => {
      await asAccount(browser, accounts[0], async (view) => {
        await openSources(view);
        for (const sourceName of [FILE_B, SIM]) {
          await expect(sourceRow(view, sourceName)).toBeVisible();
          await expect(actionsOf(sourceRow(view, sourceName)), `no menu on ${sourceName}: nothing in it is allowed`).toHaveCount(0);
        }
        await expect(view.getByRole("button", { name: "Add source", exact: true })).toHaveCount(0);
        await refused(view, { import: true, map: true, fill: true });
      });
    });

    await test.step("sources.view, sources.edit and discovery.accept: Map tag list... (and Fill older range... on the simulator), not Import file...", async () => {
      await asAccount(browser, accounts[1], async (mapper) => {
        await openSources(mapper);
        const onFile = await menuItems(mapper, sourceRow(mapper, FILE_B));
        expect(onFile, "the file source's menu").toContain(MENU.map);
        expect(onFile).not.toContain(MENU.import);
        expect(onFile, "a connector that keeps no history has no fill").not.toContain(MENU.fill);
        const onSim = await menuItems(mapper, sourceRow(mapper, SIM));
        expect(onSim, "the simulator's menu").toContain(MENU.map);
        expect(onSim).toContain(MENU.fill);
        expect(onSim).not.toContain(MENU.import);
        await refused(mapper, { import: true, map: false, fill: false });
      });
    });

    await test.step("sources.view and readings.import: Import file... and nothing else", async () => {
      await asAccount(browser, accounts[2], async (importer) => {
        await openSources(importer);
        const onFile = await menuItems(importer, sourceRow(importer, FILE_B));
        expect(onFile, "the file source's menu").toContain(MENU.import);
        for (const missing of [MENU.map, MENU.fill, "Edit"]) expect(onFile).not.toContain(missing);
        const onSim = await menuItems(importer, sourceRow(importer, SIM));
        expect(onSim, "the simulator's menu").toContain(MENU.import);
        for (const missing of [MENU.map, MENU.fill, "Edit"]) expect(onSim).not.toContain(missing);
        await refused(importer, { import: false, map: true, fill: true });
      });
    });
  } finally {
    await asAdmin(browser, (request) => removeMine(request, true)); // the accounts first, then the roles: the names start `w31-`
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. Keyboard and focus

test("3. keyboard: Import file... and Map tag list... open from the menu by keys, the focus lands inside, Tab wraps, Escape closes and the focus returns", async ({ page }) => {
  test.setTimeout(180_000);
  await openSources(page);
  const row = sourceRow(page, FILE_B);
  await expect(row).toBeVisible();

  await test.step("Import file...: the focus is on the file chooser, Shift+Tab goes to the last control and Tab back, Escape returns to the menu button", async () => {
    const trigger = await chooseByKeyboard(page, row, MENU.import);
    const dialog = importDialog(page, FILE_B);
    await expect(dialog).toBeVisible();
    const chooser = dialog.getByLabel("File", { exact: true });
    await expect(chooser, "the focus lands on the file chooser").toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.locator("button.import-go"), "Shift+Tab from the first control goes to the last").toBeFocused();
    await page.keyboard.press("Tab");
    await expect(chooser, "Tab from the last control goes to the first").toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger, "the focus is on the row's menu button again").toBeFocused();
  });

  await test.step("Map tag list...: the focus is on the textarea, Tab wraps both ways, Escape returns to the menu button", async () => {
    const trigger = await chooseByKeyboard(page, row, MENU.map);
    const dialog = tagDialog(page, FILE_B);
    await expect(dialog).toBeVisible();
    const area = dialog.getByLabel("Tag list", { exact: true });
    await expect(area, "the focus lands on the textarea").toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.locator("button.taglist-go"), "Shift+Tab from the first control goes to the last").toBeFocused();
    await page.keyboard.press("Tab");
    await expect(area, "Tab from the last control goes to the first").toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger, "the focus is on the row's menu button again").toBeFocused();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. Fill older range

test("4. Fill older range...: only where the connector keeps history, and a range the server refuses is refused in its words", async ({ page }) => {
  test.setTimeout(180_000);
  const fills: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/history/fill") && !request.url().includes("dry_run=1")) fills.push(request.url());
  });
  await openSources(page);
  const fileRow = sourceRow(page, FILE_B);
  const simRow = sourceRow(page, SIM);
  await expect(simRow).toBeVisible();

  await expectNoRowAction(page, fileRow, MENU.fill);
  await expect(simRow.locator(".cell-history"), "the simulator keeps history, so its row says how far the history got").toContainText(/^History:/);
  const trigger = actionsOf(simRow);
  await (await rowAction(page, simRow, MENU.fill)).click();

  const dialog = fillDialog(page, SIM);
  await expect(dialog).toBeVisible();
  const start = dialog.getByLabel("Start date", { exact: true });
  const end = dialog.getByLabel("End date", { exact: true });
  await expect(start, "the focus lands on the first field").toBeFocused();
  const note = dialog.locator(".history-fill-note");
  const startFill = dialog.getByRole("button", { name: "Start fill", exact: true });
  await expect(startFill, "nothing is checked yet, so there is nothing to start").toHaveAttribute("aria-disabled", "true");

  await test.step("400 days back: older than the raw readings are kept", async () => {
    await start.fill(dayInput(400));
    await end.fill(dayInput(399));
    await dialog.getByRole("button", { name: "Check range", exact: true }).click();
    await expect(note).toContainText("nothing older than");
    await expect(note).toContainText(/raw retention is \d+ days/);
    await expect(startFill, "a refused range cannot be started").toHaveAttribute("aria-disabled", "true");
    await startFill.click({ force: true });
  });

  await test.step("51 days: longer than one fill may be", async () => {
    await end.fill(dayInput(10));
    await start.fill(dayInput(60));
    await dialog.getByRole("button", { name: "Check range", exact: true }).click();
    await expect(note).toContainText(/at most 31 days/);
    await expect(startFill).toHaveAttribute("aria-disabled", "true");
    await startFill.click({ force: true });
    expect(fills, "no real fill request was sent").toEqual([]);
  });

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger, "the focus is on the row's menu button again").toBeFocused();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. The file source never polls

test("5. the file source never polls: no online or offline, no Test, no Check connection, no Browse, and a history line that says how it is filled", async ({ page }) => {
  test.setTimeout(180_000);
  await openSources(page);
  const fileRow = sourceRow(page, FILE_B);
  const simRow = sourceRow(page, SIM);
  await expect(fileRow).toBeVisible();

  await expect(fileRow, "it says how it is filled").toContainText("filled by file import");
  await expect(fileRow.locator(".cell-history")).toHaveText("Filled by importing files");
  await expect(fileRow.locator(".chip"), "no online or offline chip").toHaveCount(0);
  await expect(fileRow).not.toContainText(/\b(online|offline)\b/i);
  await expectNoRowAction(page, fileRow, "Test");
  await expectNoRowAction(page, fileRow, "Check connection");
  expect(await menuItems(page, fileRow), "the file source's menu, in order").toEqual(["Edit", "Points", MENU.import, MENU.map]);
  expect(await menuItems(page, simRow), "the simulator's menu, in order").toEqual(["Test", "Check connection", "Edit", "Points", MENU.import, MENU.map, MENU.fill]);

  await page.goto(`/sources/${ids.fileB}/points`);
  await expect(heading1(page, "Points")).toBeVisible();
  await expect(page.getByText("No points yet. They are created by mapping a tag list, from the source's menu on the Sources page.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Browse points", exact: true }), "there is nothing to browse").toHaveCount(0);

  await page.goto(`/sources/${ids.sim}/points`);
  await expect(heading1(page, "Points")).toBeVisible();
  await expect(page.getByRole("button", { name: "Browse points", exact: true }), "a polled source is browsed").toBeVisible();
});
