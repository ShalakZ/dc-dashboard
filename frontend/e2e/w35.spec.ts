import { expect, test, type APIRequestContext, type APIResponse, type Browser, type Page } from "@playwright/test";

// W35 (the data watchdog): a billing meter that stops giving good readings turns the top bar's chip to `N of M meters stale`, puts a line under the age on Sources, makes the data health URL answer 503, and opens ONE
// `data.stale` incident in System events; deleting the source puts all of it back. Admin `admin` / `correct-horse`. The contract is the plan docs/superpowers/plans/2026-10-23-w35-data-freshness-watchdog.md
// (Rulings A to F, the fold-in I5, I10, I13, M5, M9) and the rulings of .waves/w35.md.
//
// IT MAKES ITS OWN DATA and needs nothing from the stack beyond the sign-in and the simulator: the asset `W35 <run>` and the `simulator` source `W35 <run> sim` (at the live simulator `http://simulator:9000`, key
// `sim-key`, as w32's) with ONE energy counter (`LVP01_kWh`) mapped at a 5 s interval. Names: `W35 <run> ...` (unique per run). afterAll puts the watchdog setting back and removes the asset and the source, each step on
// its own and also after a failed case; beforeAll sweeps what an earlier run that stopped half way left (a floor of 2 minutes is that run's: it is put back to the factory value before this one reads "the old value").
// The STALE FLOOR is set to 2 minutes (the setting's lowest) so that the wait is minutes, not the factory five; it is the only value this spec changes and afterAll restores it.
//   1  THE SETUP. The floor is put to 2 minutes FIRST (lowering it can turn other meters of the stack stale at once, so every baseline is read after it), the source is browsed, ONE `energy_kwh` point is mapped on the new
//      asset, and the spec waits for the source's first reading (plan I5: a meter with no reading yet is "waiting", never stale, so nothing is broken before this). Baselines: `meters_stale` and the
//      health URL's status, and the top bar's size at 1024 x 768 with the sidebar expanded and minimised.
//   2  THE BREAK. The source's address is changed to `http://simulator:9` (nothing listens). Polling /api/status every 5 s (up to 4 minutes), `meters_stale` rises by at least one, and the source's own row says
//      one stale meter.
//   3  THE CHIP. `data-state="stale"`, the word `N of M meters stale` (N at least the baseline plus one) and the detail `oldest ... ago`. At 1024 x 768, sidebar expanded and minimised, the chip keeps the bar's height
//      and its own, lies inside the bar, overlaps nothing and reads `N meters stale` (the ` of M` part is dropped by the stylesheet below 1180 px).
//   4  SOURCES. The row of the source has a warning line `1 of 1 meter stale` under the age in the Last reading cell.
//   5  THE URL. GET /api/health/data without a cookie answers 503, status `stale`, the nine keys and nothing else, and no name, asset or address in the body.
//   6  EVENTS. The figures worker evaluates once a minute and opens the incident on the second look, so it appears 1 to 3 minutes after the meter turned stale: polled every 10 s for up to 5 minutes. The Sources
//      banner's **See its events** (the page's clock three minutes ahead, as w32) opens System events; the pinned line `<source> has stale meters since ... 1 of 1 meter has no good reading.` and ONE row,
//      still counting no "failed" reads.
//   7  THE WAY BACK. The source is deleted: `meters_stale` returns to the baseline, the chip is not stale (`Live` when the baseline was clean), the URL answers 200 when it did at the baseline, and the incident closes
//      as `polling_stopped` (the figures worker's next look; up to 3 minutes) and is no longer pinned.
//   8  STORAGE. The card **Data watchdog** shows the summary with the two numbers; **Change...** opens the dialog named `Change when meters count as stale`; Escape closes it with the focus back on the button;
//      nothing is saved.
// Playwright matches names by SUBSTRING and case-insensitively: every lookup that could meet a longer name is `exact: true` ("Data watchdog" is the heading; the Storage page has TWO Change... buttons, so the button is
// looked up inside its card). The cases are SERIAL and depend on each other (the source of case 1 is the subject of the others), so a failing case skips the ones after it.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";

