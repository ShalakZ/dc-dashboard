import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";

// W7l (names instead of numbers in the audit log, an audit entry in a right-hand drawer with Previous and Next, and two cards that no longer
// change height) on the state the earlier projects leave behind: admin `admin` / `correct-horse`. Everything the spec makes carries the run
// suffix (`W7l ... <run>`) and is removed again by name in afterAll, whatever happened (an asset takes its rates with it).
//
// What it pins:
//   1. A rate's audit entry reads `Created tariff 0.37 per kWh from 2019-03-14 for asset NAME` with no `#` in it (the owner's sentence), in the
//      row and in the drawer; Raw and the drawer's JSON still show `asset_id`. Once the asset is deleted the same entry reads "for a deleted
//      asset". The entry is found by the id of the tariff the spec made (the `q` search sees only the stored detail, which has no asset name).
//   2. The drawer: a click on the sentence, the chevron or the time opens it on the right (480-520 px at 1600, flush with the right edge),
//      focus inside, the page behind inert and not scrollable, `/audit/ID?<the list's query>` in the address; Previous and Next replace the
//      address, so one Back closes the drawer; Esc, Close and a click beside the drawer close it and put the focus on the chevron of the entry
//      that was open; Tab and Shift+Tab stay inside it.
//   3. The ends: across the end of a page (the address then carries both the entry and `offset`), the newest and oldest entries say why a
//      button is off, a deep link opens the drawer over its own page and Esc comes back to that page, and an entry that is not on the page
//      the link names opens but cannot be stepped from.
//   4. Closing keeps the page number, the filters and the scroll position.
//   5. Copy entry number: the toast shows above the drawer and covers neither Previous nor Next (the centre of each is the button itself), at
//      1600 and at 600 px.
//   6. The Create user card has one height for Viewer, Operator and a role with no description, at 1440 and 1024 px.
//   7. The Tariffs add forms: pressing "Add rate" with nothing chosen moves neither card's height nor the left date picker, before a valid add
//      and again after it (the card that gains a row grows by design, so the second baseline is taken after the add), at 1440 and 1024 px.
//   8. The bin's lid lifts on hover and the icon does not clip it (the screenshot is attached to the report).
//
// While the drawer is open the page behind it is `inert`: everything behind is read with CSS selectors (rows by `data-entry-id`, the open row by
// `data-open`) and the Search box only after the drawer is gone. Everything in the drawer is looked up inside `getByRole("dialog", ...)` with
// exact names: the pager has Previous and Next too, and "Next entry" contains "Next". The slide-in is a 200 ms animation, so boxes are read
// after it has finished; a toast is read after it has stopped moving.

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse" };

const RUN = Date.now().toString(36);
const RENAMES = 30; // plus the creation: 31 entries, two pages of 25
const PAGE_SIZE = 25;
const NAME = `W7l drawer ${RUN}`; // every rename keeps this as its start, so one search finds all of the asset's entries
const LIST_QUERY = `q=${encodeURIComponent(NAME)}&size=${PAGE_SIZE}`;
const LIST = `/audit?${LIST_QUERY}`;
const TOLERANCE = 0.5; // px

// The entries of the drawer asset, newest first (set in beforeAll): row i of the first page is IDS[i], the second page starts at IDS[25].
let IDS: number[] = [];
let DRAWER_ASSET = 0;
const CUSTOM_ROLE = `W7l no description ${RUN}`;

interface ApiAuditEntry { id: number; action: string; detail: Record<string, unknown> }
interface ApiAuditList { items: ApiAuditEntry[]; total: number }
interface ApiRole { id: number; name: string; description: string; builtin: boolean }

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

async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}

async function makeAsset(request: APIRequestContext, name: string): Promise<number> {
  const made = await request.post("/api/assets", { data: { name, parent_id: null, kind: "generic", sort_order: 0 } });
  expect(made.ok(), `creating the asset ${name}: ${made.status()} ${await made.text()}`).toBe(true);
  return ((await made.json()) as { id: number }).id;
}

/** Two animation frames: whatever the page does about a changed layout has happened by then. */
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

async function setWidth(page: Page, width: number, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
}

interface Box { x: number; y: number; width: number; height: number }

