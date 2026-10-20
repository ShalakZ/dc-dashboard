import { appendFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { cardFigure, exactText, familyOf, pickScale, type Marks } from "../src/lib/figures";

// W29 (the wall): a connected display shows its playlist as a rotating wall, with no sign-in: the dashboard's own layout scaled to the screen, a header (name, "2 of 3", "Updated", the clock) and two honesty bands.
// Admin `admin` / `correct-horse`, as in the earlier projects. The contract is the plan docs/superpowers/plans/2026-10-20-w29-display-wall-screen.md and the rulings of .waves/w29.md.
//
// IT MAKES ITS OWN DATA and needs nothing from the stack (not even a running collector: the playlist's `status` is steered in the page where a case depends on it): beforeAll makes an asset
// `W29 <run> site`, the dashboards `... dash x` (one energy stat) and `... dash y` (an energy stat and a table), a playlist `... wall` (x, then y with the site as its focus, 10 s each) and a
// display on it; the cases that change or delete a dashboard make dashboards, a playlist and a display of their own. Every name starts `W29 <run>`; afterAll deletes it all, each step on its own and also
// after a failed case (displays first: a playlist a display still uses cannot be deleted; then playlists, dashboards, the asset), and beforeAll sweeps what an earlier run left.
// IT MAKES RIGHT CLAIMS ONLY: every screen is claimed with the right secret (cases 2 to 7 by `POST /api/display/claim` in the context, case 1 by opening the link). A right claim still connects after w28's
// case 6 blocked the address for wrong secrets (api/display.py:295-301); this project runs after it and never writes a wrong one. The display secrets this spec used are appended, one per line, to the file
// named by W29_SECRET_FILE (default /tmp/w29-secret.txt) for the controller's log grep; no assertion message of this file holds a secret, a link or the cookie.
//   1   ROTATION. A new browser opens the display link at 1920 x 1080: the heading is the first dashboard and the place "1 of 2", the figure on its card equals the administrator's POST /api/widget-data for the
//       stored widget (through lib/figures.ts, as w27 does), nothing scrolls and the grid lies under the header, the cursor is hidden after 3 s without a move and shown on the next one, and within 20 s the
//       heading is the second dashboard followed by its focus asset (", <asset>") and "2 of 2". TIMING: this case runs in REAL time (no page.clock). `runFor` pushes the page's clock ahead of the server's, and the
//       wall corrects its own clock from the Date header of every answer, so a turn that is due 10 s after the pin would come later by the amount the clock was pushed before the next answer landed. Cases 2 to 5
//       use runFor because what they wait for (the 60 s poll, the 120 s threshold, the retries) is set on the page's own timers, which `runFor` fires exactly.
//   2   A DELETED DASHBOARD. Y is deleted while the wall runs under page.clock: within 80 s of clock time (runFor in steps of 10 s, never fastForward: a jump of over 15 s is a wake) the wall says "1 of 1" and
//       the other dashboard's name, and a full-screen sentence (.display-screen-text) never appears. TIMING: the 60 s playlist poll, plus the swap if the deleted item was the one on screen.
//   3   AN EDITED DASHBOARD. The only dashboard of a playlist is saved with a new widget title (so its widget id changes): within 80 s of clock time the card with the new title is on the wall, with no page
//       navigation after the first load (framenavigated counted), no band and no full-screen sentence. TIMING: the 60 s poll, or earlier when the old widget answers 404 and the wall reads the playlist again.
//   4   BAND 1. The playlist answer's `status` is replaced in the page (page.route fetches the real answer): after the next poll a band "Readings stopped arriving at HH:MM." is shown, the wall is dimmed
//       and the grid has not moved; with a healthy status the band goes. TIMING: the 60 s poll.
//   5   BAND 2. Every /api/display/* request is aborted for 130 s of clock time: no band in the first 100 s, then "This screen has not been updated since HH:MM. Trying again..." over dimmed figures and never a
//       full-screen sentence; when the requests are let through the band clears. TIMING: the 120 s of the threshold count from the last card answer, which came a little before the first abort and the page's clock
//       also runs by itself while a step's answers are awaited (so the band is asserted absent only to 100 s and present at 130 s), and the way back: a card that failed five times waits 60 s plus up to 30 %
//       before it asks again, so the band clears within 100 s of clock time after the requests return, not within 60 s.
//   6   NOTHING TO SHOW. A display on a playlist with no items shows the one sentence of the brief, with the playlist's real name.
//   7   TWO SIZES. 1920 x 1080 and 3840 x 2160: the header is the same share of the height (4.5 %, within 0.2 %), and the grid fits and lies under the header.
//   8   ONLY DISPLAY ROUTES. Every /api URL the page of case 1 asked for is under /api/display/ (the claim, the playlist, widget-data) and none is /api/me, /api/widget-data, /api/dashboards or /api/assets.
// Names are matched by SUBSTRING, so every lookup is `exact: true` (the words "Updated" and "of 2" exist elsewhere in the app). Assertions that depend on timing or on the browser, which nobody could
// check while writing this, are listed in the commit's status block.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ORIGIN = new URL(BASE_URL).origin;
const SECRET_FILE: string = process.env.W29_SECRET_FILE ?? "/tmp/w29-secret.txt";

const FULL_HD = { width: 1920, height: 1080 };
const UHD = { width: 3840, height: 2160 };
interface Box { x: number; y: number; width: number; height: number }

const RUN = Date.now().toString(36);
/** A name that belongs to this run. No name below is the start of another, so a row or a sentence is never matched twice. */
const name = (what: string): string => `W29 ${RUN} ${what}`;
/** What an earlier run that stopped half way may have left behind: `W29 ` and a run id (Date.now() in base 36 is 8 characters until 2059), nothing a person named. */
const LEFTOVER = /^W29 [0-9a-z]{8}( |$)/;

const ASSET = name("site");
const DASH_X = name("dash x");
const DASH_Y = name("dash y");
const X_STAT = name("x energy");
const Y_STAT = name("y energy");
const Y_TABLE = name("y table");
const WALL = name("wall");
const WALL_TV = name("wall tv");

/** A minute of poll, the answer, the swap and its fade. The spec asks "within about a minute"; 80 s is the minute and one more step of ten. */
const POLL_WITHIN_MS = 80_000;
/** How long after the requests are let through the card that failed five times may still be waiting (60 s + 30 %, and a tick). */
const RECOVER_WITHIN_MS = 100_000;
/** One step of the page's clock, and the real time given to the answers on the wire after each step. */
const STEP_MS = 10_000;
const SETTLE_MS = 250;

// ---------------------------------------------------------------------------------------------------------------------------------
// The API shapes this spec reads (written here, so a change of the server shows up as a failure)

interface ApiAsset { id: number; parent_id: number | null; name: string }
interface ApiWidget { id: number; type: string; title: string; config: Record<string, unknown>; x: number; y: number; w: number; h: number }
interface ApiDashboard { id: number; name: string; range: string; updated_at: string; widgets: ApiWidget[] }
interface ApiItem { id: number; position: number; seconds: number; dashboard_id: number | null; dashboard_name: string | null; skipped: string | null }
interface ApiPlaylist { id: number; name: string; item_count: number; skipped_count: number; items: ApiItem[] }
interface ApiDisplay { id: number; name: string; playlist_id: number; status: "active" | "revoked" }
interface ApiDisplays { displays: ApiDisplay[]; playlists: ApiPlaylist[] }
interface ApiValue { value: number | null; estimated: boolean; partial: boolean; no_data: boolean }
interface ApiAnswer { source: "metric" | "energy" | "cost"; unit: string | null; values: ApiValue[] }
interface CardSpec { title: string; type: "stat" | "table"; x: number; y: number; w: number; h: number }
interface ItemIn { dashboard_id: number; seconds: number; focus_asset_id?: number }
interface Status { collector_alive: boolean; readings_fresh: boolean | null; last_reading_age_seconds: number | null }

// ---------------------------------------------------------------------------------------------------------------------------------
// What the cases share

const shared = { assetId: 0, dashX: 0, secret: "", link: "" };
/** The /api paths the page of case 1 asked for (path names only: the address of a request can hold the secret's fragment). */
const recorded: string[] = [];

const HEALTHY: Status = { collector_alive: true, readings_fresh: true, last_reading_age_seconds: 0 };
const STOPPED: Status = { collector_alive: true, readings_fresh: false, last_reading_age_seconds: 300 };

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

/** For the controller's log grep: every secret this spec used, one per line. Never printed anywhere else. */
function recordSecret(secret: string): void {
  appendFileSync(SECRET_FILE, `${secret}\n`);
}

async function createAsset(request: APIRequestContext, assetName: string): Promise<number> {
  const made = await request.post("/api/assets", { data: { name: assetName, parent_id: null, kind: "Site", sort_order: 1 } });
  expect(made.status(), `creating ${assetName}: ${made.status()} ${await made.text()}`).toBe(201);
  return ((await made.json()) as { id: number }).id;
}

/** The energy of the spec's asset: the one config every card uses (a stat and a table read it alike). */
const energyConfig = () => ({ assets: [shared.assetId], source: "energy", metric: null, aggregation: "sum", range: null, bars: "asset", min: 0, max: null });

/** A dashboard on the range "yesterday" (a closed range, so two answers a moment apart are equal) with the given cards: a dashboard with no widgets is skipped by a screen. */
async function createDashboard(request: APIRequestContext, dashboardName: string, cards: CardSpec[]): Promise<ApiDashboard> {
  const created = await request.post("/api/dashboards", { data: { name: dashboardName, range: "yesterday" } });
  expect(created.ok(), `creating ${dashboardName}: ${created.status()} ${await created.text()}`).toBe(true);
  const made = (await created.json()) as ApiDashboard;
  const widgets = cards.map((card) => ({ ...card, config: energyConfig() }));
  const saved = await request.put(`/api/dashboards/${made.id}`, { data: { name: dashboardName, range: "yesterday", updated_at: made.updated_at, widgets } });
  expect(saved.ok(), `saving the widgets of ${dashboardName}: ${saved.status()} ${await saved.text()}`).toBe(true);
  return json<ApiDashboard>(request, `/api/dashboards/${made.id}`);
}

async function createPlaylist(request: APIRequestContext, playlistName: string, items: ItemIn[]): Promise<ApiPlaylist> {
  const made = await request.post("/api/playlists", { data: { name: playlistName, items } });
  expect(made.status(), `creating the playlist ${playlistName}: ${made.status()} ${await made.text()}`).toBe(201);
  return (await made.json()) as ApiPlaylist;
}

/** A display through the API: its link, and the secret in it (recorded for the log grep). */
async function createDisplay(request: APIRequestContext, displayName: string, playlistId: number): Promise<{ id: number; secret: string; url: string }> {
  const made = await request.post("/api/displays", { data: { name: displayName, playlist_id: playlistId } });
  expect(made.status(), `creating the display ${displayName}: ${made.status()}`).toBe(201);
  const body = (await made.json()) as { display: { id: number }; link_secret: string };
  recordSecret(body.link_secret);
  return { id: body.display.id, secret: body.link_secret, url: `${ORIGIN}/display#${body.link_secret}` };
}

async function removeAll(request: APIRequestContext): Promise<void> {
  const gone = (what: string, status: number) => expect([200, 204, 404], `deleting ${what}: ${status}`).toContain(status);
  const list = await json<ApiDisplays>(request, "/api/displays");
  for (const old of list.displays.filter((d) => LEFTOVER.test(d.name))) gone(`the display ${old.name}`, (await request.delete(`/api/displays/${old.id}`)).status());
  for (const old of list.playlists.filter((p) => LEFTOVER.test(p.name))) gone(`the playlist ${old.name}`, (await request.delete(`/api/playlists/${old.id}`)).status());
  for (const old of (await json<{ id: number; name: string }[]>(request, "/api/dashboards")).filter((d) => LEFTOVER.test(d.name))) {
    gone(`the dashboard ${old.name}`, (await request.delete(`/api/dashboards/${old.id}`)).status());
  }
  for (const old of (await json<ApiAsset[]>(request, "/api/assets")).filter((a) => a.parent_id === null && LEFTOVER.test(a.name))) {
    gone(`the asset ${old.name}`, (await request.delete(`/api/assets/${old.id}?confirm=true`)).status());
  }
}

/** Dashboards of one card each, a playlist of them (10 s per item) and a display on it, named `W29 <run> <tag> ...`: a case that changes or deletes what a screen shows makes its own. */
interface Own { dashboards: ApiDashboard[]; secret: string }
async function provision(browser: Browser, tag: string, dashboards: number): Promise<Own> {
  return asAdmin(browser, async (request) => {
    const made: ApiDashboard[] = [];
    for (let at = 1; at <= dashboards; at++) {
      made.push(await createDashboard(request, name(`${tag} dash ${at}`), [{ title: name(`${tag} energy ${at}`), type: "stat", x: 0, y: 0, w: 3, h: 2 }]));
    }
    const playlist = await createPlaylist(request, name(`${tag} list`), made.map((dashboard) => ({ dashboard_id: dashboard.id, seconds: 10 })));
    const display = await createDisplay(request, name(`${tag} tv`), playlist.id);
    return { dashboards: made, secret: display.secret };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The wall: locators, boxes, the clock, the wire

const wallOf = (page: Page) => page.locator("main.wall");
const headingOf = (page: Page) => page.locator("h1.wall-title");
const placeOf = (page: Page) => page.locator(".wall-position");
const bandOf = (page: Page) => page.locator(".wall-band");
/** The display page's full-screen sentence (also its "Connecting..."): the wall must never fall back to it once it is drawn. */
const screenText = (page: Page) => page.locator(".display-screen-text");
const cardTitle = (page: Page, title: string) => wallOf(page).getByRole("heading", { level: 2, name: title, exact: true });

/** The wall's header names the dashboard on screen (exactly: the focus asset follows after a comma) and its place among the shown ones, e.g. "1 of 2". */
async function wallShows(page: Page, heading: string, place: string): Promise<void> {
  await expect(headingOf(page), `the wall shows ${heading}`).toHaveText(heading);
  await expect(placeOf(page), `the wall says ${place}`).toHaveText(place);
}

async function noSentence(page: Page, where: string): Promise<void> {
  await expect(screenText(page), `${where}: no full-screen sentence`).toHaveCount(0);
}

const readText = (target: Locator): Promise<string | null> => target.textContent({ timeout: 2_000 }).catch(() => null);

async function boxOf(target: Locator): Promise<Box> {
  return target.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
}
function expectSameBox(a: Box, b: Box, what: string): void {
  for (const edge of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(a[edge] - b[edge]), `${what}: the ${edge} did not move (${Math.round(a[edge])} against ${Math.round(b[edge])})`).toBeLessThanOrEqual(1);
  }
}

/** Nothing scrolls (page and window agree) and the dashboard's grid lies inside the window, under the header. */
async function expectFits(page: Page, what: string): Promise<void> {
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const grid = document.querySelector(".wall-grid")?.getBoundingClientRect() ?? null;
    const head = document.querySelector(".wall-head")?.getBoundingClientRect() ?? null;
    return {
      scrollHeight: doc.scrollHeight, scrollWidth: doc.scrollWidth, height: window.innerHeight, width: window.innerWidth,
      grid: grid && { top: grid.top, bottom: grid.bottom, left: grid.left, right: grid.right }, headBottom: head && head.bottom,
    };
  });
  expect(m.scrollHeight, `${what}: the page does not scroll down`).toBeLessThanOrEqual(m.height);
  expect(m.scrollWidth, `${what}: the page does not scroll sideways`).toBeLessThanOrEqual(m.width);
  expect(m.grid, `${what}: the grid is drawn`).not.toBeNull();
  expect(m.headBottom, `${what}: the header is drawn`).not.toBeNull();
  const slack = 1;
  const grid = m.grid!;
  expect(grid.top, `${what}: the grid starts under the header`).toBeGreaterThanOrEqual(m.headBottom! - slack);
  expect(grid.bottom, `${what}: the grid ends inside the window`).toBeLessThanOrEqual(m.height + slack);
  expect(grid.left, `${what}: the grid starts inside the window`).toBeGreaterThanOrEqual(-slack);
  expect(grid.right, `${what}: the grid ends inside the window`).toBeLessThanOrEqual(m.width + slack);
}

/** The address is exactly `<origin>/display`. A boolean, so a failure never prints an address that still holds a fragment. */
async function expectBareDisplayAddress(screen: Page): Promise<void> {
  await expect.poll(() => screen.url() === `${ORIGIN}/display`, { message: "the address is /display with no fragment" }).toBe(true);
}

/** What the stat on a card says for an answer: `StatWidget` without a comparison (the card face, the unit behind it and the exact face as the title). */
interface StatFace { num: string; unit: string; title: string | null }
function statFace(answer: ApiAnswer): StatFace {
  const row = answer.values[0];
  if (row === undefined) return { num: "—", unit: "", title: null };
  const marks: Marks = { estimated: row.estimated, partial: row.partial };
  const scale = pickScale(familyOf(answer.unit, answer.source), answer.unit, [row.value]);
  const measured = row.value !== null && Number.isFinite(row.value);
  const noReading = row.value === null && row.no_data && answer.source !== "cost";
  return {
    num: noReading ? "no data" : cardFigure(row.value, scale, marks),
    unit: noReading || !measured ? "" : (scale.unit ?? ""),
    title: row.no_data ? "no data" : measured ? exactText(row.value, answer.unit, marks) : null,
  };
}

/** A browser of its own with the display's cookie (a RIGHT claim made by the context), then /display. `steer` puts the wire under the case's control before the page loads. */
interface Opened { context: BrowserContext; screen: Page; wire: Wire }
async function openWall(browser: Browser, secret: string, options: { clock?: boolean; steer?: boolean; viewport?: { width: number; height: number } } = {}): Promise<Opened> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: options.viewport ?? FULL_HD });
  try {
    const screen = await context.newPage();
    if (options.clock) await screen.clock.install(); // before the page loads: its timers are then ours to move
    const wire = options.steer ? await steer(screen) : { outage: false, status: null };
    const claim = await context.request.post("/api/display/claim", { data: { secret } });
    expect(claim.status(), "the claim of the right secret answers 204").toBe(204);
    await screen.goto("/display");
    return { context, screen, wire };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/**
 * The wire between a display page and the server. One route for every /api/display/* request: with `outage` set it fails them all (as a dead network does); otherwise it fetches the real answer and,
 * for the playlist, puts `status` in place of the server's (null = as the server says). The case flips the fields; nothing is routed again. The stack's real status (a collector that is not running, readings
 * that are old) therefore decides nothing in a case.
 */
interface Wire { outage: boolean; status: Status | null }
async function steer(screen: Page): Promise<Wire> {
  const wire: Wire = { outage: false, status: HEALTHY };
  await screen.route("**/api/display/**", async (route) => {
    try {
      if (wire.outage) {
        await route.abort();
        return;
      }
      const status = wire.status;
      if (status === null || new URL(route.request().url()).pathname !== "/api/display/playlist") {
        await route.continue();
        return;
      }
      const real = await route.fetch();
      if (real.status() !== 200) {
        await route.fulfill({ response: real });
        return;
      }
      const body = (await real.json()) as Record<string, unknown>;
      body.status = status;
      const date = real.headers()["date"]; // the wall keeps its clock from this header
      await route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store", ...(date ? { date } : {}) }, body: JSON.stringify(body) });
    } catch {
      // the page went away while a request was on the wire
    }
  });
  return wire;
}

/**
 * Moves the page's clock on by `ms` and lets the answers that are on the wire land. Never `fastForward`: a jump of over 15 s is read by the wall as a sleep and a wake (it reads at once and holds band 2 for 10 s),
 * and that is not what a long evening looks like. `runFor` fires every timer on the way, one after the other, as time would.
 */
async function advance(screen: Page, ms: number): Promise<void> {
  await screen.clock.runFor(ms);
  await screen.waitForTimeout(SETTLE_MS);
}

/** Steps of the clock until `done()`; `each` (an assertion that must hold all the way) runs before the first step and after every one. Throws when `limitMs` of clock time have passed. Returns the clock time moved. */
async function advanceUntil(screen: Page, what: string, done: () => Promise<boolean>, limitMs: number, each: () => Promise<void> = async () => undefined): Promise<number> {
  let moved = 0;
  await each();
  while (!(await done())) {
    if (moved >= limitMs) throw new Error(`${what}: not within ${limitMs / 1000} s of clock time`);
    await advance(screen, STEP_MS);
    moved += STEP_MS;
    await each();
  }
  return moved;
}

test.describe.configure({ mode: "serial" });

test.describe("W29: the wall", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    await asAdmin(browser, async (request) => {
      await removeAll(request);
      shared.assetId = await createAsset(request, ASSET);
      const x = await createDashboard(request, DASH_X, [{ title: X_STAT, type: "stat", x: 0, y: 0, w: 3, h: 2 }]);
      const y = await createDashboard(request, DASH_Y, [
        { title: Y_STAT, type: "stat", x: 0, y: 0, w: 3, h: 2 },
        { title: Y_TABLE, type: "table", x: 3, y: 0, w: 6, h: 4 },
      ]);
      shared.dashX = x.id;
      const playlist = await createPlaylist(request, WALL, [{ dashboard_id: x.id, seconds: 10 }, { dashboard_id: y.id, seconds: 10, focus_asset_id: shared.assetId }]);
      const display = await createDisplay(request, WALL_TV, playlist.id);
      shared.secret = display.secret;
      shared.link = display.url;
    });
  });

  test.afterAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const failures: string[] = [];
    try {
      await asAdmin(browser, removeAll);
    } catch (e) {
      failures.push(`deleting the displays, playlists, dashboards and the asset: ${e instanceof Error ? e.message : String(e)}`);
    }
    expect(failures, "the clean-up put the stack back").toEqual([]);
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // Case 1

  test("1. the wall opens on the first dashboard, fits the screen, hides the cursor and rotates to the second", async ({ browser }) => {
    test.setTimeout(120_000);
    expect(shared.link, "beforeAll made the link").not.toBe("");
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: FULL_HD });
    try {
      const screen = await context.newPage();
      screen.on("request", (request) => { recorded.push(new URL(request.url()).pathname); });
      await screen.goto(shared.link);

      // The first dashboard, at once; its figure is the administrator's. (These two checks come first: the dashboard stays 10 s.)
      await wallShows(screen, DASH_X, "1 of 2");
      await expectBareDisplayAddress(screen);
      const face = await asAdmin(browser, async (request) => {
        const dashboard = await json<ApiDashboard>(request, `/api/dashboards/${shared.dashX}`);
        const widget = dashboard.widgets[0];
        const answer = await request.post("/api/widget-data", { data: { type: widget.type, config: widget.config, range: (widget.config.range as string | null) ?? dashboard.range } });
        expect(answer.status(), "POST /api/widget-data answers 200 for the administrator").toBe(200);
        return statFace((await answer.json()) as ApiAnswer);
      });
      const big = screen.locator(".wall .stat .big");
      await expect(screen.locator(".wall .stat-num"), "the figure on the first card is the administrator's").toHaveText(face.num);
      if (face.unit === "") await expect(screen.locator(".wall .stat .stat-unit"), "the figure has no unit").toHaveCount(0);
      else await expect(screen.locator(".wall .stat .stat-unit"), "the unit of the figure").toHaveText(face.unit);
      if (face.title === null) expect(await big.getAttribute("title"), "the figure has no exact face to show").toBeNull();
      else await expect(big, "the exact face is the title of the figure").toHaveAttribute("title", face.title);
      await expect(cardTitle(screen, X_STAT), "the card's title").toBeVisible();
      await expectFits(screen, "the first dashboard at 1920 x 1080");

      // The cursor: shown while the pointer moves, hidden after 3 s without a move, shown again on the next one.
      const wall = wallOf(screen);
      await screen.mouse.move(400, 300);
      await expect(wall, "a pointer move shows the cursor").not.toHaveClass(/wall-cursor-hidden/);
      await expect(wall, "after 3 s without a move the cursor is hidden").toHaveClass(/wall-cursor-hidden/, { timeout: 8_000 });
      expect(await wall.evaluate((el) => getComputedStyle(el).cursor), "the hidden cursor is none").toBe("none");
      await screen.mouse.move(700, 500);
      await expect(wall, "the next move shows it again").not.toHaveClass(/wall-cursor-hidden/);

      // The rotation: X stays 10 s, Y is fetched ahead and swapped in; the focus asset follows the name.
      await expect(headingOf(screen), "within 20 s the wall shows the second dashboard and its focus asset").toHaveText(`${DASH_Y}, ${ASSET}`, { timeout: 20_000 });
      await expect(placeOf(screen)).toHaveText("2 of 2");
      await expect(cardTitle(screen, Y_STAT), "the second dashboard's stat").toBeVisible();
      await expect(cardTitle(screen, Y_TABLE), "the second dashboard's table").toBeVisible();
      await expectFits(screen, "the second dashboard at 1920 x 1080");
      await noSentence(screen, "after the rotation");
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // Case 2

  test("2. a deleted dashboard: the wall goes to one of one with no full-screen sentence", async ({ browser }) => {
    test.setTimeout(150_000);
    const own = await provision(browser, "del", 2);
    const [first, second] = own.dashboards;
    const { context, screen } = await openWall(browser, own.secret, { clock: true, steer: true });
    try {
      await wallShows(screen, first.name, "1 of 2");
      await asAdmin(browser, async (request) => {
        const gone = await request.delete(`/api/dashboards/${second.id}`);
        expect(gone.status(), `deleting ${second.name}: ${gone.status()}`).toBe(204);
      });
      await advanceUntil(screen, "the wall goes to one of one", async () => (await readText(placeOf(screen))) === "1 of 1", POLL_WITHIN_MS, () => noSentence(screen, "while the playlist is read again"));
      await wallShows(screen, first.name, "1 of 1");
      await noSentence(screen, "at the end");
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // Case 3

  test("3. an edited dashboard: its new card arrives with no page navigation and no band", async ({ browser }) => {
    test.setTimeout(150_000);
    const own = await provision(browser, "edit", 1);
    const dashboard = own.dashboards[0];
    const oldTitle = dashboard.widgets[0].title;
    const newTitle = name("edit energy renamed");
    const { context, screen } = await openWall(browser, own.secret, { clock: true, steer: true });
    try {
      await wallShows(screen, dashboard.name, "1 of 1");
      await expect(cardTitle(screen, oldTitle), "the card before the edit").toBeVisible();
      await expect(screen.locator(".wall .stat-num"), "its figure has landed").toBeVisible();
      let navigations = 0;
      screen.on("framenavigated", () => { navigations += 1; });

      // The save replaces every widget row, so the widget gets a new id: the wall's open requests for the old one answer 404.
      const newWidgetId = await asAdmin(browser, async (request) => {
        const current = await json<ApiDashboard>(request, `/api/dashboards/${dashboard.id}`);
        const widgets = [{ title: newTitle, type: "stat", x: 0, y: 0, w: 3, h: 2, config: current.widgets[0].config }];
        const saved = await request.put(`/api/dashboards/${dashboard.id}`, { data: { name: current.name, range: current.range, updated_at: current.updated_at, widgets } });
        expect(saved.ok(), `saving ${current.name}: ${saved.status()} ${await saved.text()}`).toBe(true);
        return (await json<ApiDashboard>(request, `/api/dashboards/${dashboard.id}`)).widgets[0].id;
      });
      expect(newWidgetId, "the save gave the widget a new id").not.toBe(dashboard.widgets[0].id);

      const quiet = async () => {
        await noSentence(screen, "while the edit arrives");
        await expect(bandOf(screen), "while the edit arrives there is no band").toHaveCount(0);
      };
      await advanceUntil(screen, "the card with the new title", async () => (await cardTitle(screen, newTitle).count()) > 0, POLL_WITHIN_MS, quiet);
      await expect(cardTitle(screen, oldTitle), "the old card is gone").toHaveCount(0);
      await expect(screen.locator(".wall .stat-num"), "the new card shows a figure").toBeVisible();
      await wallShows(screen, dashboard.name, "1 of 1");
      expect(navigations, "the page did not navigate").toBe(0);
      await quiet();
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // Case 4

  test("4. band 1: readings stopped arriving, the figures are dimmed, nothing moves, and the band goes", async ({ browser }) => {
    test.setTimeout(150_000);
    const own = await provision(browser, "stopped", 1);
    const { context, screen, wire } = await openWall(browser, own.secret, { clock: true, steer: true });
    try {
      await wallShows(screen, own.dashboards[0].name, "1 of 1");
      await expect(screen.locator(".wall .stat-num"), "the card has its figure").toBeVisible();
      await expect(bandOf(screen), "no band while the status is healthy").toHaveCount(0);
      await expect(wallOf(screen)).not.toHaveAttribute("data-dim", "true");
      const grid = screen.locator(".wall-grid");
      const before = await boxOf(grid);

      wire.status = STOPPED; // the next playlist answer says the readings stopped 300 s ago
      await advanceUntil(screen, "band 1", async () => (await bandOf(screen).count()) > 0, POLL_WITHIN_MS, () => noSentence(screen, "while the status changes"));
      await expect(bandOf(screen), "band 1 says when the readings stopped").toHaveText(/^Readings stopped arriving at \d{2}:\d{2}\.$/);
      await expect(bandOf(screen), "the band is a status").toHaveAttribute("role", "status");
      await expect(wallOf(screen), "the figures are dimmed").toHaveAttribute("data-dim", "true");
      expectSameBox(before, await boxOf(grid), "with band 1 up, the grid");

      wire.status = HEALTHY; // the server says all is well again
      await advanceUntil(screen, "band 1 goes", async () => (await bandOf(screen).count()) === 0, POLL_WITHIN_MS, () => noSentence(screen, "while the band goes"));
      await expect(wallOf(screen), "the figures are bright again").not.toHaveAttribute("data-dim", "true");
      expectSameBox(before, await boxOf(grid), "with band 1 gone, the grid");
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // Case 5

  test("5. band 2: after 120 s of silence the screen says it is not updated, and the band clears when the server is back", async ({ browser }) => {
    test.setTimeout(240_000);
    const own = await provision(browser, "silent", 1);
    const { context, screen, wire } = await openWall(browser, own.secret, { clock: true, steer: true });
    try {
      await wallShows(screen, own.dashboards[0].name, "1 of 1");
      await expect(screen.locator(".wall .stat-num"), "the card has its figure (the last answer the 120 s count from)").toBeVisible();
      await expect(bandOf(screen)).toHaveCount(0);

      wire.outage = true; // every /api/display/* request fails from here
      for (let seconds = STEP_MS / 1000; seconds <= 130; seconds += STEP_MS / 1000) {
        await advance(screen, STEP_MS);
        await noSentence(screen, `${seconds} s into the outage`);
        // Up to 100 s only: the 120 s count from the last card answer, which came a little before the first abort, and the page's clock also runs by itself while a step's answers are awaited.
        if (seconds <= 100) await expect(bandOf(screen), `${seconds} s into the outage there is still no band`).toHaveCount(0);
      }
      await expect(bandOf(screen), "after 120 s the band is there").toBeVisible();
      await expect(bandOf(screen), "band 2 says since when").toHaveText(/^This screen has not been updated since \d{2}:\d{2}\. Trying again\.\.\.$/);
      await expect(wallOf(screen), "the figures are dimmed").toHaveAttribute("data-dim", "true");
      const dimmed = await screen.locator(".wall-stage").evaluate((el) => Number(getComputedStyle(el).opacity));
      expect(Math.abs(dimmed - 0.55), `the stage is dimmed to 55 % (it is ${dimmed})`).toBeLessThan(0.02);
      await noSentence(screen, "with band 2 up");

      wire.outage = false; // the server is back
      await advanceUntil(screen, "band 2 clears", async () => (await bandOf(screen).count()) === 0, RECOVER_WITHIN_MS, () => noSentence(screen, "while the screen recovers"));
      await expect(wallOf(screen), "the figures are bright again").not.toHaveAttribute("data-dim", "true");
      await expect(screen.locator(".wall .stat-num"), "the card still has its figure").toBeVisible();
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // Case 6

  test("6. a display on an empty playlist says there is nothing to show", async ({ browser }) => {
    const emptyList = name("empty list");
    const secret = await asAdmin(browser, async (request) => (await createDisplay(request, name("empty tv"), (await createPlaylist(request, emptyList, [])).id)).secret);
    const { context, screen } = await openWall(browser, secret);
    try {
      await expect(screenText(screen), "the one sentence, with the playlist's name").toHaveText(
        `Nothing to show. Every dashboard in playlist ${emptyList} is skipped or the playlist is empty. An administrator can change it on the Displays page.`,
      );
      await expect(headingOf(screen), "no wall is drawn").toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // Case 7

  test("7. the header is the same share of the height at 1920 x 1080 and at 3840 x 2160, and the grid fits both", async ({ browser }) => {
    test.setTimeout(150_000);
    const shares: number[] = [];
    for (const size of [FULL_HD, UHD]) {
      const { context, screen } = await openWall(browser, shared.secret, { viewport: size });
      try {
        await expect(headingOf(screen), `the wall opens at ${size.width} x ${size.height}`).toBeVisible();
        await expect(screen.locator(".wall .stat-num"), "its card has a figure").toBeVisible();
        const inner = await screen.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
        expect(inner, "the window is the size asked for").toEqual(size);
        await expectFits(screen, `${size.width} x ${size.height}`);
        shares.push((await boxOf(screen.locator(".wall-head"))).height / inner.height);
      } finally {
        await context.close();
      }
    }
    for (const share of shares) expect(share, `the header is under 4.5 % of the height (it is ${(share * 100).toFixed(3)} %)`).toBeLessThan(0.045 + 0.002);
    expect(Math.abs(shares[0] - shares[1]), `the header's share differs by under 0.2 % between the two sizes (${shares.map((s) => (s * 100).toFixed(3)).join(" % and ")} %)`).toBeLessThanOrEqual(0.002);
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // Case 8

  test("8. the wall asks for the display routes only", () => {
    const paths = recorded.filter((path) => path.startsWith("/api/") || path === "/api");
    expect(paths.length, "case 1 recorded the page's /api requests").toBeGreaterThan(0);
    expect(paths.filter((path) => !path.startsWith("/api/display/")), "every /api request of the wall is under /api/display/").toEqual([]);
    const forbidden = ["/api/me", "/api/widget-data", "/api/dashboards", "/api/assets"];
    expect(paths.filter((path) => forbidden.some((bad) => path === bad || path.startsWith(`${bad}/`))), "none is a user route").toEqual([]);
    for (const route of ["/api/display/claim", "/api/display/playlist", "/api/display/widget-data"]) {
      expect(paths, `the page used ${route}`).toContain(route);
    }
  });
});
