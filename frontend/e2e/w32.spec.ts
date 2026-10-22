import { expect, test, type APIRequestContext, type APIResponse, type Browser, type Page } from "@playwright/test";
import { navLink } from "./shell";

// W32 (system events): the system's own journal gets a page, a source's trouble is ONE counted incident instead of a row per failed poll, a long outage shows on Sources, and the audit entry
// of a started check links to how the check ended. Admin `admin` / `correct-horse`. The contract is the plan docs/superpowers/plans/2026-10-22-w32-system-events.md (Rulings P5 to P8, P16 to P18) and the rulings of .waves/w32.md.
//
// IT MAKES ITS OWN DATA and needs nothing from the stack beyond the sign-in: the asset `W32 <run>`, the `simulator` source `W32 <run> sim` (at the live simulator `http://simulator:9000`, key `sim-key` as the
// journey's `sim`) with ONE point mapped, and the account and role `w32-...` of case 6. afterAll removes it all (accounts first, then roles, the asset with its mapping, the source), each step on its own and
// also after a failed case; beforeAll sweeps what an earlier run left. It never touches the collector (nothing is restarted: the source's URL is changed through the API and the collector reloads by itself).
//   1  A SOURCE AT A DEAD ADDRESS. The source is browsed, one point is mapped, a reading arrives; then its URL is changed to `http://simulator:9` (nothing listens there). Through the API the source reads
//      `offline`, with `offline_since` and `failed_reads >= 1` (the open incident's count).
//   2  THE SOURCES BANNER. The page's clock is put three minutes ahead BEFORE it loads (Ruling P16: the banner needs an outage older than two minutes, and waiting that long for real is slow): a plain banner (no
//      alert role, no live region) names the source and offers **See its events**, which opens System events; the Status chip's tooltip says `offline since ...`.
//   3  ONE INCIDENT, COUNTED. System events for that source: ONE line under "Happening now" and ONE row for it in the list, both with their count; after up to about 100 s (the writer bumps the count once a minute,
//      and a source that keeps failing is polled less often) the count has grown, still ONE line and ONE row.
//   4  THE WAY BACK. The URL is put back: the source reads `online`, the incident is closed, the list holds the recovery row (`Back online after ...`, with the failed reads it counted) and the closed incident
//      (`lasted ...`), "Happening now" says nothing is open, and the Sources banner (clock three minutes ahead again) is gone.
//   5  THE OUTCOME OF A CHECK. A connection check on the source: its audit entry carries a tag `passed` in the list and an Outcome row in its drawer, whose link **Open in System events** opens the
//      event; the event's drawer has **Open the audit entry** back to the entry.
//   6  PERMISSIONS. A role without `diagnostics.view` has no Events link, `/events` says No access and the API says 403.
//   7  STORAGE. The card `System events and the audit log` reads `90 days` (the factory value) and has **Change...**, which opens its dialog (Cancel; nothing is saved).
// Playwright matches names by SUBSTRING and case-insensitively: every lookup that could meet a longer name is `exact: true` ("System events" is inside "System events and the audit log"). The cases are SERIAL
// and depend on each other (the source of case 1 is the subject of all the others), so a failing case skips the ones after it. Assertions that depend on the browser or on timing, which nobody could check
// while writing this, are listed in the commit's status block.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";

const RUN = Date.now().toString(36);
/** A name that belongs to this run. */
const name = (what: string): string => `W32 ${RUN} ${what}`;
/** What an earlier run that stopped half way may have left behind: `W32 ` and a run id (Date.now() in base 36 is 8 characters until 2059). The asset is `W32 <run>` itself. */
const LEFTOVER = /^W32 [0-9a-z]{8}( |$)/;

