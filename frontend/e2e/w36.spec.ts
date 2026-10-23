import { expect, test, type APIRequestContext, type APIResponse, type Browser, type Locator, type Page } from "@playwright/test";

// W36 (Map by shape): a source of thousands of tags is mapped by deciding about a few dozen tag SHAPES, never about the points one by one. Admin `admin` / `correct-horse`. The contract is the plan
// docs/superpowers/plans/2026-10-24-w36-discovery-at-scale.md (the contract, rulings P1 to P8) and the rulings R1 to R17 of .waves/w36.md.
//
// WHICH SERVER, AND WHY. The spec needs the SCADA-shaped OPC UA test server of the stack's simulator at `opc.tcp://simulator:4850/plantscada`: the stack's override file sets `SIM_SCADA_PORT: "4850"` and the default of 24
// meters per feed gives 1,306 tags (2 feeds x 24 meters x 27 tags, plus 10 incomers; `PDUA#_PM0_PENRG` has 24 members and so has its PDUB twin). Nothing else in the suite keeps a source there. The spec ADDS the source
// (security none, switched off: nothing polls it) and asks the platform itself whether anything answers: the connection test (`POST /api/sources/{id}/test`) ends as `done` with a result whose status is `unreachable`
// when the connection is refused or the name does not resolve, and ONLY that SKIPS the spec, with a sentence (a skipped w36 in the summary line means exactly this). Any other non-ok answer, and a browse that does not
// end `done`, FAIL: the server answers, so something is broken.
//
// IT MAKES ITS OWN DATA and needs nothing from the stack beyond the sign-in. Names: `W36 <run> ...` (the asset `W36 <run> hall`, the source `W36 <run> scada`); the account and role of case 6 start `w36-`. afterAll removes
// it all, each step on its own and also after a failed case; beforeAll sweeps what an earlier run that stopped half way left.
//   1  THE SETUP. The hall and the source are made through the API, the server is probed (skip or go on), the source is browsed and its job awaited. The graph calls the source `large` and draws none of its points; the
//      Points page draws 200 of 1,306 rows with its cap line and Search reaches a tag that is not among them.
//   2  DISCOVERY. The card says `1,306 points, 0 mapped` and has **Map by shape**; Enter on the card adds at most a handful of nodes (and closes again); Find `PENRG` ends with the option
//      `Search the 1,306 tags of <source> for "PENRG"`, which opens the shapes page with the search box filled and the row `PDUA#_PM0_PENRG`.
//   3  SHAPES, REVIEW, MAP, UNDO, MAP AGAIN (one case: the Undo toast lives for 10 seconds in the page it was raised in). The heading, the tiles, `PDUA#_PM0_PENRG` under **Suggested for billing** (the other section is closed),
//      **Map as energy counter** with the tick for the PDUB twin and the parent asset; **Review 48 mappings...** shows 48 mappings, a sample on `PDUA01`, no blocking check; the keyboard (focus inside, Tab wraps, Escape
//      closes with the focus back on the button); **Map 48 points**; the toast's **Undo** takes the assets and mappings away; the same Map once more.
//   4  RESULT. Through the API: `PDUA01`..`PDUA24` and `PDUB01`..`PDUB24` under the hall, an `energy_kwh` mapping each (48 on the source); Discovery says `1,306 points, 48 mapped` and still draws a handful of nodes.
//   5  READER. A role with `discovery.view` and nothing else: the rows, read-only decisions, no Review button, no bar, the tag-list lines route answers 403, and no link to the Points page.
//   6  LOOK at 1024 x 768, sidebar expanded and minimised: no sideways overflow on the shapes page, the bottom bar, **Review N mappings...** and the open dialog inside the window; the large card's buttons inside the card.
// Playwright matches names by SUBSTRING and case-insensitively: every lookup that could meet a longer name is `exact: true` (`Decision for PDUA#_PM0_P` is inside `Decision for PDUA#_PM0_PENRG`, and so is every `Shape ...`
// group name). The cases are SERIAL and depend on each other, so a failing case skips the ones after it.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";

const RUN = Date.now().toString(36);
/** A name that belongs to this run. */
const name = (what: string): string => `W36 ${RUN} ${what}`;
/** What an earlier run that stopped half way may have left behind: `W36 ` and a run id (Date.now() in base 36 is 8 characters until 2059). */
const LEFTOVER = /^W36 [0-9a-z]{8}( |$)/;

const SOURCE = name("scada");
const HALL = name("hall");
const ENDPOINT = "opc.tcp://simulator:4850/plantscada";
const TAGS = 1306;
const PER_FEED = 24;
const MAPPINGS = PER_FEED * 2;
/** The last of the ten incomers: it sorts last by address, so the Points page does not draw it until Search finds it. */
const LAST_INCOMER = "ME5IN_QM_P";
/** The labels of the two energy counter shapes (a digit that differs between the members is `#`, one that is the same is kept). */
const A = "PDUA#_PM0_PENRG";
const B = "PDUB#_PM0_PENRG";
const ROLE = "w36-no-accept";
const USER = "w36-viewer";
const PASSWORD = `w36-${RUN}-password`;
const CAP = 200;
const grouped = (n: number): string => n.toLocaleString("en-US");