/** The box of the one element the locator finds, in the viewport. */
async function boxOf(locator: Locator, what: string): Promise<Box> {
  await expect(locator, `${what} is on the page`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  return box!;
}

/** The box once it has stopped moving (a drawer slides in over 200 ms, a toast slides up from 8 px lower). */
async function stableBox(locator: Locator, what: string): Promise<Box> {
  let last = await boxOf(locator, what);
  await expect
    .poll(async () => {
      const now = await boxOf(locator, what);
      const same = now.x === last.x && now.y === last.y && now.width === last.width && now.height === last.height;
      last = now;
      return same;
    }, { message: `${what} has stopped moving`, timeout: 5_000 })
    .toBe(true);
  return last;
}

/** The two boxes share some area. */
const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The element that is really at the middle of the locator's box is the element itself (or something inside it): nothing covers it. */
const isOnTop = (locator: Locator) =>
  locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit !== null && el.contains(hit);
  });

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const heading2 = (page: Page, name: string) => page.getByRole("heading", { level: 2, name, exact: true });
const button = (scope: Page | Locator, name: string) => scope.getByRole("button", { name, exact: true });

/** The toasts of the page (the stack has no role of its own: only an error toast has one). */
const toastWith = (page: Page, text: string) => page.locator(".toast-stack .toast").filter({ hasText: text });

const historyLength = (page: Page) => page.evaluate(() => window.history.length);

// ---------------------------------------------------------------------------------------------------------------------------------
// The audit page and its drawer

const auditRows = (page: Page) => page.locator(".audit-table tbody tr"); // the real table: the loading skeleton's rows are `tbody tr` too
const rowOf = (page: Page, id: number) => page.locator(`.audit-table tr[data-entry-id="${id}"]`);
const chevronOf = (page: Page, id: number) => rowOf(page, id).getByRole("button", { name: `Details of entry #${id}`, exact: true });
const openRow = (page: Page) => page.locator(".audit-table tr[data-open]");
const drawerOf = (page: Page) => page.getByRole("dialog", { name: "Audit entry", exact: true });
/** Previous / Next in the drawer's footer. Only the working button has exactly this name; a button that is off carries its reason after it. */
const stepButton = (drawer: Locator, which: "Previous" | "Next") => button(drawer, `${which} entry`);
const facts = (drawer: Locator) => drawer.locator("dl.kv");
/** The entry's number as the drawer prints it (`#12`; the text of the Copy button follows it directly, so no word boundary). */
const numberOf = (id: number) => new RegExp(`#${id}(?!\\d)`);

/** The address of the page with the drawer open on `id`: the list's own query, and `offset` only when the page is not the first. */
const entryAddress = (id: number, offset: number | null = null) => (url: URL) =>
  url.pathname === `/audit/${id}` && url.searchParams.get("q") === NAME && url.searchParams.get("size") === String(PAGE_SIZE) &&
  url.searchParams.get("offset") === (offset === null ? null : String(offset));
/** The address of the list itself, no drawer. */
const listAddress = (offset: number | null = null) => (url: URL) =>
  url.pathname === "/audit" && url.searchParams.get("q") === NAME && url.searchParams.get("size") === String(PAGE_SIZE) &&
  url.searchParams.get("offset") === (offset === null ? null : String(offset));

const insideDrawer = (drawer: Locator) => drawer.evaluate((el) => el.contains(document.activeElement));
const shellIsInert = (page: Page) => page.locator(".shell").evaluate((el) => el.hasAttribute("inert"));

/** The drawer once it has slid in (the animation has finished), and its box. */
async function openDrawerBox(page: Page): Promise<Box> {
  const drawer = drawerOf(page);
  await expect(drawer).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.querySelector(".drawer")?.getAnimations().length ?? -1), { message: "the slide-in has finished" })
    .toBe(0);
  return boxOf(drawer, "the drawer");
}