const SOURCE = name("sim");
const ASSET = `W32 ${RUN}`;
const LIVE = "http://simulator:9000";
const DEAD = "http://simulator:9";
const SIM_KEY = "sim-key";
const POINT = "LVP01_kW";
const ROLE = "w32-no-events";
const USER = "w32-viewer";
const PASSWORD = `w32-${RUN}-password`;
/** The time the page's clock is put ahead of the server's: the banner needs an outage older than 120 s (Ruling P7), and the source has been offline for a few seconds only. */
const AHEAD_MS = 180_000;

// ---------------------------------------------------------------------------------------------------------------------------------
// The API shapes this spec reads (written here, so a change of the server shows up as a failure)

interface ApiSource {
  id: number; name: string; status: string; last_seen: string | null; last_reading_age_seconds: number | null;
  offline_since: string | null; failed_reads: number | null; mapped_points: number;
}
interface ApiAsset { id: number; parent_id: number | null; name: string }
interface ApiPoint { id: number; address: string }
interface ApiJob { id: number; status: string }
interface ApiUser { id: number; username: string }
interface ApiRole { id: number; name: string; builtin: boolean }
interface ApiIncident { state: "open" | "closed"; count: number; closed_by: string | null }
interface ApiEvent { id: number; kind: string; message: string; incident: ApiIncident | null }
interface ApiEventPage { items: ApiEvent[]; total: number | null }
interface ApiOutcome { state: string; text: string; event_id: number | null }
interface ApiAudit { id: number; action: string; detail: Record<string, unknown>; outcome: ApiOutcome | null }

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