const RUN = Date.now().toString(36);
/** A name that belongs to this run. */
const name = (what: string): string => `W35 ${RUN} ${what}`;
/** What an earlier run that stopped half way may have left behind: `W35 ` and a run id (Date.now() in base 36 is 8 characters until 2059). The asset is `W35 <run>` itself. */
const LEFTOVER = /^W35 [0-9a-z]{8}( |$)/;

const SOURCE = name("sim");
const ASSET = `W35 ${RUN}`;
const LIVE = "http://simulator:9000";
const DEAD = "http://simulator:9";
const SIM_KEY = "sim-key";
const POINT = "LVP01_kWh";
const POLL_SECONDS = 5;
/** The lowest floor the setting allows (minutes): the wait for the stale verdict is this long at least. */
const TEST_FLOOR = 2;
/** The time the page's clock is put ahead of the server's, so that the Sources banner (an outage older than 120 s) needs no real wait. */
const AHEAD_MS = 180_000;
/** The keys of the data health URL's body (the public contract: counts and a state, never a name, an address or a value). */
const URL_KEYS = ["status", "meters", "stale", "not_advancing", "waiting", "frozen_sources", "oldest_stale_age_seconds", "collector_alive", "rollups_late"];

// ---------------------------------------------------------------------------------------------------------------------------------
// The API shapes this spec reads (written here, so a change of the server shows up as a failure)

interface ApiMeters { total: number; stale: number; not_advancing: number; frozen: boolean; oldest_stale_age_seconds: number | null }
interface ApiSource { id: number; name: string; status: string; last_reading_age_seconds: number | null; meters?: ApiMeters | null }
interface ApiAsset { id: number; parent_id: number | null; name: string }
interface ApiPoint { id: number; address: string }
interface ApiJob { id: number; status: string }
interface ApiStatus {
  collector_alive: boolean; readings_fresh: boolean | null;
  meters?: number | null; meters_stale?: number | null; meters_not_advancing?: number | null; meters_waiting?: number | null; oldest_stale_age_seconds?: number | null;
}
interface WatchdogValues { stale_floor_minutes: number; not_advancing_hours: number }
interface ApiWatchdog extends WatchdogValues { factory: WatchdogValues; bounds: Record<string, [number, number]> }
interface ApiIncident { state: "open" | "closed"; count: number; closed_by: string | null }
interface ApiEvent { id: number; kind: string; message: string; incident: ApiIncident | null }
interface ApiEventPage { items: ApiEvent[] }
/** The top bar at one width and state of the sidebar: its height, the chip's, how far the bar scrolls sideways and which controls the chip overlaps. */
interface Bar { bar: number; chip: number; overflow: number; covered: string[] }

async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}
const statusOf = (request: APIRequestContext) => json<ApiStatus>(request, "/api/status");
/** A poll's reading that survives a request failing for a moment (the collector reloads when a source changes): the poll goes on with `fallback` instead of ending with that error. */
async function soft<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Runs `use` with the request context of a fresh browser context in which the admin is signed in. */
async function asAdmin<T>(browser: Browser, use: (request: APIRequestContext) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    const login = await context.request.post("/api/login", { data: ADMIN });
    expect(login.ok(), `the admin signs in: ${login.status()} ${await login.text()}`).toBe(true);
    return await use(context.request);
  } finally {
    await context.close();
  }
}