// ---------------------------------------------------------------------------------------------------------------------------------
// The API shapes this spec reads (written here, so a change of the server shows up as a failure)

interface ApiAsset { id: number; parent_id: number | null; name: string }
interface ApiSource { id: number; name: string }
interface ApiMapping { id: number; asset_id: number; metric: string }
interface ApiPoint { id: number; address: string; name: string; mapping: ApiMapping | null }
interface ApiJob { id: number; status: string; result: unknown }
interface ApiLarge { points: number; mapped: number; unmapped: number; rules_new: number }
interface ApiGraphSource { id: number; point_count: number; clusters: unknown[]; ungrouped: unknown[]; large?: ApiLarge | null }
interface ApiGraph { sources: ApiGraphSource[] }
interface ApiShape { key: string; label: string; count: number; billing: "counter" | "power" | null; similar: string[] }
interface ApiShapes { points: number; mapped: number; other_tags: number; shapes_total: number; shapes: ApiShape[] }
interface ApiUser { id: number; username: string }
interface ApiRole { id: number; name: string; builtin: boolean }

async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}
const pointsOf = (request: APIRequestContext) => json<ApiPoint[]>(request, `/api/sources/${world.sourceId}/points`);
const assetsOf = (request: APIRequestContext) => json<ApiAsset[]>(request, "/api/assets");
const kidsOfHall = async (request: APIRequestContext): Promise<ApiAsset[]> => (await assetsOf(request)).filter((a) => a.parent_id === world.hallId);

/** Runs `use` with the request context of a fresh browser context in which `who` is signed in. */
async function as<T>(browser: Browser, who: { username: string; password: string }, use: (request: APIRequestContext) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    const login = await context.request.post("/api/login", { data: who });
    expect(login.ok(), `${who.username} signs in: ${login.status()} ${await login.text()}`).toBe(true);
    return await use(context.request);
  } finally {
    await context.close();
  }
}
const asAdmin = <T>(browser: Browser, use: (request: APIRequestContext) => Promise<T>) => as(browser, ADMIN, use);