async function signIn(page: Page): Promise<void> {
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in: ${login.status()} ${await login.text()}`).toBe(true);
}

/**
 * Everything this spec may have made, in the order that works: the account, the role, the asset (its mapping goes with it), the source. Each step on its own; the problems are raised at the end.
 */
async function removeMine(request: APIRequestContext): Promise<void> {
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
  for (const user of (await list<ApiUser>("/api/users")).filter((u) => u.username.startsWith("w32-"))) await gone(`user ${user.username}`, () => request.delete(`/api/users/${user.id}`));
  for (const role of (await list<ApiRole>("/api/roles")).filter((r) => !r.builtin && r.name.startsWith("w32-"))) await gone(`role ${role.name}`, () => request.delete(`/api/roles/${role.id}`));
  for (const asset of (await list<ApiAsset>("/api/assets")).filter((a) => a.parent_id === null && LEFTOVER.test(a.name))) await gone(`asset ${asset.name}`, () => request.delete(`/api/assets/${asset.id}?confirm=true`));
  for (const source of (await list<ApiSource>("/api/sources")).filter((s) => LEFTOVER.test(s.name))) await gone(`source ${source.name}`, () => request.delete(`/api/sources/${source.id}?confirm=true`));
  expect(problems, "everything this spec made was removed").toEqual([]);
}

/** What the cases hand to each other. */
const world = { sourceId: 0, assetId: 0, count: 0, auditId: 0, eventId: 0 };

test.beforeAll(async ({ browser }) => {
  await asAdmin(browser, removeMine); // what an earlier run that stopped half way left behind
});

test.afterAll(async ({ browser }) => {
  await asAdmin(browser, removeMine);
});

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Locators and small helpers

const heading1 = (page: Page, text: string) => page.getByRole("heading", { level: 1, name: text, exact: true });
const heading2 = (page: Page, text: string) => page.getByRole("heading", { level: 2, name: text, exact: true });
/** A Sources row, found by the title of its name cell (the cell holds a second line, so the cell's own name is not the source's). */
const sourceRow = (page: Page, sourceName: string) => page.getByRole("row").filter({ has: page.locator(`.cell-name[title="${sourceName}"]`) });
/** The banner of a long outage: a plain banner on Sources whose sentence says a source is (or several are) offline. The page has other banners, which never say that. */
const offlineBanner = (page: Page) => page.locator(".banner").filter({ hasText: /(is|are) offline/ }).filter({ hasText: SOURCE });
/** The lines under "Happening now" (one per open problem), and the rows of the list for the one source the address names. */
const openLines = (page: Page) => page.locator(".open-now li");
const listRows = (page: Page) => page.locator(".events-table tbody tr");
const wentOffline = (page: Page) => listRows(page).filter({ hasText: "Went offline" });

/** The first number in front of `pattern`'s words in a text (`5 failed reads` -> 5), 0 when the words are not there (yet). */
function numberBefore(text: string | null, pattern: RegExp): number {
  const found = pattern.exec(text ?? "");
  return found ? Number(found[1].replace(/,/g, "")) : 0;
}
const readsOf = (text: string | null) => numberBefore(text, /([\d,]+) failed reads?/);
const timesOf = (text: string | null) => numberBefore(text, /failed ([\d,]+) times?/);

async function theSource(request: APIRequestContext): Promise<ApiSource> {
  const found = (await json<ApiSource[]>(request, "/api/sources")).find((s) => s.id === world.sourceId);
  expect(found, `the source ${SOURCE} exists`).toBeDefined();
  return found!;
}

async function openEvents(request: APIRequestContext, query: string): Promise<ApiEventPage> {
  return json<ApiEventPage>(request, `/api/events?source=${world.sourceId}&${query}`);
}

test.describe("W32: system events", () => {
  test.describe.configure({ mode: "serial" });

  test("1. a source at a dead address goes offline, and the sources list says since when and how many reads failed", async ({ page }) => {
    test.setTimeout(180_000);
    const request = page.request;

    await test.step("an asset, a simulator source at the live simulator, its points browsed and one of them mapped", async () => {
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
      const mapped = await request.post("/api/mappings", { data: { point_id: point!.id, asset_id: world.assetId, metric: "active_power_kw" } });
      expect(mapped.status(), `mapping the point: ${await mapped.text()}`).toBe(201);
    });

    await test.step("the collector polls it: a reading arrives and the source is online", async () => {
      await expect
        .poll(async () => {
          const source = await theSource(request);
          return source.status === "online" && source.last_reading_age_seconds !== null;
        }, { message: "the source is polled and online", timeout: 60_000, intervals: [1_000, 2_000] })
        .toBe(true);
    });

    await test.step("its address is changed to one nothing listens at, and it reads offline with a failed read counted", async () => {
      const changed = await request.patch(`/api/sources/${world.sourceId}`, { data: { config: { url: DEAD } } });
      expect(changed.ok(), `changing the address: ${changed.status()} ${await changed.text()}`).toBe(true);
      await expect
        .poll(async () => {
          const source = await theSource(request);
          return source.status === "offline" && (source.failed_reads ?? 0) >= 1;
        }, { message: "the source reads offline with failed_reads >= 1", timeout: 60_000, intervals: [1_000, 2_000] })
        .toBe(true);
      const source = await theSource(request);
      expect(source.offline_since, "the list says since when").not.toBeNull();
      expect(Number.isNaN(Date.parse(source.offline_since!)), "offline_since is a time").toBe(false);
      expect(source.mapped_points).toBe(1);
      world.count = source.failed_reads!;
    });
  });

  test("2. Sources: with the page's clock three minutes ahead, a plain banner names the source and offers its events", async ({ page }) => {
    // Before the page loads: its timers and Date are then the shifted ones from the first line of script on. Time still flows (the banner's 5 s tick runs).
    await page.clock.install({ time: Date.now() + AHEAD_MS });
    await page.goto("/sources");
    await expect(heading1(page, "Sources")).toBeVisible();
    await expect(sourceRow(page, SOURCE)).toBeVisible();

    const banner = offlineBanner(page);
    await expect(banner, "the banner names the source").toBeVisible();
    await expect(banner).toContainText(SOURCE);
    // A plain region: the page has two alert banners already and the list is fetched every 10 s, so this one is read where it stands (Lessons A9).
    await expect(banner).not.toHaveAttribute("role", "alert");
    await expect(banner).not.toHaveAttribute("aria-live", /.+/);
    await expect(banner.locator("[role=alert], [aria-live]")).toHaveCount(0);

    const chip = sourceRow(page, SOURCE).locator(".chip");
    await expect(chip).toHaveText("offline");
    await expect(chip, "the Status chip dates the outage").toHaveAttribute("title", /^offline since \d{1,2} [A-Z][a-z]{2} \d\d:\d\d$/);

    const link = banner.getByRole("link", { name: "See its events", exact: true });
    await expect(link).toBeVisible();
    const one = /^\s*1 source is offline/.test((await banner.textContent()) ?? ""); // read before the page changes
    await link.click();
    await expect(page).toHaveURL(/\/events(\?|$)/);
    await expect(heading1(page, "System events")).toBeVisible();
    // With one source offline for long the link names that source; with several it opens the whole page.
    if (one) await expect(page).toHaveURL(new RegExp(`source=${world.sourceId}(&|$)`));
  });

  test("3. System events: ONE open incident for the source, pinned above the list, and its count grows by itself", async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto(`/events?source=${world.sourceId}`);
    await expect(heading1(page, "System events")).toBeVisible();
    await expect(navLink(page, "Events")).toBeVisible();
    await expect(heading2(page, "Happening now")).toBeVisible();

    const lines = openLines(page);
    await expect(lines, "one open problem for the source").toHaveCount(1);
    await expect(lines.first()).toContainText(`${SOURCE} is offline since`);
    await expect(lines.first(), "the plain reason follows").toContainText("Could not connect");
    await expect(page.locator(".tile[data-alert='true']").filter({ hasText: "Open problems" }), "the first tile is red while a problem is open").toBeVisible();

    // The list holds the same incident as ONE row, with its count.
    await expect(wentOffline(page), "one row for the incident").toHaveCount(1);
    const row = wentOffline(page).first();
    await expect(row.locator("td.cell-count")).toContainText("ongoing");
    const before = readsOf(await lines.first().textContent());
    expect(before, "the pinned line counts failed reads").toBeGreaterThanOrEqual(1);
    expect(timesOf(await row.locator("td.cell-count").textContent()), "the row counts the same incident").toBeGreaterThanOrEqual(1);

    // The writer bumps the count once a minute (BUMP_EVERY_SECONDS = 60) and a source that keeps failing is polled every 10 to 60 s, so the count moves within about 100 s;
    // the page reads the open problems again every 10 s and brings the line and the row up to date in place.
    await expect
      .poll(async () => readsOf(await lines.first().textContent()), { message: "the count of failed reads grows", timeout: 150_000, intervals: [2_000] })
      .toBeGreaterThan(before);
    const after = readsOf(await lines.first().textContent());
    await expect(lines, "still ONE open problem").toHaveCount(1);
    await expect(wentOffline(page), "still ONE row").toHaveCount(1);
    await expect.poll(async () => timesOf(await wentOffline(page).first().locator("td.cell-count").textContent()), { message: "the row shows the grown count too", timeout: 30_000 }).toBeGreaterThanOrEqual(after);
    expect(after, "the API agrees").toBeLessThanOrEqual((await theSource(page.request)).failed_reads ?? 0);
    expect((await openEvents(page.request, "open=1")).items.map((e) => e.kind), "one open incident through the API").toEqual(["source.offline"]);
    world.count = after;
  });

  test("4. the URL is put back: the incident closes, the list shows the recovery with its duration, and the banner is gone", async ({ page }) => {
    test.setTimeout(180_000);
    const request = page.request;
    const changed = await request.patch(`/api/sources/${world.sourceId}`, { data: { config: { url: LIVE } } });
    expect(changed.ok(), `changing the address back: ${changed.status()} ${await changed.text()}`).toBe(true);
    await expect.poll(async () => (await theSource(request)).status, { message: "the source reads online again", timeout: 90_000, intervals: [1_000, 2_000] }).toBe("online");
    await expect.poll(async () => (await openEvents(request, "open=1")).items.length, { message: "the incident is closed", timeout: 60_000, intervals: [1_000, 2_000] }).toBe(0);
    const source = await theSource(request);
    expect(source.offline_since, "an online source has no outage start").toBeNull();
    expect(source.failed_reads, "and no open count").toBeNull();

    await page.clock.install({ time: Date.now() + AHEAD_MS }); // Sources is opened below with the clock ahead again, so that "no banner" means something
    await page.goto(`/events?source=${world.sourceId}`);
    await expect(heading1(page, "System events")).toBeVisible();
    await expect(heading2(page, "Happening now")).toBeVisible();
    await expect(page.locator(".open-now").getByText("No problems are open right now.", { exact: true }), "the pinned line is gone").toBeVisible();
    await expect(openLines(page)).toHaveCount(0);

    const recovery = listRows(page).filter({ hasText: "Back online after" });
    await expect(recovery, "one recovery row").toHaveCount(1);
    await expect(recovery.locator(".what")).toHaveText(/^Back online after \d+ (s|min|h|d)/);
    await expect(recovery.locator("td.cell-count"), "it says how many reads failed").toContainText(/\d+ failed reads? counted/);
    expect(readsOf(await recovery.locator("td.cell-count").textContent()), "it counted at least what the page showed").toBeGreaterThanOrEqual(world.count);
    await expect(wentOffline(page), "the incident is still ONE row, now closed").toHaveCount(1);
    await expect(wentOffline(page).locator("td.cell-count")).toContainText(/lasted \d+ (s|min|h|d)/);

    await page.goto("/sources");
    await expect(heading1(page, "Sources")).toBeVisible();
    await expect(sourceRow(page, SOURCE).locator(".chip")).toHaveText("online");
    await expect(offlineBanner(page), "the banner is gone").toHaveCount(0);
  });

  test("5. a connection check: its audit entry shows the outcome, the link opens the event, and the event links back", async ({ page }) => {
    test.setTimeout(150_000);
    const request = page.request;
    const started = await request.post(`/api/sources/${world.sourceId}/check`);
    expect(started.status(), `starting the check: ${await started.text()}`).toBe(202);
    const jobId = ((await started.json()) as { job_id: number }).job_id;

    // The end of the job is written by the collector a moment after the job; the entry then carries the outcome and the id of the event.
    let entry: ApiAudit | undefined;
    await expect
      .poll(async () => {
        const items = (await json<{ items: ApiAudit[] }>(request, "/api/audit?action=source.checked&limit=200")).items;
        entry = items.find((e) => e.detail.job_id === jobId);
        return entry?.outcome?.state === "passed" && entry.outcome.event_id !== null;
      }, { message: "the audit entry of the check has a passed outcome and an event", timeout: 90_000, intervals: [1_000, 2_000] })
      .toBe(true);
    world.auditId = entry!.id;
    world.eventId = entry!.outcome!.event_id!;
    expect(entry!.outcome!.text, "the outcome is in plain words").toMatch(/^The connection check passed/);

    // The list: a square tag after the sentence.
    await page.goto("/audit?action=source.checked");
    await expect(heading1(page, "Audit log")).toBeVisible();
    const row = page.locator(`.audit-table tr[data-entry-id="${world.auditId}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator(".ev-tag"), "the row's tag").toHaveText("passed");

    // The drawer: an Outcome row, last, with the link to the event.
    await row.getByRole("button", { name: `Details of entry #${world.auditId}`, exact: true }).click();
    const auditDrawer = page.getByRole("dialog", { name: "Audit entry", exact: true });
    await expect(auditDrawer).toBeVisible();
    const outcome = auditDrawer.locator("dl.kv > div").filter({ has: page.locator("dt", { hasText: "Outcome" }) });
    await expect(outcome).toHaveCount(1);
    await expect(outcome.locator("dd")).toContainText("The connection check passed");
    await expect(auditDrawer.locator("dl.kv > div").last(), "the Outcome row is the last").toContainText("Outcome");
    await outcome.getByRole("link", { name: "Open in System events", exact: true }).click();

    // The event: its drawer has the way back to the audit entry.
    await expect(page).toHaveURL(new RegExp(`/events/${world.eventId}(\\?|$)`));
    const eventDrawer = page.getByRole("dialog", { name: "System event", exact: true });
    await expect(eventDrawer).toBeVisible();
    await expect(eventDrawer).toContainText("The connection check passed");
    const back = eventDrawer.getByRole("link", { name: "Open the audit entry", exact: true });
    await expect(back).toBeVisible();
    await back.click();
    await expect(page).toHaveURL(new RegExp(`/audit/${world.auditId}(\\?|$)`));
    await expect(page.getByRole("dialog", { name: "Audit entry", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Audit entry", exact: true })).toContainText("Outcome");
  });

  test("6. a role without diagnostics.view has no Events link, /events says No access and the API says 403", async ({ browser }) => {
    test.setTimeout(120_000);
    await asAdmin(browser, async (request) => {
      const role = await request.post("/api/roles", { data: { name: ROLE, description: "made by w32.spec.ts", permissions: ["sources.view"] } });
      expect(role.status(), `creating the role: ${await role.text()}`).toBe(201);
      const user = await request.post("/api/users", { data: { username: USER, password: PASSWORD, role: ROLE } });
      expect(user.status(), `creating the account: ${await user.text()}`).toBe(201);
    });
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 } });
    try {
      const login = await context.request.post("/api/login", { data: { username: USER, password: PASSWORD } });
      expect(login.ok(), `${USER} signs in: ${login.status()} ${await login.text()}`).toBe(true);
      const page = await context.newPage();
      await page.goto("/sources");
      await expect(heading1(page, "Sources")).toBeVisible();
      await expect(navLink(page, "Sources"), "the sidebar is there").toBeVisible();
      await expect(navLink(page, "Events"), "but has no Events link").toHaveCount(0);
      await expect(sourceRow(page, SOURCE)).toBeVisible();

      await page.goto("/events");
      await expect(heading1(page, "No access")).toBeVisible();
      await expect(page.getByText("Your role does not include this page.", { exact: true })).toBeVisible();
      await expect(heading1(page, "System events")).toHaveCount(0);

      for (const path of ["/api/events", "/api/events/summary", "/api/events/options", `/api/events/${world.eventId}`, "/api/events.csv"]) {
        expect((await context.request.get(path)).status(), `GET ${path} without diagnostics.view`).toBe(403);
      }
    } finally {
      await context.close();
    }
  });

  test("7. Storage: the card for system events says 90 days and has Change...", async ({ page }) => {
    await page.goto("/storage");
    await expect(heading1(page, "Storage")).toBeVisible();
    const card = heading2(page, "System events and the audit log");
    await expect(card).toBeVisible();
    const section = page.locator(".page-card").filter({ has: card });
    await expect(section).toContainText("System events are kept 90 days or the newest 100,000, whichever is fewer.");
    await expect(section).toContainText(/Kept now: [\d,]+/);
    await expect(section).toContainText("The audit log is kept forever.");
    const change = section.getByRole("button", { name: "Change...", exact: true });
    await expect(change).toBeVisible();

    await change.click();
    const dialog = page.getByRole("dialog", { name: "Change how long system events are kept", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Keep events for (days)")).toHaveValue("90");
    await expect(dialog.getByLabel("Keep at most (events)")).toHaveValue("100000");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    const settings = await json<{ retention_days: number; max_rows: number }>(page.request, "/api/settings/events");
    expect(settings, "nothing was saved").toMatchObject({ retention_days: 90, max_rows: 100_000 });
  });
});