/** The audit page at `path` (the drawer asset's entries, first page, by default) with its rows drawn: `rows` of them, or just some. */
async function openList(page: Page, path = LIST, rows: number | null = PAGE_SIZE): Promise<void> {
  await page.goto(path);
  await expect(heading1(page, "Audit log")).toBeVisible();
  if (rows === null) await expect(auditRows(page).first()).toBeVisible();
  else await expect(auditRows(page)).toHaveCount(rows);
}

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W7l: names in the audit log, the audit entry drawer, two cards that keep their height", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    await asAdmin(browser, async (request) => {
      DRAWER_ASSET = await makeAsset(request, NAME);
      for (let i = 1; i <= RENAMES; i++) {
        const renamed = await request.patch(`/api/assets/${DRAWER_ASSET}`, { data: { name: `${NAME} r${i}` } });
        expect(renamed.ok(), `rename ${i}: ${renamed.status()} ${await renamed.text()}`).toBe(true);
      }
      const log = await getJson<ApiAuditList>(request, `/api/audit?q=${encodeURIComponent(NAME)}&limit=200`);
      expect(log.total, "the creation and every rename of the drawer asset are in the log").toBe(RENAMES + 1);
      IDS = log.items.map((entry) => entry.id); // newest first, like the page
    });
  });

  test.afterAll(async ({ browser }) => {
    await asAdmin(browser, async (request) => {
      // Whatever this run made, by its suffix. Newest first; an asset takes its rates with it, so a later 404 is fine.
      const assets = await getJson<{ id: number; name: string }[]>(request, "/api/assets");
      for (const asset of assets.filter((a) => a.name.includes(RUN)).sort((a, b) => b.id - a.id)) {
        await request.delete(`/api/assets/${asset.id}?confirm=true`).catch(() => undefined);
      }
      const roles = await getJson<ApiRole[]>(request, "/api/roles");
      for (const role of roles.filter((r) => !r.builtin && r.name.includes(RUN))) {
        await request.delete(`/api/roles/${role.id}`).catch(() => undefined);
      }
    });
  });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  test("a rate's audit entry names the asset and shows no number; once the asset is deleted it reads 'a deleted asset'; Raw and the drawer keep the ids", async ({ page }) => {
    test.setTimeout(150_000);
    const name = `W7l rate ${RUN}`;
    const assetId = await makeAsset(page.request, name);
    const made = await page.request.post("/api/tariffs", { data: { asset_id: assetId, rate_per_kwh: 0.37, effective_from: "2019-03-14" } });
    expect(made.ok(), `a rate for the asset: ${made.status()} ${await made.text()}`).toBe(true);
    const tariffId = ((await made.json()) as { id: number }).id;

    // The entry by the id of the tariff it is about: the stored detail holds the tariff's and the asset's ids, never the asset's name.
    const log = await getJson<ApiAuditList>(page.request, "/api/audit?action=tariff.created&limit=200");
    const entry = log.items.find((item) => item.detail.tariff_id === tariffId);
    expect(entry, "the rate's tariff.created entry is in the log").toBeDefined();
    const row = rowOf(page, entry!.id);
    const sentence = row.locator("td.cell-what");
    const named = `Created tariff 0.37 per kWh from 2019-03-14 for asset ${name}`;

    await test.step("the row names the asset and has no number", async () => {
      await openList(page, "/audit?action=tariff.created", null);
      await expect(sentence).toContainText(named);
      await expect(sentence, "no # in the sentence").not.toContainText("#");
    });

    await test.step("Raw still shows the asset's id, and a raw row opens the drawer with the same sentence and the JSON", async () => {
      await button(page, "Raw").click();
      await expect(page).toHaveURL(/view=raw/);
      await expect(row.locator("td.cell-detail")).toContainText(`"asset_id":${assetId}`);
      await row.locator("td.cell-time a").click();
      const drawer = drawerOf(page);
      await openDrawerBox(page);
      await expect(drawer.locator("dd .what")).toContainText(named);
      await expect(drawer.locator("dd .what"), "no # in the drawer's sentence").not.toContainText("#");
      await drawer.getByRole("button", { name: "Show the stored JSON" }).click();
      await expect(drawer.locator("pre.entry-json"), "the JSON keeps the ids").toContainText(`"asset_id": ${assetId}`);
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
    });

    await test.step("with the asset deleted, the same entry says 'a deleted asset' and Raw still has the id", async () => {
      const gone = await page.request.delete(`/api/assets/${assetId}?confirm=true`);
      expect(gone.ok(), `deleting the asset: ${gone.status()} ${await gone.text()}`).toBe(true);
      await page.goto("/audit?action=tariff.created");
      await expect(heading1(page, "Audit log")).toBeVisible();
      await expect(sentence).toContainText("Created tariff 0.37 per kWh from 2019-03-14 for a deleted asset");
      await expect(sentence).not.toContainText(name);
      await expect(sentence).not.toContainText("#");
      await button(page, "Raw").click();
      await expect(row.locator("td.cell-detail")).toContainText(`"asset_id":${assetId}`);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  test("an entry opens in a drawer on the right; Previous and Next replace the address; Back, Esc, Close and the backdrop close it and the focus goes back", async ({ page }) => {
    test.setTimeout(180_000);
    await openList(page);
    const rowIds = await auditRows(page).evaluateAll((rows) => rows.map((tr) => Number(tr.getAttribute("data-entry-id"))));
    expect(rowIds, "the list is the entries the spec made, newest first").toEqual(IDS.slice(0, PAGE_SIZE));
    const [above, here, below] = [IDS[2], IDS[3], IDS[4]];
    const drawer = drawerOf(page);

    await test.step("the chevron opens it on the right: size, focus, address, the open row, the page behind", async () => {
      const before = await historyLength(page);
      await chevronOf(page, here).click();
      const box = await openDrawerBox(page);
      const edge = await page.evaluate(() => ({ inner: window.innerWidth, client: document.documentElement.clientWidth }));
      expect(box.width, `the drawer is ${box.width} px wide`).toBeGreaterThanOrEqual(480);
      expect(box.width, `the drawer is ${box.width} px wide`).toBeLessThanOrEqual(520 + TOLERANCE);
      expect(box.x + box.width, "the drawer reaches the right edge of the window").toBeGreaterThanOrEqual(edge.client - 1);
      expect(box.x + box.width, "the drawer reaches the right edge of the window").toBeLessThanOrEqual(edge.inner + 1);
      await expect.poll(() => insideDrawer(drawer), { message: "focus is inside the drawer" }).toBe(true);
      await expect(page).toHaveURL(entryAddress(here));
      await expect(openRow(page)).toHaveAttribute("data-entry-id", String(here));
      expect(await historyLength(page), "opening adds one history entry").toBe(before + 1);
      expect(await shellIsInert(page), "the page behind the drawer is inert").toBe(true);

      await expect(heading2(page, "Audit entry")).toBeVisible();
      await expect(drawer.locator("dl.kv dt")).toHaveText(["What happened", "When", "Who", "Action", "Entry"]);
      await expect(facts(drawer)).toContainText(numberOf(here));
      await expect(drawer.locator("dd .what"), "the sentence names the asset").toContainText(NAME);
      await expect(drawer.locator("dd .what")).not.toContainText("#");
      await expect(drawer.getByRole("heading", { name: "What changed", level: 3, exact: true }), "a rename has its Before/After table").toBeVisible();
      await expect(drawer.getByRole("heading", { name: "Details", level: 3, exact: true })).toBeVisible();
      await drawer.getByRole("button", { name: "Show the stored JSON" }).click();
      await expect(drawer.locator("pre.entry-json")).toContainText(`"asset_id": ${DRAWER_ASSET}`);
    });

    await test.step("the page behind does not scroll under the wheel", async () => {
      const top = await page.evaluate(() => window.scrollY);
      expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight), "the page is tall enough to scroll, so the lock means something").toBe(true);
      await page.mouse.move(60, 400); // on the backdrop, left of the panel
      await page.mouse.wheel(0, 500);
      await settled(page);
      expect(await page.evaluate(() => window.scrollY), "the page is locked while the drawer is open").toBe(top);
    });

    await test.step("Next goes to the entry below, Previous to the one above, and the history does not grow", async () => {
      const history = await historyLength(page);
      const stepTo = async (which: "Previous" | "Next", id: number) => {
        await stepButton(drawer, which).click();
        await expect(page).toHaveURL(entryAddress(id));
        await expect(openRow(page)).toHaveAttribute("data-entry-id", String(id));
        await expect(facts(drawer)).toContainText(numberOf(id));
        expect(await historyLength(page), `after ${which}: one history entry for the whole session in the drawer`).toBe(history);
      };
      await stepTo("Next", below);
      await expect(stepButton(drawer, "Next"), "the focus stays on the button that was pressed").toBeFocused();
      await stepTo("Previous", here);
      await stepTo("Previous", above);
    });

    await test.step("one Back closes the drawer, whatever was stepped through", async () => {
      await page.goBack();
      await expect(drawer).toBeHidden();
      await expect(page).toHaveURL(listAddress());
      expect(await shellIsInert(page), "the page is live again").toBe(false);
      await expect(page.getByLabel("Search", { exact: true }), "the filter is as it was").toHaveValue(NAME);
      await expect(auditRows(page)).toHaveCount(PAGE_SIZE);
    });

    await test.step("a click on the sentence opens it; Esc after a step closes it and the focus is on the chevron of the entry that was open", async () => {
      const clicked = IDS[5];
      await rowOf(page, clicked).locator(".cell-what .what").click();
      await openDrawerBox(page);
      await expect(page).toHaveURL(entryAddress(clicked));
      await stepButton(drawer, "Next").click();
      await expect(page).toHaveURL(entryAddress(IDS[6]));
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect(page).toHaveURL(listAddress());
      await expect(chevronOf(page, IDS[6]), "the focus is on the chevron of the entry that was open").toBeFocused();
    });

    await test.step("the time link opens it; Close closes it and the focus is back on that row's chevron", async () => {
      await rowOf(page, IDS[8]).locator("td.cell-time a").click();
      await openDrawerBox(page);
      await expect(page).toHaveURL(entryAddress(IDS[8]));
      await button(drawer, "Close").click();
      await expect(drawer).toBeHidden();
      await expect(page).toHaveURL(listAddress());
      await expect(chevronOf(page, IDS[8])).toBeFocused();
    });

    await test.step("a click beside the drawer closes it", async () => {
      await chevronOf(page, IDS[10]).click();
      await openDrawerBox(page);
      await page.mouse.click(40, 400);
      await expect(drawer).toBeHidden();
      await expect(page).toHaveURL(listAddress());
      await expect(chevronOf(page, IDS[10])).toBeFocused();
    });

    await test.step("Tab and Shift+Tab stay inside the drawer", async () => {
      await chevronOf(page, IDS[12]).click();
      await openDrawerBox(page);
      for (const key of ["Tab", "Shift+Tab"]) {
        for (let i = 1; i <= 12; i++) {
          await page.keyboard.press(key);
          expect(await insideDrawer(drawer), `${key} press ${i} left the drawer`).toBe(true);
        }
      }
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  test("Previous and Next cross the end of a page and stop at the ends of the log; a deep link opens the drawer over its own page", async ({ page }) => {
    test.setTimeout(180_000);
    const [lastOfFirstPage, firstOfSecond, oldest, newest] = [IDS[PAGE_SIZE - 1], IDS[PAGE_SIZE], IDS[IDS.length - 1], IDS[0]];
    const drawer = drawerOf(page);

    await test.step("Next from the last row of the first page lands on the first row of the second, and Previous comes back", async () => {
      await openList(page);
      const before = await historyLength(page);
      await chevronOf(page, lastOfFirstPage).click();
      await openDrawerBox(page);
      await stepButton(drawer, "Next").click();
      await expect(page).toHaveURL(entryAddress(firstOfSecond, PAGE_SIZE)); // the entry and the page change in one address
      await expect(openRow(page)).toHaveAttribute("data-entry-id", String(firstOfSecond));
      await expect(auditRows(page)).toHaveCount(IDS.length - PAGE_SIZE);
      await expect(facts(drawer)).toContainText(numberOf(firstOfSecond));
      expect(await historyLength(page), "crossing a page adds no history entry").toBe(before + 1);

      await stepButton(drawer, "Previous").click();
      await expect(page).toHaveURL(entryAddress(lastOfFirstPage));
      await expect(auditRows(page)).toHaveCount(PAGE_SIZE);
      await expect(facts(drawer)).toContainText(numberOf(lastOfFirstPage));
      expect(await historyLength(page)).toBe(before + 1);
    });

    await test.step("down to the oldest entry: Next is off and says why, and the focus waits on the drawer", async () => {
      await stepButton(drawer, "Next").click();
      await expect(page).toHaveURL(entryAddress(firstOfSecond, PAGE_SIZE));
      for (let i = PAGE_SIZE + 1; i < IDS.length; i++) {
        await stepButton(drawer, "Next").click();
        await expect(page).toHaveURL(entryAddress(IDS[i], PAGE_SIZE));
        await expect(facts(drawer)).toContainText(numberOf(IDS[i]));
      }
      const end = button(drawer, "Next entry: this is the oldest entry");
      await expect(end).toBeDisabled();
      await expect(facts(drawer)).toContainText(numberOf(oldest));
      await expect(drawer, "with the button off, the focus is on the drawer, not on the page").toBeFocused();
      await expect(stepButton(drawer, "Previous"), "the way back is open").toBeEnabled();
    });

    await test.step("Esc after a crossing returns to the page that was showing, not to the first", async () => {
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect(page).toHaveURL(listAddress(PAGE_SIZE));
      await expect(page.getByText(/^Page 2 of 2$/)).toBeVisible();
      await expect(auditRows(page)).toHaveCount(IDS.length - PAGE_SIZE);
    });

    await test.step("the newest entry: Previous is off and says why", async () => {
      await openList(page);
      await chevronOf(page, newest).click();
      await openDrawerBox(page);
      await expect(button(drawer, "Previous entry: this is the newest entry")).toBeDisabled();
      await expect(stepButton(drawer, "Next")).toBeEnabled();
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
    });

    await test.step("a deep link to an entry opens the drawer over the page that link names, with the filters kept; Esc comes back to that page", async () => {
      const deep = IDS[PAGE_SIZE + 2];
      await page.goto(`/audit/${deep}?${LIST_QUERY}&offset=${PAGE_SIZE}`);
      await openDrawerBox(page);
      await expect(auditRows(page)).toHaveCount(IDS.length - PAGE_SIZE);
      await expect(openRow(page)).toHaveAttribute("data-entry-id", String(deep));
      await expect(facts(drawer)).toContainText(numberOf(deep));
      await expect(stepButton(drawer, "Previous"), "an entry on the page can be stepped from").toBeEnabled();
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect(page).toHaveURL(listAddress(PAGE_SIZE)); // a deep link has no list to go back to: the address is replaced, the query kept
      await expect(page.getByLabel("Search", { exact: true })).toHaveValue(NAME);
      await expect(page.getByText(/^Page 2 of 2$/)).toBeVisible();
    });

    await test.step("an entry that is not on the page the link names opens, and says it cannot be stepped from", async () => {
      const elsewhere = IDS[2]; // on the first page; the link names the second
      await page.goto(`/audit/${elsewhere}?${LIST_QUERY}&offset=${PAGE_SIZE}`);
      await openDrawerBox(page);
      await expect(facts(drawer)).toContainText(numberOf(elsewhere));
      for (const which of ["Previous", "Next"] as const) {
        const off = drawer.getByRole("button", { name: new RegExp(`^${which} entry`) });
        await expect(off).toBeDisabled();
        await expect(off).toHaveAttribute("aria-label", /open it from the list to step through the log/);
      }
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  test("closing the drawer keeps the page number and the scroll position", async ({ page }) => {
    test.setTimeout(120_000);
    const drawer = drawerOf(page);

    await test.step("the second page is still the second page", async () => {
      await openList(page);
      await button(page, "Next").click(); // the pager's, with no drawer open
      await expect(page.getByText(/^Page 2 of 2$/)).toBeVisible();
      await expect(auditRows(page)).toHaveCount(IDS.length - PAGE_SIZE);
      await chevronOf(page, IDS[PAGE_SIZE + 1]).click();
      await openDrawerBox(page);
      await expect(page).toHaveURL(entryAddress(IDS[PAGE_SIZE + 1], PAGE_SIZE));
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect(page).toHaveURL(listAddress(PAGE_SIZE));
      await expect(page.getByText(/^Page 2 of 2$/)).toBeVisible();
      await expect(page.getByLabel("Search", { exact: true })).toHaveValue(NAME);
    });

    await test.step("the page is where it was scrolled to", async () => {
      await setWidth(page, 1600, 700); // a short window, so the 25 rows scroll
      await openList(page);
      const chevron = chevronOf(page, IDS[19]);
      await chevron.scrollIntoViewIfNeeded();
      await chevron.click();
      await openDrawerBox(page);
      const scrolled = await page.evaluate(() => window.scrollY); // after the click, which may itself have scrolled the row into view
      expect(scrolled, "the page really was scrolled").toBeGreaterThan(100);
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect
        .poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - scrolled), { message: "the scroll position after closing" })
        .toBeLessThanOrEqual(2);
      await expect(page).toHaveURL(listAddress());
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  test("Copy entry number toasts above the drawer without covering Previous or Next (1600 and 600 px)", async ({ page }) => {
    test.setTimeout(150_000);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const id = IDS[4];
    const drawer = drawerOf(page);

    for (const width of [1600, 600]) {
      await test.step(`${width} px`, async () => {
        await setWidth(page, width, 900);
        await openList(page);
        await chevronOf(page, id).click();
        await openDrawerBox(page);
        await button(drawer, "Copy entry number").click();

        const toast = toastWith(page, "Entry number copied");
        await expect(toast).toBeVisible();
        const toastBox = await stableBox(toast, "the Copy toast");
        const previous = stepButton(drawer, "Previous");
        const next = stepButton(drawer, "Next");
        const foot = await boxOf(drawer.locator(".drawer-foot"), "the drawer's footer");
        expect(toastBox.y + toastBox.height, `the toast ends (${toastBox.y + toastBox.height}) above the footer (${foot.y})`).toBeLessThanOrEqual(foot.y + 1);
        expect(overlap(toastBox, await boxOf(previous, "Previous")), "the toast does not cover Previous").toBe(false);
        expect(overlap(toastBox, await boxOf(next, "Next")), "the toast does not cover Next").toBe(false);
        // What a click would reach: the buttons themselves, and the toast over the drawer (its own layer is above).
        await expect.poll(() => isOnTop(next), { message: "the centre of Next is the Next button" }).toBe(true);
        await expect.poll(() => isOnTop(previous), { message: "the centre of Previous is the Previous button" }).toBe(true);
        await expect.poll(() => isOnTop(toast), { message: "the toast is above the drawer" }).toBe(true);
        if (width >= 720) expect(toastBox.x, "the toast sits in the drawer's column").toBeGreaterThanOrEqual((await boxOf(drawer, "the drawer")).x);

        expect(await page.evaluate(() => navigator.clipboard.readText()), "the entry number is on the clipboard").toBe(`#${id}`);
        await page.keyboard.press("Escape");
        await expect(drawer).toBeHidden();
      });
    }
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  test("the Create user card has one height for Viewer, Operator and a role with no description (1440 and 1024 px)", async ({ page }) => {
    test.setTimeout(120_000);
    const made = await page.request.post("/api/roles", { data: { name: CUSTOM_ROLE, description: "", permissions: ["assets.view"] } });
    expect(made.status(), `a role with no description: ${await made.text()}`).toBe(201);
    const roles = await getJson<ApiRole[]>(page.request, "/api/roles");
    const described = (name: string) => roles.find((r) => r.name === name)?.description ?? "";
    expect(described("viewer"), "the Viewer has a description").not.toBe("");
    expect(described("operator"), "the Operator has a description").not.toBe("");

    const cases: [label: string, role: string, description: string][] = [
      ["Viewer", "viewer", described("viewer")],
      ["Operator", "operator", described("operator")],
      ["a role with no description", CUSTOM_ROLE, ""],
    ];
    for (const width of [1440, 1024]) {
      await test.step(`${width} px`, async () => {
        await setWidth(page, width, 900);
        await page.goto("/users");
        await expect(heading1(page, "Users & Roles")).toBeVisible();
        const card = page.locator(".form-card").filter({ has: heading2(page, "Create user") });
        const select = card.locator("select");
        const note = card.locator("p.role-note");
        await expect(card).toBeVisible();
        const heights: number[] = [];
        for (const [label, role, description] of cases) {
          await select.selectOption(role);
          await expect(note, `${label}: the line under the form`).toHaveText(description);
          await settled(page);
          heights.push((await boxOf(card, `the card for ${label}`)).height);
          if (description === "") {
            expect(await select.getAttribute("aria-describedby"), "nothing to describe: the select points at nothing").toBeNull();
            await expect(note, "the empty line is hidden from assistive technology").toHaveAttribute("aria-hidden", "true");
          } else {
            await expect(select, `${label}: the select points at its description`).toHaveAttribute("aria-describedby", /.+/);
          }
        }
        for (const [i, [label]] of cases.entries()) {
          expect(Math.abs(heights[i] - heights[0]), `${label}: the card is ${heights[i]} px against ${heights[0]} px for ${cases[0][0]} at ${width} px`).toBeLessThanOrEqual(TOLERANCE);
        }
      });
    }
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  test("Tariffs: Add rate with nothing chosen moves neither card nor the date picker, before a valid add and after it (1440 and 1024 px)", async ({ page }) => {
    test.setTimeout(180_000);
    for (const [n, width] of [1440, 1024].entries()) {
      await test.step(`${width} px`, async () => {
        const assetName = `W7l rates ${width} ${RUN}`;
        const assetId = await makeAsset(page.request, assetName);
        await setWidth(page, width, 900);
        await page.goto("/tariffs");
        await expect(heading1(page, "Tariffs")).toBeVisible();
        const cardOf = (title: string) => page.locator(".page-card").filter({ has: heading2(page, title) });
        const [left, right] = [cardOf("Site default rate"), cardOf("Asset overrides")];
        const leftForm = page.getByRole("form", { name: "Add site default rate" });
        const rightForm = page.getByRole("form", { name: "Add asset override" });
        await expect(leftForm).toBeVisible();
        await expect(rightForm).toBeVisible();
        await expect(page.locator(".sk-region"), "no skeleton is left").toHaveCount(0);

        interface Layout { leftCard: number; rightCard: number; leftForm: number; rightForm: number; picker: number }
        const height = (el: Locator) => el.evaluate((node) => node.getBoundingClientRect().height);
        const top = (el: Locator) => el.evaluate((node) => node.getBoundingClientRect().top + window.scrollY); // in the document, whatever the page is scrolled to
        const layout = async (): Promise<Layout> => {
          await settled(page);
          return {
            leftCard: await height(left), rightCard: await height(right), leftForm: await height(leftForm), rightForm: await height(rightForm),
            picker: await top(leftForm.locator('input[type="date"]')),
          };
        };
        const expectSame = (now: Layout, then: Layout, keys: (keyof Layout)[], what: string) => {
          for (const key of keys) expect(Math.abs(now[key] - then[key]), `${what}: ${key} is ${now[key]} against ${then[key]}`).toBeLessThanOrEqual(TOLERANCE);
        };
        const everything: (keyof Layout)[] = ["leftCard", "rightCard", "leftForm", "rightForm", "picker"];

        const base = await layout();

        await button(rightForm, "Add rate").click();
        await expect(rightForm.getByRole("alert")).toHaveText("Choose an asset.");
        expectSame(await layout(), base, everything, "after Add rate in Asset overrides with nothing chosen");

        await button(leftForm, "Add rate").click();
        await expect(leftForm.getByRole("alert")).toHaveText("Choose the date the rate takes effect.");
        expectSame(await layout(), base, everything, "after Add rate in both forms with nothing chosen");

        // A valid add: the table gains a row, so the card that holds it grows by design. The forms' own heights do not change.
        await rightForm.locator("select").selectOption(String(assetId));
        await rightForm.locator('input[type="date"]').fill(`2019-04-0${n + 1}`);
        await rightForm.locator('input[type="number"]').fill("0.31");
        await button(rightForm, "Add rate").click();
        await expect(toastWith(page, "Rate added")).toBeVisible();
        await expect(right.locator("td.asset-cell").filter({ hasText: assetName }), "the table has the new row").toBeVisible();
        await expect(rightForm.locator('input[type="number"]'), "the rate field is cleared").toHaveValue("");
        await expect(rightForm.getByRole("alert")).toHaveCount(0);
        const added = await layout();
        expectSame(added, base, ["leftForm", "rightForm"], "each add form's own height before and after a valid add");

        // Nothing chosen again: the asset stays selected after an add, so it is put back to the empty choice first. The toast sits in the
        // lower right, where Add rate may be at this width: it is dismissed first, so no press waits for it to leave by itself.
        const rateToast = toastWith(page, "Rate added");
        if (await rateToast.isVisible()) await button(rateToast, "Dismiss notification").click({ timeout: 2_000 }).catch(() => undefined); // it may have left by itself
        await expect(rateToast).toBeHidden();
        await rightForm.locator("select").selectOption("");
        await button(rightForm, "Add rate").click();
        await expect(rightForm.getByRole("alert")).toHaveText("Choose an asset.");
        expectSame(await layout(), added, everything, "after Add rate with nothing chosen, following a valid add");
        await button(leftForm, "Add rate").click();
        await expect(leftForm.getByRole("alert")).toHaveText("Choose the date the rate takes effect.");
        expectSame(await layout(), added, everything, "after Add rate in both forms with nothing chosen, following a valid add");
      });
    }
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  test("the bin's lid lifts on hover and the icon does not clip it", async ({ page }, testInfo) => {
    const name = `W7l bin ${RUN}`;
    const id = await makeAsset(page.request, name);
    await page.goto(`/assets/${id}`);
    await expect(heading1(page, name)).toBeVisible();
    const trash = button(page, `Delete ${name}`);
    await trash.hover();
    const lid = trash.locator(".lid");
    await expect.poll(() => lid.evaluate((el) => getComputedStyle(el).transform), { message: "the lid has tilted" }).not.toBe("none");
    expect(await trash.locator("svg").evaluate((el) => getComputedStyle(el).overflow), "the icon lets the lifted lid show").toBe("visible");
    await testInfo.attach("bin-hover", { body: await trash.screenshot(), contentType: "image/png" });
  });
});