async function signIn(page: Page): Promise<void> {
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in: ${login.status()} ${await login.text()}`).toBe(true);
}

/** Polls a job until it has ended (`done` or `failed`) and returns it. */
async function finished(request: APIRequestContext, jobId: number, what: string, timeout: number): Promise<ApiJob> {
  let last: ApiJob | undefined;
  await expect
    .poll(async () => {
      last = await json<ApiJob>(request, `/api/jobs/${jobId}`);
      return last.status === "done" || last.status === "failed";
    }, { message: `${what} never ended`, timeout, intervals: [500, 1_000, 2_000] })
    .toBe(true);
  return last!;
}

/** What the cases hand to each other. */
const world = {
  /** Why every case after the first skips (nothing listens at the SCADA-shaped test server), or null. */
  blocked: null as string | null,
  hallId: 0, sourceId: 0,
};

/**
 * Everything this spec may have made, in the order that works: the account, the role, the assets (a top-level asset takes its subtree and the mappings in it), the source. Each step on its own; the problems are raised at the end.
 */
async function removeMine(request: APIRequestContext): Promise<void> {
  const problems: string[] = [];
  const attempt = async (what: string, step: () => Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      problems.push(`${what}: ${String(error)}`);
    }
  };
  const gone = async (what: string, response: APIResponse): Promise<void> => {
    if (![200, 204, 404].includes(response.status())) problems.push(`${what}: ${response.status()} ${await response.text()}`);
  };
  await attempt("the accounts", async () => {
    for (const user of (await json<ApiUser[]>(request, "/api/users")).filter((u) => u.username.startsWith("w36-"))) await gone(`user ${user.username}`, await request.delete(`/api/users/${user.id}`));
  });
  await attempt("the roles", async () => {
    for (const role of (await json<ApiRole[]>(request, "/api/roles")).filter((r) => !r.builtin && r.name.startsWith("w36-"))) await gone(`role ${role.name}`, await request.delete(`/api/roles/${role.id}`));
  });
  await attempt("the assets", async () => {
    for (const asset of (await assetsOf(request)).filter((a) => a.parent_id === null && LEFTOVER.test(a.name))) await gone(`asset ${asset.name}`, await request.delete(`/api/assets/${asset.id}?confirm=true`));
  });
  await attempt("the sources", async () => {
    for (const source of (await json<ApiSource[]>(request, "/api/sources")).filter((s) => LEFTOVER.test(s.name))) await gone(`source ${source.name}`, await request.delete(`/api/sources/${source.id}?confirm=true`));
  });
  expect(problems, "everything this spec made was removed").toEqual([]);
}

test.beforeAll(async ({ browser }) => {
  await asAdmin(browser, removeMine); // what an earlier run that stopped half way left behind
});

test.afterAll(async ({ browser }) => {
  await asAdmin(browser, removeMine);
});

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

/** Every case after the first needs the source it browsed: when nothing listens at the test server they skip with the reason (and a failing setup skips them too). */
const needSetup = () => test.skip(world.blocked !== null || world.sourceId === 0, world.blocked ?? "the setup (case 1) did not make the source");

// ---------------------------------------------------------------------------------------------------------------------------------
// Locators and small helpers for the pages

const heading1 = (page: Page, text: string) => page.getByRole("heading", { level: 1, name: text, exact: true });
const nodeEl = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const srcNode = (page: Page) => nodeEl(page, `src:${world.sourceId}`);
const findField = (page: Page) => page.getByRole("combobox", { name: "Search the graph", exact: true });
const findOptions = (page: Page) => page.locator(".graph-find").getByRole("option");
const toast = (page: Page, text: string) => page.locator(".toast-stack .toast").filter({ hasText: text });
const undoOf = (raised: Locator) => raised.getByRole("button", { name: "Undo", exact: true });
const shapesUrl = (): string => `/sources/${world.sourceId}/shapes`;
const shapesHeading = (page: Page) => heading1(page, `${SOURCE}: map by tag shape`);
/** A tile of the strip on top of the shapes page, by its title: its number. */
const tile = (page: Page, title: string) => page.locator(".shape-tiles .tile").filter({ has: page.locator(".tile-label", { hasText: title }) }).locator(".big");
const billingSection = (page: Page) => page.locator(".shapes-section").filter({ has: page.getByRole("heading", { level: 2, name: "Suggested for billing", exact: true }) });
const shapeRow = (page: Page, label: string) => page.getByRole("group", { name: `Shape ${label}`, exact: true });
const decisionOf = (row: Locator, label: string) => row.getByRole("combobox", { name: `Decision for ${label}`, exact: true });
/** The button under the table: `Review mappings...` with nothing chosen, `Review 48 mappings...` after. */
const reviewButton = (page: Page) => page.locator(".shapes-bar").getByRole("button", { name: /^Review .*mappings\.\.\.$/ });
const reviewDialog = (page: Page) => page.getByRole("dialog", { name: `Review mappings by shape: ${SOURCE}`, exact: true });

/** Puts the focus on an element without scrolling anything (the canvas is overflow hidden). */
const focusQuietly = (target: Locator) => target.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
const focusedNodeId = (page: Page) => page.evaluate(() => document.activeElement?.closest(".react-flow__node")?.getAttribute("data-id") ?? null);

/** The number of nodes of the canvas, taken again until two reads in a row agree. */
async function settledNodeCount(page: Page): Promise<number> {
  let previous = -1;
  let last = 0;
  await expect.poll(async () => {
    last = await page.locator(".react-flow__node").count();
    const same = last === previous;
    previous = last;
    return same;
  }, { intervals: [300], message: "the number of nodes never settled" }).toBe(true);
  return last;
}

/** Opens Discovery and waits for the large source's card. */
async function openDiscovery(page: Page): Promise<Locator> {
  await page.goto("/discovery");
  await expect(heading1(page, "Discovery")).toBeVisible();
  const card = srcNode(page);
  await expect(card, "the large source has a card").toBeVisible({ timeout: 30_000 });
  return card;
}

type Sidebar = "expanded" | "minimized";
async function sidebar(page: Page, want: Sidebar): Promise<void> {
  const shell = page.locator(".shell");
  if ((await shell.getAttribute("data-sidebar")) !== want) await page.locator(".side-toggle").click();
  await expect(shell).toHaveAttribute("data-sidebar", want);
}

/** A box taken again until two reads in a row agree (the sidebar animates its width). */
async function settledBox(target: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  let previous = "";
  let last: { x: number; y: number; width: number; height: number } | null = null;
  await expect.poll(async () => {
    last = await target.boundingBox();
    const now = JSON.stringify(last);
    const same = last !== null && now === previous;
    previous = now;
    return same;
  }, { intervals: [150], message: "never stopped moving" }).toBe(true);
  return last!;
}

const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** Where the focus is among the controls of the open dialog: its index and how many there are; index -1 when it is not on one of them. */
const focusAt = (page: Page) =>
  page.evaluate((selector) => {
    const dialog = document.querySelector('.shapes-dialog');
    const at = document.activeElement;
    if (!dialog || !at || !dialog.contains(at)) return { index: -1, count: 0 };
    const items = Array.from(dialog.querySelectorAll(selector));
    return { index: items.indexOf(at), count: items.length };
  }, FOCUSABLE);

/** Decides about the two energy counter shapes as a person does: the PDUA row to **Map as energy counter**, the tick for its PDUB twin, and the hall as the parent. */
async function chooseEnergyCounters(page: Page): Promise<void> {
  const rowA = shapeRow(page, A);
  await decisionOf(rowA, A).selectOption({ label: "Map as energy counter" });
  await rowA.getByRole("checkbox", { name: `Same decision for ${B}`, exact: true }).check();
  await expect(decisionOf(shapeRow(page, B), B), "the tick copies the decision to the twin").toHaveValue("energy_kwh");
  await page.getByLabel("Put new assets under", { exact: true }).selectOption({ value: String(world.hallId) });
  await expect(reviewButton(page)).toHaveText(`Review ${MAPPINGS} mappings...`);
  await expect(reviewButton(page)).not.toHaveAttribute("aria-disabled", "true");
}

/** Presses Review and waits until the dialog has asked the server, run the planner, and offers **Map 48 points**. */
async function openReview(page: Page): Promise<{ dialog: Locator; go: Locator }> {
  await reviewButton(page).click();
  const dialog = reviewDialog(page);
  await expect(dialog).toBeVisible();
  const go = dialog.getByRole("button", { name: `Map ${MAPPINGS} points`, exact: true });
  await expect(go, "the dialog finishes its two checks").toBeVisible({ timeout: 60_000 });
  await expect(go).not.toHaveAttribute("aria-disabled", "true");
  return { dialog, go };
}

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W36: Map by shape", () => {
  test.describe.configure({ mode: "serial" });

  test("1. the setup: the OPC UA source is added and browsed (or the spec skips); the graph calls it large; the Points page draws 200 rows and Search reaches the rest", async ({ page }) => {
    test.setTimeout(300_000);
    const request = page.request;

    await test.step("the hall (the asset the new assets will go under) and the OPC UA source (security none, switched off)", async () => {
      const hall = await request.post("/api/assets", { data: { name: HALL, parent_id: null, kind: "generic", sort_order: 0 } });
      expect(hall.status(), `creating the hall: ${await hall.text()}`).toBe(201);
      world.hallId = ((await hall.json()) as ApiAsset).id;
      const made = await request.post("/api/sources", { data: { name: SOURCE, connector_type: "opcua", config: { endpoint: ENDPOINT, security_policy: "none" }, enabled: false } });
      expect(made.status(), `creating the source: ${await made.text()}`).toBe(201);
      world.sourceId = ((await made.json()) as ApiSource).id;
    });

    await test.step("something answers at simulator:4850 (a refused connection or an unknown name skips; any other trouble fails)", async () => {
      const started = await request.post(`/api/sources/${world.sourceId}/test`);
      expect(started.status(), `testing the connection: ${await started.text()}`).toBe(202);
      const job = await finished(request, ((await started.json()) as { job_id: number }).job_id, "the connection test", 90_000);
      expect(job.status, `the connection test job ${job.status}: ${JSON.stringify(job.result)}`).toBe("done");
      const result = (job.result ?? {}) as { ok?: boolean; status?: string; message?: string };
      if (result.ok !== true && result.status === "unreachable") {
        world.blocked = `nothing listens at simulator:4850, the SCADA-shaped test server (SIM_SCADA_PORT: "4850" in the stack's override file starts it): ${result.message ?? "unreachable"}`;
      } else {
        expect(result.ok, `a server answers at ${ENDPOINT} but the connection test says ${result.status}: ${result.message}`).toBe(true);
      }
    });
    test.skip(world.blocked !== null, world.blocked ?? "");

    await test.step(`Browse: the job ends done and the source holds ${grouped(TAGS)} points`, async () => {
      const browse = await request.post(`/api/sources/${world.sourceId}/browse`);
      expect(browse.status(), `browsing: ${await browse.text()}`).toBe(202);
      const job = await finished(request, ((await browse.json()) as { job_id: number }).job_id, "the browse job", 180_000);
      expect(job.status, `the server answers but the browse did not work: ${JSON.stringify(job.result)}`).toBe("done");
      const points = await pointsOf(request);
      expect(points.length, `the SCADA-shaped test server has ${grouped(TAGS)} tags by default (2 feeds x ${PER_FEED} meters x 27, plus 10 incomers)`).toBe(TAGS);
      expect(points.some((p) => p.name === LAST_INCOMER), `the point ${LAST_INCOMER} is there`).toBe(true);
    });

    await test.step("the graph calls the source large and draws none of its points", async () => {
      const source = (await json<ApiGraph>(request, "/api/discovery/graph")).sources.find((s) => s.id === world.sourceId);
      expect(source, "the graph holds the source").toBeDefined();
      expect(source!.point_count, "point_count is the whole source").toBe(TAGS);
      expect(source!.large, "a source over 1,000 points says so").toMatchObject({ points: TAGS, mapped: 0, unmapped: TAGS });
      expect([source!.clusters.length, source!.ungrouped.length], "and holds only its mapped points, which are none").toEqual([0, 0]);
    });

    await test.step(`the Points page draws ${CAP} of ${grouped(TAGS)} rows, with its cap line, and Search narrows over every row`, async () => {
      await page.goto(`/sources/${world.sourceId}/points`);
      await expect(heading1(page, "Points")).toBeVisible({ timeout: 30_000 });
      const rows = page.locator("tbody tr[data-point]");
      await expect(rows).toHaveCount(CAP);
      await expect(page.locator(".points-cap").getByRole("status")).toHaveText(`Showing ${CAP} of ${grouped(TAGS)} points. Search to narrow them.`);
      await expect(page.locator(".points-cap").getByRole("button", { name: `Show ${CAP} more`, exact: true })).toBeVisible();
      await expect(page.getByText(`Showing ${TAGS} of ${TAGS} points`, { exact: true }), "the toolbar counts every point").toBeVisible();
      const cellOf = (text: string) => page.getByRole("cell", { name: text, exact: true });
      await expect(cellOf(LAST_INCOMER), "the last incomer sorts last by address, so it is not among the first 200").toHaveCount(0);
      await page.getByRole("searchbox", { name: "Search points", exact: true }).fill(LAST_INCOMER);
      await expect(rows).toHaveCount(1);
      await expect(cellOf(LAST_INCOMER), "Search found it among the rows that were not drawn").toBeVisible();
      await expect(page.locator(".points-cap"), "one row needs no cap line").toHaveCount(0);
      await expect(page.getByText(`Showing 1 of ${TAGS} points`, { exact: true })).toBeVisible();
    });
  });

  test("2. Discovery: the card says how many points and offers Map by shape, Enter on it draws next to nothing, and Find offers the search of the source's tags", async ({ page }) => {
    needSetup();
    test.setTimeout(120_000);
    const card = await openDiscovery(page);

    await test.step(`the card reads ${grouped(TAGS)} points, 0 mapped, and has Map by shape`, async () => {
      await expect(card.locator(".gsrc-words")).toHaveText(`${grouped(TAGS)} points, 0 mapped`);
      await expect(card.getByRole("button", { name: `Map by shape for ${SOURCE}`, exact: true })).toBeVisible();
    });

    await test.step("Enter on the card adds at most a handful of nodes (it has none of its points to draw), and Enter again closes it", async () => {
      const before = await settledNodeCount(page);
      await focusQuietly(card);
      expect(await focusedNodeId(page), "the card holds the focus").toBe(`src:${world.sourceId}`);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(600);
      const opened = await settledNodeCount(page);
      expect(opened - before, `Enter on the card went from ${before} to ${opened} nodes`).toBeLessThanOrEqual(5);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(600);
      expect(await settledNodeCount(page), "and it is closed again").toBe(before);
    });

    await test.step("Find PENRG ends with the search of the source's tags, which opens the shapes page with the box filled and the row there", async () => {
      await page.getByRole("group", { name: "Discovery graph", exact: true }).focus(); // from the page body Ctrl+K is the top bar's quick find; on the canvas it is Find's
      await page.keyboard.press("Control+k");
      const field = findField(page);
      await expect(field, "Ctrl+K on the canvas opens Find").toBeFocused();
      await field.fill("PENRG");
      const label = `Search the ${grouped(TAGS)} tags of ${SOURCE} for "PENRG"`;
      await expect(findOptions(page).filter({ hasText: label }), "Find offers the search of the source's tags").toHaveCount(1);
      const labels = await findOptions(page).locator(".graph-find-label").allTextContents();
      const at = labels.indexOf(label);
      expect(at, `Find offers ${label} (it offers: ${JSON.stringify(labels)})`).toBeGreaterThanOrEqual(0);
      expect(labels.slice(at).every((text) => text.startsWith("Search the ")), "the tag searches are the LAST options").toBe(true);
      await findOptions(page).filter({ hasText: label }).click();
      await expect(page).toHaveURL(new RegExp(`/sources/${world.sourceId}/shapes\\?q=PENRG(&|$)`));
      await expect(shapesHeading(page)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("searchbox", { name: "Search tags", exact: true }), "the search box is filled").toHaveValue("PENRG");
      await expect(shapeRow(page, A), "and the row of the counters is there").toBeVisible();
    });
  });

  test("3. the shapes page: billing first, one decision, Review, Map, Undo, and Map again", async ({ page }) => {
    needSetup();
    test.setTimeout(300_000);
    const request = page.request;
    const shapes = await json<ApiShapes>(request, `/api/sources/${world.sourceId}/shapes`);
    const penrg = shapes.shapes.find((s) => s.label === A);
    expect(penrg, `the server found the shape ${A} (it found: ${shapes.shapes.map((s) => s.label).join(", ")})`).toBeDefined();
    expect(penrg, "an energy counter of 24 meters, a guess for billing").toMatchObject({ count: PER_FEED, billing: "counter" });
    expect(penrg!.similar, "and it knows its PDUB twin").toContain(shapes.shapes.find((s) => s.label === B)?.key);

    await page.goto(shapesUrl());
    await expect(shapesHeading(page)).toBeVisible({ timeout: 30_000 });

    await test.step("the tiles, the guess line, and PDUA#_PM0_PENRG under Suggested for billing (the other section is closed)", async () => {
      await expect(tile(page, "Points")).toHaveText(grouped(shapes.points));
      await expect(tile(page, "Shapes")).toHaveText(grouped(shapes.shapes_total));
      await expect(tile(page, "Mapped")).toHaveText("0");
      await expect(page.getByText("is a guess made from the tag text", { exact: false }), "the page says it guesses").toBeVisible();
      const row = billingSection(page).getByRole("group", { name: `Shape ${A}`, exact: true });
      await expect(row, `${A} is a Suggested for billing row`).toBeVisible();
      await expect(row).toContainText(`${PER_FEED} tags`);
      await expect(row).toContainText("Suggested: kWh counter, a guess from the unit kWh.");
      await expect(row.locator(".shape-asset"), "the asset name select shows the result for the first example").toHaveText("Asset: PDUA01");
      await expect(decisionOf(row, A), "every row starts at Ignore").toHaveValue("");
      const rest = page.getByRole("button", { name: /^Not needed for billing \(/ });
      await expect(rest).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator("#shapes-rest"), "closed by default: its rows are not in the page").toHaveCount(0);
      await expect(shapeRow(page, A), "the row is in one place only").toHaveCount(1);
      await expect(reviewButton(page), "nothing is chosen, so Review is off").toHaveAttribute("aria-disabled", "true");
      await expect(reviewButton(page)).toHaveText("Review mappings...");
      await expect(page.getByRole("checkbox", { name: "Create missing assets", exact: true })).toBeChecked();
    });

    await test.step("Map as energy counter, the tick for the PDUB twin and the parent asset: the button counts 48", async () => {
      await chooseEnergyCounters(page);
      await expect(page.locator("#shapes-bar-note")).toContainText("2 shapes chosen. Nothing is mapped until you review it and press Map.");
    });

    await test.step("Review: 48 mappings, a sample on PDUA01, no blocking check; the page behind is inert", async () => {
      const { dialog, go } = await openReview(page);
      await expect(dialog.getByRole("button", { name: "Cancel", exact: true }), "the focus starts on Cancel").toBeFocused();
      await expect(page.locator(".shell"), "the page behind is inert").toHaveAttribute("inert", "");
      await expect(dialog.getByRole("status"), "one live region").toHaveCount(1);
      await expect(dialog.getByRole("status")).toHaveText(`${MAPPINGS} tags would be mapped. Nothing is mapped until you press Map.`);
      await expect(dialog.getByText(`${PER_FEED} tags on up to ${PER_FEED} assets`, { exact: true }), "both shapes: 24 tags on up to 24 assets").toHaveCount(2);
      await expect(dialog.getByRole("cell", { name: `${HALL}/PDUA01`, exact: true }), "a sample whose derived asset is PDUA01, under the hall").toBeVisible();
      await expect(dialog.locator('.shapes-checks li[data-severity="blocking"]'), "no blocking check").toHaveCount(0);
      await expect(dialog.locator(".shapes-tiles > div").filter({ hasText: "Mappings to create" }).locator("dd"), "the planner's own count").toHaveText(String(MAPPINGS));
      await expect(go).toHaveText(`Map ${MAPPINGS} points`);
    });

    await test.step("the keyboard: the focus stays inside, Tab and Shift+Tab wrap, Escape closes only the dialog and gives the focus back to the button", async () => {
      let at = await focusAt(page);
      expect(at.index, "the focus is on one of the dialog's controls").toBeGreaterThanOrEqual(0);
      expect(at.count, "the dialog has controls to walk through").toBeGreaterThanOrEqual(2);
      for (let step = 0; step < at.count && at.index < at.count - 1; step++) {
        await page.keyboard.press("Tab");
        at = await focusAt(page);
        expect(at.index, "Tab stays on the dialog's controls").toBeGreaterThanOrEqual(0);
      }
      expect(at.index, "Tab walked to the last control").toBe(at.count - 1);
      await page.keyboard.press("Tab");
      expect((await focusAt(page)).index, "Tab from the last control wraps to the first").toBe(0);
      await page.keyboard.press("Shift+Tab");
      expect((await focusAt(page)).index, "Shift+Tab from the first control wraps to the last").toBe(at.count - 1);

      await page.keyboard.press("Escape");
      await expect(reviewDialog(page)).toBeHidden();
      await expect(page.locator(".shell"), "the page is live again").not.toHaveAttribute("inert", "");
      await expect(reviewButton(page), "Escape puts the focus back on the button that opened the dialog").toBeFocused();
      await expect(decisionOf(shapeRow(page, A), A), "the decisions are still there").toHaveValue("energy_kwh");
    });

    await test.step("Map 48 points: the toast says what was done, the tiles move, and the toast's Undo takes it all back", async () => {
      const { go } = await openReview(page);
      await go.click();
      await expect(reviewDialog(page)).toBeHidden({ timeout: 60_000 });
      const raised = toast(page, `Created ${MAPPINGS} mappings.`).last();
      await expect(raised).toBeVisible();
      await expect(undoOf(raised), "the toast has an Undo").toBeVisible();
      await expect(tile(page, "Mapped"), "the shapes page already counts them").toHaveText(String(MAPPINGS), { timeout: 3_000 });
      await undoOf(raised).click(); // the toast lives for 10 seconds: nothing slow happens before this click
      await expect.poll(async () => (await kidsOfHall(request)).length, { message: "the Undo took the new assets away", timeout: 30_000 }).toBe(0);
      expect((await pointsOf(request)).filter((p) => p.mapping !== null), "and the mappings").toHaveLength(0);
      await expect(tile(page, "Mapped"), "the shapes page counts 0 again").toHaveText("0");
    });

    await test.step("the same Map once more (the Undo was the first time)", async () => {
      await chooseEnergyCounters(page);
      const { go } = await openReview(page);
      await go.click();
      await expect(reviewDialog(page)).toBeHidden({ timeout: 60_000 });
      await expect(toast(page, `Created ${MAPPINGS} mappings.`).last()).toBeVisible();
      await expect(tile(page, "Mapped")).toHaveText(String(MAPPINGS));
    });
  });

  test("4. the result: 48 assets under the hall, an energy counter mapped to each, and Discovery says so and still draws a handful of nodes", async ({ page }) => {
    needSetup();
    test.setTimeout(120_000);
    const request = page.request;
    const wanted = ["A", "B"].flatMap((feed) => Array.from({ length: PER_FEED }, (_, i) => `PDU${feed}${String(i + 1).padStart(2, "0")}`));

    const kids = await kidsOfHall(request);
    expect(kids.map((a) => a.name).sort(), `PDUA01..PDUA${PER_FEED} and PDUB01..PDUB${PER_FEED} are under the hall`).toEqual([...wanted].sort());
    const byId = new Map(kids.map((a) => [a.id, a]));
    const mapped = (await pointsOf(request)).filter((p) => p.mapping !== null);
    expect(mapped, `${MAPPINGS} mappings on this source`).toHaveLength(MAPPINGS);
    for (const point of mapped) {
      expect(point.mapping!.metric, `${point.name} is an energy counter`).toBe("energy_kwh");
      expect(point.address.endsWith("_PM0_PENRG"), `${point.address} is a PENRG tag`).toBe(true);
      const asset = byId.get(point.mapping!.asset_id);
      expect(asset?.name, `${point.name} sits on the asset of its meter, under the hall`).toBe(point.name.split("_")[0]);
    }
    const source = (await json<ApiGraph>(request, "/api/discovery/graph")).sources.find((s) => s.id === world.sourceId);
    expect(source?.large, "the graph counts them").toMatchObject({ points: TAGS, mapped: MAPPINGS, unmapped: TAGS - MAPPINGS });

    const card = await openDiscovery(page);
    await expect(card.locator(".gsrc-words")).toHaveText(`${grouped(TAGS)} points, ${MAPPINGS} mapped`);
    const ids = new Set(mapped.map((p) => `point:${p.id}`));
    const drawn = await page.locator(".react-flow__node").evaluateAll(
      (nodes, args) => nodes.map((n) => n.getAttribute("data-id") ?? "").filter((id) => id === args.src || id.startsWith(args.clusters) || args.points.includes(id)),
      { src: `src:${world.sourceId}`, clusters: `cluster:${world.sourceId}:`, points: [...ids] },
    );
    expect(drawn.length, `the source draws ${drawn.length} nodes at rest (${drawn.slice(0, 6).join(", ")})`).toBeLessThanOrEqual(5);
  });

  test("5. a reader: a role with discovery.view only sees the rows, read-only, with no Review button, no bar, a 403 from the lines route and no link to the Points page", async ({ browser, page }) => {
    needSetup();
    test.setTimeout(180_000);
    await asAdmin(browser, async (request) => {
      const role = await request.post("/api/roles", { data: { name: ROLE, description: "made by w36.spec.ts", permissions: ["discovery.view"] } });
      expect(role.status(), `creating the role: ${await role.text()}`).toBe(201);
      const user = await request.post("/api/users", { data: { username: USER, password: PASSWORD, role: ROLE } });
      expect(user.status(), `creating the account: ${await user.text()}`).toBe(201);
    });

    // The simulator's tags all fall into shapes, so the page has no "Other tags" line of its own. The page's gate on its link to the Points page is client code: the same answer with three other tags
    // in it (the only change) shows the line, and the link is there only for a person who may open that page.
    const withOtherTags = async (target: Page) => {
      await target.route(/\/api\/sources\/\d+\/shapes(\?.*)?$/, async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        const other = [{ name: "SPARE_ONE", address: "ns=3;s=1:Site.SPARE_ONE" }, { name: "SPARE_TWO", address: "ns=3;s=2:Site.SPARE_TWO" }, { name: "SPARE_THREE", address: "ns=3;s=3:Site.SPARE_THREE" }];
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...body, other_tags: other.length, other_examples: other }) });
      });
    };
    const pointsLink = (target: Page) => target.getByRole("link", { name: "See them on the Points page", exact: true });

    await test.step("the administrator sees the Other tags line with its link to the Points page", async () => {
      await withOtherTags(page);
      await page.goto(shapesUrl());
      await expect(shapesHeading(page)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Other tags (3)", { exact: true })).toBeVisible();
      await expect(pointsLink(page)).toBeVisible();
    });

    const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 } });
    try {
      const login = await context.request.post("/api/login", { data: { username: USER, password: PASSWORD } });
      expect(login.ok(), `${USER} signs in: ${login.status()} ${await login.text()}`).toBe(true);
      const reader = await context.newPage();
      await withOtherTags(reader);

      await test.step("the reader opens the shapes page and sees the rows", async () => {
        await reader.goto(shapesUrl());
        await expect(shapesHeading(reader)).toBeVisible({ timeout: 30_000 });
        await expect(billingSection(reader).getByRole("group", { name: `Shape ${A}`, exact: true }), "the rows are there").toBeVisible();
        await expect(reader.getByText("Your role can look at the shapes but not map them.", { exact: false })).toBeVisible();
      });

      await test.step("the decisions are text; there is no Review button and no bar under the table", async () => {
        await expect(reader.getByRole("combobox", { name: /^Decision for / }), "no select to decide with").toHaveCount(0);
        await expect(reader.getByRole("checkbox", { name: /^Same decision for / }), "no tick").toHaveCount(0);
        const text = reader.locator(".shape-row .shape-readonly");
        expect(await text.count(), "every row says its decision in words").toBeGreaterThan(0);
        await expect(text.first()).toHaveText(/^Decision: /);
        await expect(reader.getByRole("button", { name: /^Review / }), "no Review button").toHaveCount(0);
        await expect(reader.locator(".shapes-bar"), "no bar").toHaveCount(0);
        await expect(reader.getByLabel("Put new assets under", { exact: true })).toHaveCount(0);
      });

      await test.step("the lines route answers 403 to the reader, the read does not", async () => {
        const lines = await context.request.post(`/api/sources/${world.sourceId}/shapes/lines`, {
          data: { decisions: [{ shape: "pdua#_pm#_penrg", metric: "energy_kwh", name_from: "part1" }], parent_id: null, create_assets: true },
        });
        expect(lines.status(), "building lines needs discovery.accept").toBe(403);
        expect((await context.request.get(`/api/sources/${world.sourceId}/shapes`)).status(), "reading the shapes needs discovery.view only").toBe(200);
      });

      await test.step("without sources.edit the Other tags line has no link to the Points page", async () => {
        await expect(reader.getByText("Other tags (3)", { exact: true }), "the line itself is there").toBeVisible();
        await expect(pointsLink(reader)).toHaveCount(0);
      });
    } finally {
      await context.close();
    }
  });

  test("6. the look at 1024 x 768, sidebar expanded and minimised: the shapes page does not overflow, its bar, button and dialog are in the window, and the card's buttons are inside the card", async ({ page }) => {
    needSetup();
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1024, height: 768 });
    const view = { width: 1024, height: 768 };
    const inside = (box: { x: number; y: number; width: number; height: number } | null) =>
      box !== null && box.x >= -0.5 && box.y >= -0.5 && box.x + box.width <= view.width + 0.5 && box.y + box.height <= view.height + 0.5;

    await page.goto(shapesUrl());
    await expect(shapesHeading(page)).toBeVisible({ timeout: 30_000 });
    await chooseEnergyCounters(page);

    for (const want of ["expanded", "minimized"] as const) {
      await test.step(`the shapes page, sidebar ${want}`, async () => {
        await sidebar(page, want);
        const bar = await settledBox(page.locator(".shapes-bar"));
        const button = await settledBox(reviewButton(page));
        expect(inside(bar), `the bottom bar lies inside the window: ${JSON.stringify(bar)}`).toBe(true);
        expect(inside(button), `Review ${MAPPINGS} mappings... lies inside the window: ${JSON.stringify(button)}`).toBe(true);
        const overflow = await page.evaluate((width) => {
          const out: string[] = [];
          for (let el: HTMLElement | null = document.querySelector<HTMLElement>(".shapes-page"); el && !el.classList.contains("shell"); el = el.parentElement) {
            if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.tagName.toLowerCase()}.${el.className}: ${el.scrollWidth} > ${el.clientWidth}`);
          }
          const wide = Array.from(document.querySelectorAll<HTMLElement>(".shapes-page *"))
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && (r.right > width + 1 || r.left < -1);
            })
            .slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
          return { out, wide };
        }, view.width);
        expect(overflow.out, "no element from the page up to the shell scrolls sideways").toEqual([]);
        expect(overflow.wide, "nothing sticks out of the window").toEqual([]);
      });
    }

    await test.step("the open dialog lies inside the window with both buttons", async () => {
      await sidebar(page, "expanded");
      await reviewButton(page).click();
      const dialog = reviewDialog(page);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: /^Map / }), "the dialog is read").toBeVisible({ timeout: 60_000 });
      await expect(dialog.getByRole("status")).not.toHaveText(/^Asking the server|^Checking the list/, { timeout: 60_000 });
      expect(inside(await settledBox(dialog)), "the dialog lies inside the window").toBe(true);
      expect(inside(await settledBox(dialog.getByRole("button", { name: "Cancel", exact: true }))), "Cancel is in the window").toBe(true);
      expect(inside(await settledBox(dialog.getByRole("button", { name: /^Map / }))), "and so is the Map button").toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });

    for (const want of ["expanded", "minimized"] as const) {
      await test.step(`the large card on Discovery, sidebar ${want}: every button lies inside the card, whole and not cut`, async () => {
        const card = await openDiscovery(page);
        await sidebar(page, want);
        const buttons = await card.evaluate((node) => {
          const frame = node.getBoundingClientRect();
          return Array.from(node.querySelectorAll<HTMLElement>("button")).map((b) => {
            const r = b.getBoundingClientRect();
            return {
              name: b.getAttribute("aria-label") ?? b.textContent ?? "", left: r.left, right: r.right, top: r.top, bottom: r.bottom,
              inside: r.left >= frame.left - 1 && r.right <= frame.right + 1 && r.top >= frame.top - 1 && r.bottom <= frame.bottom + 1,
              cut: b.scrollWidth > b.clientWidth + 1,
            };
          });
        });
        const names = buttons.map((b) => b.name);
        expect(names, "the card has its Details and Map by shape buttons").toEqual(expect.arrayContaining([`Details for ${SOURCE}`, `Map by shape for ${SOURCE}`]));
        for (const b of buttons) {
          expect(b.inside, `${b.name} lies inside the card`).toBe(true);
          expect(b.cut, `${b.name} is not cut off`).toBe(false);
        }
        for (const [i, a] of buttons.entries()) {
          for (const b of buttons.slice(i + 1)) {
            const apart = a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
            expect(apart, `${a.name} and ${b.name} do not overlap`).toBe(true);
          }
        }
      });
    }
  });
});