async function signIn(page: Page): Promise<void> {
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in: ${login.status()} ${await login.text()}`).toBe(true);
}

/** What the cases hand to each other. */
const world = {
  sourceId: 0, assetId: 0,
  /** The watchdog values to put back (null until beforeAll has read them). */
  old: null as WatchdogValues | null,
  /** `meters_stale` and the health URL's status before anything of this spec is broken. */
  staleBefore: 0, healthBefore: 0,
  bars: null as Record<Sidebar, Bar> | null,
};

async function putWatchdog(request: APIRequestContext, values: WatchdogValues): Promise<void> {
  const put = await request.put("/api/settings/watchdog", { data: values });
  expect(put.ok(), `saving the watchdog setting: ${put.status()} ${await put.text()}`).toBe(true);
}

/**
 * Everything this spec may have made, in the order that works: the setting back to its old values, then the asset (its mapping goes with it), then the source (404 is fine: case 7 deleted it). Each step on its own;
 * the problems are raised at the end.
 */
async function removeMine(request: APIRequestContext, restoreSetting: boolean): Promise<void> {
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
  if (restoreSetting && world.old) {
    const old = world.old;
    await attempt("the watchdog setting", () => putWatchdog(request, old));
  }
  await attempt("the assets", async () => {
    for (const asset of (await json<ApiAsset[]>(request, "/api/assets")).filter((a) => a.parent_id === null && LEFTOVER.test(a.name))) await gone(`asset ${asset.name}`, await request.delete(`/api/assets/${asset.id}?confirm=true`));
  });
  await attempt("the sources", async () => {
    for (const source of (await json<ApiSource[]>(request, "/api/sources")).filter((s) => LEFTOVER.test(s.name))) await gone(`source ${source.name}`, await request.delete(`/api/sources/${source.id}?confirm=true`));
  });
  expect(problems, "everything this spec made was removed").toEqual([]);
}

test.beforeAll(async ({ browser }) => {
  await asAdmin(browser, async (request) => {
    const current = await json<ApiWatchdog>(request, "/api/settings/watchdog");
    // A floor of 2 minutes is what a run of this spec that stopped half way leaves; nobody chose it, so the factory floor is the "old" value (the hours are never changed here).
    world.old = {
      stale_floor_minutes: current.stale_floor_minutes === TEST_FLOOR ? current.factory.stale_floor_minutes : current.stale_floor_minutes,
      not_advancing_hours: current.not_advancing_hours,
    };
    await removeMine(request, current.stale_floor_minutes === TEST_FLOOR); // what an earlier run left behind
  });
});

test.afterAll(async ({ browser }) => {
  await asAdmin(browser, (request) => removeMine(request, true));
});

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

/** Every case after the first needs its source: when the setup failed they skip (a failing case skips the rest anyway; this keeps a skipped run readable). */
const needSetup = () => test.skip(world.sourceId === 0, "the setup (case 1) did not make the source");

// ---------------------------------------------------------------------------------------------------------------------------------
// Locators and small helpers for the pages

const heading1 = (page: Page, text: string) => page.getByRole("heading", { level: 1, name: text, exact: true });
const heading2 = (page: Page, text: string) => page.getByRole("heading", { level: 2, name: text, exact: true });
/** A Sources row, found by the title of its name cell (the cell holds a second line, so the cell's own name is not the source's). */
const sourceRow = (page: Page, sourceName: string) => page.getByRole("row").filter({ has: page.locator(`.cell-name[title="${sourceName}"]`) });
/** The top bar's chip, its word (the one live region) and its caption. */
const chipOf = (page: Page) => page.locator(".navbar .live");
const wordOf = (page: Page) => chipOf(page).getByRole("status");

type Sidebar = "expanded" | "minimized";

async function sidebar(page: Page, want: Sidebar): Promise<void> {
  const shell = page.locator(".shell");
  if ((await shell.getAttribute("data-sidebar")) !== want) await page.locator(".side-toggle").click();
  await expect(shell).toHaveAttribute("data-sidebar", want);
}

/** The bar's and the chip's boxes, taken again until two reads in a row agree (the sidebar animates its width). */
async function settledBar(page: Page): Promise<{ bar: DOMRect; chip: DOMRect; overflow: number; covered: string[] }> {
  let previous = "";
  let last!: { bar: DOMRect; chip: DOMRect; overflow: number; covered: string[] };
  await expect.poll(async () => {
    last = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>(".navbar")!;
      const chip = document.querySelector<HTMLElement>(".navbar .live")!;
      const c = chip.getBoundingClientRect();
      const covered = Array.from(document.querySelectorAll<HTMLElement>(".navbar button, .navbar a, .navbar input, .navbar .site-time"))
        .filter((el) => !chip.contains(el) && !el.contains(chip))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.left < c.right - 0.5 && r.right > c.left + 0.5 && r.top < c.bottom - 0.5 && r.bottom > c.top + 0.5;
        })
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
      return { bar: bar.getBoundingClientRect().toJSON() as DOMRect, chip: c.toJSON() as DOMRect, overflow: bar.scrollWidth - bar.clientWidth, covered };
    });
    const now = JSON.stringify(last);
    const same = now === previous;
    previous = now;
    return same;
  }, { intervals: [150], message: "the top bar never stopped moving" }).toBe(true);
  return last;
}

/** The bar's and the chip's measures at 1024 x 768 in both states of the sidebar; also asserts what holds in any state: the chip lies inside the bar. */
async function measureBars(page: Page): Promise<Record<Sidebar, Bar>> {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/assets");
  await expect(chipOf(page)).toBeVisible({ timeout: 30_000 });
  const out = {} as Record<Sidebar, Bar>;
  for (const want of ["expanded", "minimized"] as const) {
    await sidebar(page, want);
    const { bar, chip, overflow, covered } = await settledBar(page);
    const where = `1024 x 768, sidebar ${want}`;
    expect(chip.top, `${where}: the chip starts inside the bar`).toBeGreaterThanOrEqual(bar.top - 0.5);
    expect(chip.bottom, `${where}: the chip ends inside the bar`).toBeLessThanOrEqual(bar.bottom + 0.5);
    expect(chip.right, `${where}: the chip does not run past the bar`).toBeLessThanOrEqual(bar.right + 0.5);
    out[want] = { bar: bar.height, chip: chip.height, overflow, covered };
  }
  return out;
}

/** The newest `data.stale` item the journal holds for the source (open ones only when `open`), or null. The kind is filtered here, not in the query. */
async function staleEvent(request: APIRequestContext, open: boolean): Promise<ApiEvent | null> {
  const page = await json<ApiEventPage>(request, `/api/events?source=${world.sourceId}&limit=100${open ? "&open=1" : ""}`);
  return page.items.find((e) => e.kind === "data.stale") ?? null;
}

const theSource = async (request: APIRequestContext): Promise<ApiSource | undefined> => (await json<ApiSource[]>(request, "/api/sources")).find((s) => s.id === world.sourceId);

/** The data health URL as a monitor sees it: no cookie (the `request` fixture has its own jar, never the page's). */
async function healthOf(anonymous: APIRequestContext): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const response = await anonymous.get("/api/health/data");
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // the assertions below say what the answer was
  }
  return { status: response.status(), text, body };
}

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W35: the data watchdog", () => {
  test.describe.configure({ mode: "serial" });

  test("1. the setup: a source with one energy counter at 5 s has its first reading; the floor is 2 minutes; the baselines", async ({ page, request: anonymous }) => {
    test.setTimeout(240_000);
    const request = page.request;

    await test.step("the stale floor is put to 2 minutes FIRST (it can turn other meters stale at once, so the baselines come after)", async () => {
      await putWatchdog(request, { stale_floor_minutes: TEST_FLOOR, not_advancing_hours: world.old!.not_advancing_hours });
      expect((await json<ApiWatchdog>(request, "/api/settings/watchdog")).stale_floor_minutes).toBe(TEST_FLOOR);
    });

    await test.step("an asset, a simulator source at the live simulator, its points browsed and ONE energy counter mapped at a 5 s interval", async () => {
      const asset = await request.post("/api/assets", { data: { name: ASSET, parent_id: null, kind: "generic", sort_order: 0 } });
      expect(asset.status(), `creating the asset: ${await asset.text()}`).toBe(201);
      world.assetId = ((await asset.json()) as ApiAsset).id;

      const made = await request.post("/api/sources", { data: { name: SOURCE, connector_type: "simulator", config: { url: LIVE }, secret: SIM_KEY, enabled: true } });
      expect(made.status(), `creating the source: ${await made.text()}`).toBe(201);
      world.sourceId = ((await made.json()) as ApiSource).id;

      const browse = await request.post(`/api/sources/${world.sourceId}/browse`);
      expect(browse.status(), `browsing: ${await browse.text()}`).toBe(202);
      const jobId = ((await browse.json()) as { job_id: number }).job_id;
      await expect.poll(async () => (await json<ApiJob>(request, `/api/jobs/${jobId}`)).status, { message: "the browse job ends", timeout: 30_000 }).toBe("done");

      const point = (await json<ApiPoint[]>(request, `/api/sources/${world.sourceId}/points`)).find((p) => p.address === POINT);
      expect(point, `the simulator has the point ${POINT}`).toBeDefined();
      const mapped = await request.post("/api/mappings", { data: { point_id: point!.id, asset_id: world.assetId, metric: "energy_kwh", interval_seconds: POLL_SECONDS } });
      expect(mapped.status(), `mapping the point: ${await mapped.text()}`).toBe(201);
    });

    await test.step("the collector polls it: the first reading is there (a meter with no reading yet is waiting, and nothing is broken before this)", async () => {
      await expect
        .poll(async () => {
          const source = await soft(() => theSource(request), undefined);
          return source?.status === "online" && source.last_reading_age_seconds !== null && (source.meters?.total ?? 0) >= 1;
        }, { message: "the source is polled, online, and has one billing meter", timeout: 90_000, intervals: [1_000, 2_000] })
        .toBe(true);
      const source = (await theSource(request))!;
      expect(source.meters, "its meter is fresh").toMatchObject({ total: 1, stale: 0 });
    });

    await test.step("the baselines: how many meters are stale, what the health URL says, and the top bar at 1024 x 768", async () => {
      const status = await statusOf(request);
      expect(typeof status.meters_stale, `/api/status carries meters_stale (${JSON.stringify(status)})`).toBe("number");
      expect(status.meters ?? 0, "the stack has at least this spec's meter").toBeGreaterThanOrEqual(1);
      world.staleBefore = status.meters_stale!;
      // (a verdict that is momentarily unavailable would be a 503 that means nothing: the baseline waits for a real answer)
      await expect
        .poll(async () => {
          const answer = await healthOf(anonymous);
          world.healthBefore = answer.status;
          return answer.body.status !== "unavailable";
        }, { message: "the data health URL answers with a verdict", timeout: 30_000, intervals: [2_000] })
        .toBe(true);
      world.bars = await measureBars(page);
    });
  });

  test("2. the source's address is changed to one nothing listens at: within minutes meters_stale rises, and the source's row says one stale meter", async ({ page }) => {
    needSetup();
    test.setTimeout(330_000);
    const request = page.request;
    const changed = await request.patch(`/api/sources/${world.sourceId}`, { data: { config: { url: DEAD } } });
    expect(changed.ok(), `changing the address: ${changed.status()} ${await changed.text()}`).toBe(true);

    // The meter is stale once it has had no good reading for max(3 x 5 s, 2 minutes); the status is polled every 5 s.
    await expect
      .poll(async () => {
        const [status, source] = await Promise.all([soft(() => statusOf(request), null), soft(() => theSource(request), undefined)]);
        return (status?.meters_stale ?? 0) >= world.staleBefore + 1 && (source?.meters?.stale ?? 0) >= 1;
      }, { message: `meters_stale rose from ${world.staleBefore} and the source reports a stale meter within 4 minutes`, timeout: 240_000, intervals: [5_000] })
      .toBe(true);
    const source = (await theSource(request))!;
    expect(source.status, "the source reads offline").toBe("offline");
    expect(source.meters, "one meter, silent").toMatchObject({ total: 1, stale: 1, frozen: false });
    expect(source.meters!.oldest_stale_age_seconds, "the silence is at least the floor").toBeGreaterThanOrEqual(TEST_FLOOR * 60);
  });

  test("3. the chip: stale, with the count and the oldest age; at 1024 x 768 it keeps the bar's height with the sidebar expanded and minimised", async ({ page }) => {
    needSetup();
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/assets");
    const chip = chipOf(page);
    await expect(chip).toHaveAttribute("data-state", "stale", { timeout: 30_000 });
    const word = wordOf(page);
    await expect(word, "the word names how many meters are stale, of how many").toHaveText(/^\d+ of \d+ meters? stale$/);
    const stale = Number(/^(\d+) of/.exec((await word.textContent()) ?? "")![1]);
    expect(stale, "at least this spec's meter, on top of the baseline").toBeGreaterThanOrEqual(world.staleBefore + 1);
    await expect(chip.locator(".detail"), "the caption says how long the longest silence is").toHaveText(/^\s*·\s*oldest \d+ (s|min|h|d) ago\s*$/);

    const before = world.bars!;
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/assets");
    await expect(chip).toHaveAttribute("data-state", "stale", { timeout: 30_000 });
    for (const want of ["expanded", "minimized"] as const) {
      await sidebar(page, want);
      const where = `1024 x 768, sidebar ${want}`;
      // the narrow word has no " of M" and no caption (the stylesheet drops them below 1180 px); innerText is what is on screen
      await expect(word, `${where}: the word is there and short`).toHaveText(/^\d+ meters? stale$/, { useInnerText: true });
      await expect(chip.locator(".detail"), `${where}: the caption is dropped`).toBeHidden();
    }
    const after = await measureBars(page);
    for (const want of ["expanded", "minimized"] as const) {
      expect(Math.abs(after[want].bar - before[want].bar), `sidebar ${want}: the stale chip does not change the bar's height (${before[want].bar} -> ${after[want].bar})`).toBeLessThanOrEqual(1);
      expect(Math.abs(after[want].chip - before[want].chip), `sidebar ${want}: nor its own height (${before[want].chip} -> ${after[want].chip})`).toBeLessThanOrEqual(1);
      expect(after[want].overflow, `sidebar ${want}: the bar scrolls sideways no more than before`).toBeLessThanOrEqual(before[want].overflow);
      expect(after[want].covered, `sidebar ${want}: the chip covers the same controls as before (none)`).toEqual(before[want].covered);
    }
  });

  test("4. Sources: the row of the source says how many of its meters are stale, under the age in the Last reading cell", async ({ page }) => {
    needSetup();
    await page.goto("/sources");
    await expect(heading1(page, "Sources")).toBeVisible();
    const row = sourceRow(page, SOURCE);
    await expect(row).toBeVisible();
    const cell = row.locator("td.num");
    const line = cell.locator(".cell-meters");
    await expect(line, "the Last reading cell has the watchdog's line").toHaveText(/\d+ of \d+ meters? stale/);
    await expect(line).toHaveText("1 of 1 meter stale");
    await expect(line, "in the warning ink").toHaveClass(/\bwarning\b/);
    await expect(cell, "the age is still there, above it").toContainText(/\d.*ago/);
  });

  test("5. the data health URL: 503 without a cookie, status stale, the nine keys, and no name, asset or address", async ({ request: anonymous }) => {
    needSetup();
    // (the `request` fixture has a cookie jar of its own: this call carries no session)
    const answer = await healthOf(anonymous);
    expect(answer.status, `GET /api/health/data answered ${answer.status}: ${answer.text} (a DCDASH_HEALTH_TOKEN on the stack would make it 401)`).toBe(503);
    expect(answer.body.status, "the state").toBe("stale");
    expect(Object.keys(answer.body).sort(), "exactly the public keys").toEqual([...URL_KEYS].sort());
    expect(answer.body.stale as number, "at least this spec's meter").toBeGreaterThanOrEqual(world.staleBefore + 1);
    expect(answer.body.collector_alive).toBe(true);
    for (const secret of [SOURCE, ASSET, name(""), "W35", "simulator", POINT, "LVP01"]) {
      expect(answer.text, `the body does not contain "${secret}"`).not.toContain(secret);
    }
  });

  test("6. System events: the figures worker opens ONE data.stale incident; the Sources banner's link, the pinned line and one row", async ({ page }) => {
    needSetup();
    test.setTimeout(480_000);
    const request = page.request;

    // The figures service evaluates once a minute, on loop turns 60 to 90 s apart, and opens an incident on the SECOND look that finds trouble: 1 to 3 minutes after the meter turned stale.
    await expect
      .poll(async () => (await soft(() => staleEvent(request, true), null)) !== null, {
        message: `the figures worker never opened a data.stale incident for ${SOURCE} within 5 minutes of the meter turning stale (it evaluates every 60 s and opens on the second look)`,
        timeout: 300_000, intervals: [10_000],
      })
      .toBe(true);
    const incident = (await staleEvent(request, true))!;
    expect(incident.incident?.state, "an incident, open").toBe("open");

    // The banner of a long outage (the clock is put ahead before the page loads: the outage must be older than two minutes) and its link, as in w32.
    await page.clock.install({ time: Date.now() + AHEAD_MS });
    await page.goto("/sources");
    await expect(heading1(page, "Sources")).toBeVisible();
    await expect(sourceRow(page, SOURCE)).toBeVisible();
    const banner = page.locator(".banner").filter({ hasText: /(is|are) offline/ }).filter({ hasText: SOURCE });
    await expect(banner, "the banner names the source").toBeVisible();
    const link = banner.getByRole("link", { name: "See its events", exact: true });
    const one = /^\s*1 source is offline/.test((await banner.textContent()) ?? ""); // read before the page changes
    await link.click();
    await expect(page).toHaveURL(/\/events(\?|$)/);
    await expect(heading1(page, "System events")).toBeVisible();
    // With one source offline for long the link names that source; with several it opens the whole page, and the filter is put on by the address.
    if (one) await expect(page).toHaveURL(new RegExp(`source=${world.sourceId}(&|$)`));
    else await page.goto(`/events?source=${world.sourceId}`);
    await expect(heading1(page, "System events")).toBeVisible();

    await expect(heading2(page, "Happening now")).toBeVisible();
    const lines = page.locator(".open-now li .open-text").filter({ hasText: "has stale meters" });
    await expect(lines, "ONE pinned line for the stale meters (the offline incident has its own)").toHaveCount(1);
    await expect(lines.first()).toHaveText(new RegExp(`^${escaped(SOURCE)} has stale meters since \\d{1,2} [A-Z][a-z]{2} \\d{2}:\\d{2} \\(.+\\)\\. 1 of 1 meter has no good reading\\.$`));
    await expect(lines.first(), "never the words of a failed read").not.toContainText(/offline|failed/);

    const rows = page.locator(".events-table tbody tr").filter({ hasText: "has no good reading" });
    await expect(rows, "ONE row for the incident").toHaveCount(1);
    await expect(rows.first().locator("td.cell-count"), "it says it is ongoing and counts no failed reads").toContainText("ongoing");
    await expect(rows.first().locator("td.cell-count")).not.toContainText("failed");
    await expect(rows.first().locator("td.cell-source")).toContainText(SOURCE);
  });

  test("7. the way back: the source is deleted, meters_stale returns to the baseline, the chip and the URL are back, and the incident closes as polling_stopped", async ({ page, request: anonymous }) => {
    needSetup();
    test.setTimeout(420_000);
    const request = page.request;
    const gone = await request.delete(`/api/sources/${world.sourceId}?confirm=true`);
    expect(gone.status(), `deleting the source: ${await gone.text()}`).toBe(204);

    await expect
      .poll(async () => (await soft(() => statusOf(request), null))?.meters_stale ?? -1, { message: `meters_stale is back to ${world.staleBefore}`, timeout: 90_000, intervals: [3_000] })
      .toBe(world.staleBefore);

    await page.goto("/assets");
    const chip = chipOf(page);
    if (world.staleBefore === 0) {
      // nothing else on the stack is stale: the chip is what it was before this spec broke anything
      await expect(wordOf(page)).toHaveText("Live", { timeout: 30_000 });
      await expect(chip).toHaveAttribute("data-state", "live");
    } else {
      // other meters of the stack were stale before this spec started and still are: the chip counts exactly those, not one more
      await expect(wordOf(page), "the chip counts only the meters that were stale before").toHaveText(new RegExp(`^${world.staleBefore} of \\d+ meters? stale$`), { timeout: 30_000 });
    }

    // The URL answers as it did at the start (200 when the stack was clean then); a verdict that is momentarily unavailable is polled past.
    await expect
      .poll(async () => {
        const answer = await soft(() => healthOf(anonymous), null);
        return answer === null || (answer.status === 503 && answer.body.status === "unavailable") ? -1 : answer.status;
      }, { message: `the data health URL answers ${world.healthBefore} again`, timeout: 60_000, intervals: [3_000] })
      .toBe(world.healthBefore);
    const back = await healthOf(anonymous);
    expect(back.body.stale, "the URL counts the baseline's stale meters").toBe(world.staleBefore);

    // The figures worker's next look closes the incident of a source that is no longer judged; no recovery event, because the meters did not come back.
    await expect
      .poll(async () => (await soft(() => staleEvent(request, true), undefined)) === null, { message: "the data.stale incident is no longer open (within 3 minutes)", timeout: 180_000, intervals: [10_000] })
      .toBe(true);
    const closed = await staleEvent(request, false);
    expect(closed?.incident, "the incident is still in the journal").toMatchObject({ state: "closed", closed_by: "polling_stopped" });

    await page.goto("/events");
    await expect(heading1(page, "System events")).toBeVisible();
    await expect(heading2(page, "Happening now")).toBeVisible();
    // loaded: either "No problems are open right now." or the real list (the placeholder list is aria-hidden)
    await expect(page.locator(".open-now p.muted, .open-now ul:not([aria-hidden='true'])").first(), "the pinned lines are loaded").toBeVisible();
    await expect(page.locator(".open-now li").filter({ hasText: `source #${world.sourceId} ` }), "nothing pinned for the deleted source").toHaveCount(0);
  });

  test("8. Storage: the Data watchdog card shows the two numbers; Change... opens its dialog, Escape closes it with the focus back, nothing is saved", async ({ page }) => {
    needSetup();
    await page.goto("/storage");
    await expect(heading1(page, "Storage")).toBeVisible();
    const card = heading2(page, "Data watchdog");
    await expect(card).toBeVisible();
    const section = page.locator(".page-card.storage-watchdog").filter({ has: card });
    await expect(section).toHaveCount(1);

    const stored = await json<ApiWatchdog>(page.request, "/api/settings/watchdog");
    const noun = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
    await expect(section.getByText(
      `Meters are stale after ${noun(stored.stale_floor_minutes, "minute")} without a good reading (or 3 polls, whichever is longer); energy counters are flagged after ${noun(stored.not_advancing_hours, "hour")} without rising.`,
      { exact: true },
    ), "the summary has both numbers").toBeVisible();

    const change = section.getByRole("button", { name: "Change...", exact: true });
    await expect(change).toBeVisible();
    await change.click();
    const dialog = page.getByRole("dialog", { name: "Change when meters count as stale", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Stale after (minutes)", { exact: true })).toHaveValue(String(stored.stale_floor_minutes));
    await expect(dialog.getByLabel("Counter not rising after (hours)", { exact: true })).toHaveValue(String(stored.not_advancing_hours));
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(change, "Escape puts the focus back on the button that opened the dialog").toBeFocused();
    expect(await json<ApiWatchdog>(page.request, "/api/settings/watchdog"), "nothing was saved").toMatchObject({
      stale_floor_minutes: stored.stale_floor_minutes, not_advancing_hours: stored.not_advancing_hours,
    });
  });
});
