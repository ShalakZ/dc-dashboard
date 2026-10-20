import { appendFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { navLink, rowAction } from "./shell";

// W28 (display screens): a playlist is an ordered list of dashboards, a display is a screen that opens a secret link once and then shows one playlist without signing in. Admin `admin` /
// `correct-horse`, as in the earlier projects. The contract is the plan docs/superpowers/plans/2026-10-20-w28-display-links-and-playlists.md ("API contract" and the decisions) and the rulings of
// .waves/w28.md.
//
// IT MAKES ITS OWN DATA and needs nothing from the stack: beforeAll makes an asset `W28 <run> site` and two dashboards (`W28 <run> dash a` and `... dash b`, one energy stat each, so neither is skipped as
// "no widgets"), through the API. Every playlist, display and dashboard a case makes has a name that starts `W28 <run>`; afterAll deletes them all, each step on its own and also after a failed case
// (displays first: a playlist a display still uses cannot be deleted; then playlists, dashboards, the asset), and beforeAll sweeps what an earlier run left (a REVOKED display keeps its name until it is deleted).
// The cases are serial: case 2 opens the link case 1 made. The display secrets this spec used are appended, one per line, to the file named by W28_SECRET_FILE (default /tmp/w28-secret.txt) for the
// controller's log grep; no assertion message of this file holds a secret, a link or the cookie.
//   1   THE LINK IS SHOWN ONCE. Administer > Displays through the sidebar; a playlist with two dashboards and a display made in the dialogs; the "Display link" field holds `<origin>/display#<secret>`;
//       Copy link says Copied (or the fallback sentence); after Done neither the page, nor its storage, nor a reload holds the secret.
//   2   A NEW BROWSER OPENS THE LINK. The address becomes exactly /display (no fragment), the cookie `dcdash_display` is httpOnly, SameSite=Strict, Path=/api/display and not readable by the page, the
//       page says "Connected as ... 2 dashboards."; that cookie (also sent by hand) gets 401 on /api/me, /api/widget-data, /api/dashboards and /api/assets; the display routes answer 200, the figures equal the
//       admin's /api/widget-data for the stored widget, and an administrator's own session means nothing on them.
//   3   REVOKE. A display page under page.clock; the administrator revokes it (Actions > Revoke > Revoke); one minute later the page says "revoked or is not valid" and the Screens card says Revoked.
//   4   A DELETED DASHBOARD. Deleting one dashboard of a playlist in use: the Displays page says "The dashboard ... was deleted" and "1 item is skipped", the display page "(1 skipped)".
//   5   KEYBOARD ONLY, 1440 x 900 and 1024 x 640, light and dark. Tab and Enter reach New playlist and New display; the playlist is made with Move up, Move down and Remove; the row menu and Revoke work
//       from the keyboard; focus returns to the opener when each dialog closes; the page never scrolls sideways and the dialogs' buttons stay inside the window.
//   6   LAST: the claim's block. Ten wrong secrets answer 401 with one body, the eleventh 429 with Retry-After. It blocks the stack's client address for 15 minutes (every claim from it, a right
//       one too), which is why it is the last case of the last project; W28_SKIP_BLOCK skips it (single-spec loops on a stack that already ran it; run it again only after the api container of the
//       scratch project was restarted, never `dcdash`). No earlier case makes a wrong claim, so the limiter is empty when this one starts.
// Names are matched by SUBSTRING, so every lookup is `exact: true`. Assertions that depend on timing or on the browser, which nobody could check while writing this, are listed in the commit's status block.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ORIGIN = new URL(BASE_URL).origin;
const SECRET_FILE: string = process.env.W28_SECRET_FILE ?? "/tmp/w28-secret.txt";
const SKIP_BLOCK = Boolean(process.env.W28_SKIP_BLOCK);

interface Look { mode: "light" | "dark"; theme: string }
interface Box { x: number; y: number; width: number; height: number }
const LIGHT: Look = { mode: "light", theme: "navy-gold" };
const DARK: Look = { mode: "dark", theme: "desert-gold" };

const RUN = Date.now().toString(36);
/** A name that belongs to this run. No name below is the start of another, so a row or a sentence is never matched twice. */
const name = (what: string): string => `W28 ${RUN} ${what}`;
/** What an earlier run that stopped half way may have left behind: `W28 ` and a run id (Date.now() in base 36 is 8 characters until 2059), nothing a person named. */
const LEFTOVER = /^W28 [0-9a-z]{8}( |$)/;

const ASSET = name("site");
const DASH_A = name("dash a");
const DASH_B = name("dash b");
const LIST = name("wall"); // case 1 and 2
const SCREEN = name("hall tv");

const COOKIE = "dcdash_display";
const INVALID_LINK = { detail: "this display link is not valid" };

// ---------------------------------------------------------------------------------------------------------------------------------
// The API shapes this spec reads (written here, so a change of the server shows up as a failure)

interface ApiAsset { id: number; parent_id: number | null; name: string }
interface ApiWidget { id: number; type: string; title: string; config: Record<string, unknown>; x: number; y: number; w: number; h: number }
interface ApiDashboard { id: number; name: string; range: string; updated_at: string; widgets: ApiWidget[] }
interface ApiItem { id: number; position: number; seconds: number; dashboard_id: number | null; dashboard_name: string | null; skipped: string | null }
interface ApiPlaylist { id: number; name: string; item_count: number; skipped_count: number; items: ApiItem[] }
interface ApiDisplay { id: number; name: string; playlist_id: number; status: "active" | "revoked"; last_seen_at: string | null; last_client: string | null }
interface ApiDisplays { displays: ApiDisplay[]; playlists: ApiPlaylist[] }
interface DisplayItem { id: number; seconds: number; skipped: string | null; dashboard: { id: number; name: string; range: string; widgets: ApiWidget[] } | null }
interface DisplayAnswer { display: { name: string }; playlist: { name: string; items: DisplayItem[] } }

// ---------------------------------------------------------------------------------------------------------------------------------
// What the cases share

const real = { assetId: 0, dashA: 0, dashB: 0 };
/** The look the account had before this spec (read from GET /api/me in beforeAll); afterAll stores exactly this one. */
let originalLook: Look = LIGHT;
/** What case 1 made and case 2 opens. */
const link = { url: "", secret: "" };

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

/** A dashboard on the range "yesterday" (a closed range, so two answers a moment apart are equal) with ONE energy stat of the asset: a dashboard with no widgets is skipped by a screen. */
async function createDashboard(request: APIRequestContext, dashboardName: string): Promise<ApiDashboard> {
  const created = await request.post("/api/dashboards", { data: { name: dashboardName, range: "yesterday" } });
  expect(created.ok(), `creating ${dashboardName}: ${created.status()} ${await created.text()}`).toBe(true);
  const made = (await created.json()) as ApiDashboard;
  const config = { assets: [real.assetId], source: "energy", metric: null, aggregation: "sum", range: null, bars: "asset", min: 0, max: null };
  const widgets = [{ title: "W28 energy", type: "stat", x: 0, y: 0, w: 3, h: 2, config }];
  const saved = await request.put(`/api/dashboards/${made.id}`, { data: { name: dashboardName, range: "yesterday", updated_at: made.updated_at, widgets } });
  expect(saved.ok(), `saving the widget of ${dashboardName}: ${saved.status()} ${await saved.text()}`).toBe(true);
  return json<ApiDashboard>(request, `/api/dashboards/${made.id}`);
}

async function createPlaylist(request: APIRequestContext, playlistName: string, dashboardIds: number[]): Promise<ApiPlaylist> {
  const made = await request.post("/api/playlists", { data: { name: playlistName, items: dashboardIds.map((dashboard_id) => ({ dashboard_id, seconds: 10 })) } });
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

test.describe.configure({ mode: "serial" });

test.describe("W28: display screens", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    await asAdmin(browser, async (request) => {
      const me = await json<{ preferences: Look }>(request, "/api/me");
      originalLook = { mode: me.preferences.mode, theme: me.preferences.theme }; // what the account had before this spec; afterAll puts exactly this back
      const prefs = await request.put("/api/me/preferences", { data: LIGHT });
      expect(prefs.ok(), `starting from the light look: ${prefs.status()} ${await prefs.text()}`).toBe(true);
      await removeAll(request);
      real.assetId = await createAsset(request, ASSET);
      real.dashA = (await createDashboard(request, DASH_A)).id;
      real.dashB = (await createDashboard(request, DASH_B)).id;
    });
  });

  test.afterAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const failures: string[] = [];
    const step = async (what: string, run: (request: APIRequestContext) => Promise<unknown>) => {
      try {
        await asAdmin(browser, run);
      } catch (e) {
        failures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    await step("deleting the displays, playlists, dashboards and the asset", removeAll);
    await step("putting the look back", async (request) => {
      const back = await request.put("/api/me/preferences", { data: originalLook });
      expect(back.ok(), `putting the look back: ${back.status()}`).toBe(true);
    });
    expect(failures, "the clean-up put the stack back").toEqual([]);
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // The browser: sign in, the look, locators, boxes

  async function setLook(page: Page, look: Look): Promise<void> {
    const saved = await page.request.put("/api/me/preferences", { data: look });
    expect(saved.ok(), `storing ${JSON.stringify(look)}: ${saved.status()} ${await saved.text()}`).toBe(true);
  }

  /** Signs in as the admin and stores the look the case needs (the account's saved look wins over the browser's mirror) BEFORE any page opens. */
  async function signIn(page: Page, look: Look = LIGHT): Promise<void> {
    const login = await page.request.post("/api/login", { data: ADMIN });
    expect(login.ok(), `signing in: ${login.status()} ${await login.text()}`).toBe(true);
    await setLook(page, look);
  }

  async function expectLook(page: Page, look: Look): Promise<void> {
    await expect(page.locator("html"), `the page is in the ${look.mode} look`).toHaveAttribute("data-mode", look.mode === "dark" ? /dark/ : /light/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", look.theme);
  }

  type Scope = Pick<Page, "getByRole" | "getByLabel">;
  const button = (scope: Scope, label: string) => scope.getByRole("button", { name: label, exact: true });
  const dialogOf = (page: Page, label: string) => page.getByRole("dialog", { name: label, exact: true });
  /** The row of the Screens or the Playlists table that holds the `Actions for <name>` button of that name (a playlist's name is also written in its screens' rows). */
  const rowOf = (page: Page, thing: string) => page.getByRole("row").filter({ has: page.getByRole("button", { name: `Actions for ${thing}`, exact: true }) });
  /** The display page's one sentence. */
  const screenText = (page: Page) => page.locator(".display-screen-text");
  const connected = (display: string, playlist: string, dashboards: number, skipped = 0): string =>
    `Connected as ${display}. Playlist ${playlist}: ${dashboards} ${dashboards === 1 ? "dashboard" : "dashboards"}${skipped > 0 ? ` (${skipped} skipped)` : ""}. The rotating screen arrives in the next update.`;

  /** The Displays page, loaded: its heading is there and no skeleton is left. */
  async function openDisplays(page: Page): Promise<void> {
    await page.goto("/displays");
    await expect(page.getByRole("heading", { level: 1, name: "Displays", exact: true })).toBeVisible();
    await expect(page.locator(".sk-region"), "the page has stopped loading").toHaveCount(0);
  }

  /** A browser of its own: no cookie of the administrator's, the display cookie only after it opens a link. */
  async function newScreen(browser: Browser): Promise<{ context: BrowserContext; screen: Page }> {
    const context = await browser.newContext({ baseURL: BASE_URL });
    return { context, screen: await context.newPage() };
  }

  /** The address is exactly `<origin>/display`. A boolean, so a failure never prints an address that still holds a fragment. */
  async function expectBareDisplayAddress(screen: Page): Promise<void> {
    await expect.poll(() => screen.url() === `${ORIGIN}/display`, { message: "the address is /display with no fragment" }).toBe(true);
  }

  async function boxOf(target: Locator): Promise<Box> {
    return target.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  }
  async function expectInsideWindow(page: Page, target: Locator, what: string): Promise<void> {
    const view = page.viewportSize()!;
    const box = await boxOf(target);
    const slack = 1;
    const inside = box.x >= -slack && box.y >= -slack && box.x + box.width <= view.width + slack && box.y + box.height <= view.height + slack;
    expect(inside, `${what} lies inside the window (${Math.round(box.x)}, ${Math.round(box.y)}, ${Math.round(box.width)} x ${Math.round(box.height)} in ${view.width} x ${view.height})`).toBe(true);
  }
  async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over, `${where}: the page does not scroll sideways`).toBeLessThanOrEqual(0);
  }

  /** What the clipboard holds, or null when this page may not read it (no clipboard API, no permission). */
  const readClipboard = (page: Page): Promise<string | null> =>
    page.evaluate(async () => {
      try {
        return navigator.clipboard ? await navigator.clipboard.readText() : null;
      } catch {
        return null;
      }
    });

  /** Presses Tab (Shift+Tab with `back`) until `target` holds the focus; throws when it is not reached in `max` presses. Counting presses by hand would break with every control added. */
  async function tabTo(page: Page, target: Locator, what: string, options: { back?: boolean; max?: number } = {}): Promise<void> {
    const max = options.max ?? 40;
    for (let presses = 0; presses < max; presses++) {
      await page.keyboard.press(options.back ? "Shift+Tab" : "Tab");
      if (await target.evaluate((el) => el === document.activeElement)) return;
    }
    throw new Error(`${options.back ? "Shift+Tab" : "Tab"} did not reach ${what} in ${max} presses`);
  }

  /**
   * Chooses an option of the select that holds the keyboard focus by typing the whole option name (the browser's own type-ahead). If the browser did not land on it (a difference between browsers,
   * not something this app does), the option is chosen directly; the assertions that follow look at the app's reaction either way.
   */
  async function chooseFocused(page: Page, select: Locator, label: string): Promise<void> {
    await expect(select).toBeFocused();
    await page.keyboard.type(label);
    const chosen = await select.evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? "");
    if (chosen !== label) await select.selectOption({ label });
  }

  // -------------------------------------------------------------------------------------------------------------------------------
  // Case 1

  test("1. an administrator makes a playlist and a display and sees the link once", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
    await signIn(page);
    await page.goto("/");
    await navLink(page, "Displays").click();
    await expect(page).toHaveURL(/\/displays$/);
    await expect(page.getByRole("heading", { level: 1, name: "Displays", exact: true })).toBeVisible();
    await expect(page.locator(".sk-region"), "the page has stopped loading").toHaveCount(0);

    // A playlist with the two dashboards.
    await button(page, "New playlist").click();
    const playlistDialog = dialogOf(page, "New playlist");
    await expect(playlistDialog).toBeVisible();
    await playlistDialog.getByLabel("Name", { exact: true }).fill(LIST);
    const items = playlistDialog.locator(".playlist-item");
    for (const [index, dashboard] of [DASH_A, DASH_B].entries()) {
      await button(playlistDialog, "Add a dashboard").click();
      await expect(items).toHaveCount(index + 1);
      await items.nth(index).getByLabel("Dashboard", { exact: true }).selectOption({ label: dashboard });
    }
    await button(playlistDialog, "Save").click();
    await expect(playlistDialog).toBeHidden();
    await expect(rowOf(page, LIST), "the playlist is listed with its two dashboards").toContainText("2 dashboards");

    // A display for it.
    const newDisplay = button(page, "New display");
    await expect(newDisplay).not.toHaveAttribute("aria-disabled", "true");
    await newDisplay.click();
    const displayDialog = dialogOf(page, "New display");
    await expect(displayDialog).toBeVisible();
    await displayDialog.getByLabel("Name", { exact: true }).fill(SCREEN);
    await displayDialog.getByLabel("Playlist", { exact: true }).selectOption({ label: LIST });
    await button(displayDialog, "Create display").click();

    // The link, once.
    const field = displayDialog.getByLabel("Display link", { exact: true });
    await expect(field).toBeVisible();
    const shown = await field.inputValue();
    expect(shown.startsWith(`${ORIGIN}/display#`), "the link is <origin>/display#<secret>").toBe(true);
    const secret = shown.slice(shown.indexOf("#") + 1);
    expect(/^[A-Za-z0-9_-]{43}$/.test(secret), "the secret is 43 URL-safe characters").toBe(true);
    recordSecret(secret);
    link.url = shown;
    link.secret = secret;
    await button(displayDialog, "Copy link").click();
    await expect(displayDialog.getByRole("status")).toHaveText(/^(Copied|Press Ctrl\+C to copy)$/);
    const copied = await readClipboard(page);
    if (copied !== null && copied !== "") expect(copied === shown, "the clipboard holds the link").toBe(true);

    // Done: the secret is nowhere in the page any more, and a reload does not bring it back.
    await button(displayDialog, "Done").click();
    await expect(displayDialog).toBeHidden();
    const holdsSecret = async () => {
      const html = await page.content();
      const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
      return html.includes(secret) || stored.includes(secret) || page.url().includes(secret);
    };
    expect(await holdsSecret(), "after Done the page holds no trace of the secret").toBe(false);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Displays", exact: true })).toBeVisible();
    await expect(rowOf(page, SCREEN), "the new screen has not connected yet").toContainText("Never connected");
    await expect(rowOf(page, SCREEN)).toContainText(LIST);
    expect(await holdsSecret(), "after a reload the page holds no trace of the secret").toBe(false);
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // Case 2

  test("2. a new browser opens the link: /display, the cookie, the three routes and nothing else", async ({ browser, page }) => {
    expect(link.secret, "case 1 made the link").not.toBe("");
    const { context, screen } = await newScreen(browser);
    try {
      await screen.goto(link.url);
      await expectBareDisplayAddress(screen);
      await expect(screenText(screen)).toHaveText(connected(SCREEN, LIST, 2));

      const cookie = (await context.cookies()).find((c) => c.name === COOKIE);
      expect(cookie, `the cookie ${COOKIE} is set`).toBeTruthy();
      expect(cookie!.httpOnly, "the cookie is httpOnly").toBe(true);
      expect(cookie!.sameSite, "the cookie is SameSite=Strict").toBe("Strict");
      expect(cookie!.path, "the cookie's path").toBe("/api/display");
      expect(cookie!.value === link.secret, "the cookie holds the secret of the link").toBe(true);
      expect(await screen.evaluate(() => document.cookie.includes("dcdash_display")), "the page cannot read the cookie").toBe(false);

      // The display cookie opens nothing else. A request of the context carries it only on /api/display; the same cookie is also sent by hand on every other path.
      const range = "yesterday";
      const probes: { method: "GET" | "POST"; path: string; data?: object }[] = [
        { method: "GET", path: "/api/me" },
        { method: "POST", path: "/api/widget-data", data: { type: "stat", range, config: { assets: [real.assetId], source: "energy", metric: null, aggregation: "sum", range: null, bars: "asset", min: 0, max: null } } },
        { method: "GET", path: "/api/dashboards" },
        { method: "GET", path: "/api/assets" },
      ];
      for (const probe of probes) {
        for (const byHand of [false, true]) {
          const response = await context.request.fetch(probe.path, { method: probe.method, data: probe.data, headers: byHand ? { cookie: `${COOKIE}=${link.secret}` } : undefined });
          expect(response.status(), `${probe.method} ${probe.path} ${byHand ? "with the display cookie sent by hand" : "from the display's browser"} answers 401`).toBe(401);
        }
      }

      // The three display routes.
      const playlist = await context.request.get("/api/display/playlist");
      expect(playlist.status(), "GET /api/display/playlist answers 200").toBe(200);
      const answer = (await playlist.json()) as DisplayAnswer;
      expect(answer.display.name).toBe(SCREEN);
      expect(answer.playlist.name).toBe(LIST);
      expect(answer.playlist.items.map((item) => [item.dashboard?.name, item.skipped])).toEqual([[DASH_A, null], [DASH_B, null]]);
      const item = answer.playlist.items[0];
      const widget = item.dashboard!.widgets[0];
      const figures = await context.request.post("/api/display/widget-data", { data: { item: item.id, widget: widget.id } });
      expect(figures.status(), "POST /api/display/widget-data answers 200").toBe(200);

      // The same figures as the administrator's own route gives for that stored widget (the widget has no range of its own: the dashboard's "yesterday" is used).
      await signIn(page);
      const admin = await page.request.post("/api/widget-data", { data: { type: widget.type, config: widget.config, range: (widget.config.range as string | null) ?? item.dashboard!.range } });
      expect(admin.status(), "POST /api/widget-data answers 200 for the administrator").toBe(200);
      expect(await figures.json(), "the display's figures equal the administrator's").toEqual(await admin.json());

      // An administrator's own session means nothing on the display routes.
      expect((await page.request.get("/api/display/playlist")).status(), "a signed-in administrator is not a display").toBe(401);
      expect((await page.request.post("/api/display/widget-data", { data: { item: item.id, widget: widget.id } })).status()).toBe(401);

      // The Displays page now knows the screen connected.
      await openDisplays(page);
      await expect(rowOf(page, SCREEN)).toContainText("Last connected");
      await expect(rowOf(page, SCREEN)).not.toContainText("Never connected");
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // Case 3

  test("3. revoking: the page says so within a minute and the Screens card says Revoked", async ({ browser, page }) => {
    const revList = name("rev list");
    const revScreen = name("rev tv");
    await signIn(page);
    const shown = await createDisplay(page.request, revScreen, (await createPlaylist(page.request, revList, [real.dashA, real.dashB])).id);

    const { context, screen } = await newScreen(browser);
    try {
      await screen.clock.install(); // before the page loads: the minute of its poll is then ours to move
      await screen.goto(shown.url);
      await expect(screenText(screen)).toHaveText(connected(revScreen, revList, 2));

      await openDisplays(page);
      const row = rowOf(page, revScreen);
      await (await rowAction(page, row, "Revoke")).click();
      const confirm = dialogOf(page, `Revoke ${revScreen}?`);
      await expect(confirm).toBeVisible();
      await button(confirm, "Revoke").click();
      await expect(confirm).toBeHidden();

      await screen.clock.fastForward(61_000);
      await expect(screenText(screen), "within the next poll the screen learns it was revoked").toContainText("revoked or is not valid");
      expect((await context.request.get("/api/display/playlist")).status(), "the revoked cookie is refused").toBe(401);
      await expect(row.getByText("Revoked", { exact: true }), "the Screens card says Revoked").toBeVisible();
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // Case 4

  test("4. a deleted dashboard is skipped, and both pages say so", async ({ browser, page }) => {
    const delList = name("del list");
    const delScreen = name("del tv");
    const dashC = name("dash c");
    const dashD = name("dash d");
    await signIn(page);
    const c = await createDashboard(page.request, dashC);
    const d = await createDashboard(page.request, dashD);
    const shown = await createDisplay(page.request, delScreen, (await createPlaylist(page.request, delList, [c.id, d.id])).id);

    const { context, screen } = await newScreen(browser);
    try {
      // The claim is made here, so that the page can be opened and reopened with no fragment at all, the way a screen that was set up earlier is.
      const claim = await context.request.post("/api/display/claim", { data: { secret: shown.secret } });
      expect(claim.status(), "the claim of the right secret answers 204").toBe(204);
      await screen.goto("/display");
      await expect(screenText(screen)).toHaveText(connected(delScreen, delList, 2));

      const gone = await page.request.delete(`/api/dashboards/${d.id}`);
      expect(gone.status(), `deleting ${dashD}: ${gone.status()}`).toBe(204);

      await openDisplays(page);
      const row = rowOf(page, delList);
      await expect(row).toContainText("1 item is skipped");
      await expect(row).toContainText(`The dashboard ${dashD} was deleted`);

      await screen.reload();
      await expect(screenText(screen)).toHaveText(connected(delScreen, delList, 2, 1));
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------------------------------------------------------------
  // Case 5

  interface Pass { width: number; height: number; look: Look; tag: string }
  const PASSES: Pass[] = [
    { width: 1440, height: 900, look: LIGHT, tag: "1440 light" },
    { width: 1440, height: 900, look: DARK, tag: "1440 dark" },
    { width: 1024, height: 640, look: LIGHT, tag: "1024 light" },
    { width: 1024, height: 640, look: DARK, tag: "1024 dark" },
  ];

  for (const pass of PASSES) {
    test(`5. keyboard only at ${pass.tag}`, async ({ page }) => {
      test.setTimeout(240_000);
      const kbList = name(`kb ${pass.tag} list`);
      const kbScreen = name(`kb ${pass.tag} tv`);
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
      await page.setViewportSize({ width: pass.width, height: pass.height });
      await signIn(page, pass.look);
      await openDisplays(page);
      await expectLook(page, pass.look);
      await expectNoSidewaysScroll(page, `the Displays page at ${pass.tag}`);

      // From the heading, Tab reaches New playlist and then New display (the page's actions).
      const newPlaylist = button(page, "New playlist");
      const newDisplay = button(page, "New display");
      await page.getByRole("heading", { level: 1, name: "Displays", exact: true }).focus();
      await tabTo(page, newPlaylist, "New playlist", { max: 6 });
      await page.keyboard.press("Enter");

      // The playlist: two dashboards, then Move up, Move down and Remove from the keyboard.
      const playlistDialog = dialogOf(page, "New playlist");
      await expect(playlistDialog).toBeVisible();
      await expect(playlistDialog.getByLabel("Name", { exact: true })).toBeFocused();
      await page.keyboard.type(kbList);
      const selects = playlistDialog.getByLabel("Dashboard", { exact: true });
      const add = button(playlistDialog, "Add a dashboard");
      const group = (position: number, dashboard: string) => playlistDialog.getByRole("group", { name: `Item ${position}: ${dashboard}`, exact: true });

      await tabTo(page, add, "Add a dashboard");
      await page.keyboard.press("Enter");
      await chooseFocused(page, selects.nth(0), DASH_A);
      await expect(group(1, DASH_A)).toBeVisible();
      await tabTo(page, add, "Add a dashboard");
      await page.keyboard.press("Enter");
      await chooseFocused(page, selects.nth(1), DASH_B);
      await expect(group(2, DASH_B)).toBeVisible();
      await expectNoSidewaysScroll(page, `the playlist dialog at ${pass.tag}`);

      const moveUpB = button(playlistDialog, `Move up ${DASH_B}`);
      const moveDownB = button(playlistDialog, `Move down ${DASH_B}`);
      await tabTo(page, moveUpB, "Move up (second dashboard)", { back: true });
      await page.keyboard.press("Enter");
      await expect(group(1, DASH_B), "Move up put the second dashboard first").toBeVisible();
      await expect(group(2, DASH_A)).toBeVisible();
      await expect(moveUpB, "the focus stays on the button that was pressed").toBeFocused();
      await tabTo(page, moveDownB, "Move down (first dashboard)");
      await page.keyboard.press("Enter");
      await expect(group(1, DASH_A), "Move down put it back").toBeVisible();
      await expect(group(2, DASH_B)).toBeVisible();
      await expect(moveDownB).toBeFocused();

      await tabTo(page, button(playlistDialog, `Remove ${DASH_B}`), "Remove (second dashboard)");
      await page.keyboard.press("Enter");
      await expect(playlistDialog.locator(".playlist-item"), "Remove took the second dashboard out").toHaveCount(1);
      await expect(button(playlistDialog, `Remove ${DASH_A}`), "the focus went to the neighbour's Remove").toBeFocused();

      await tabTo(page, add, "Add a dashboard");
      await page.keyboard.press("Enter");
      await chooseFocused(page, selects.nth(1), DASH_B);
      await expect(group(2, DASH_B)).toBeVisible();
      const save = button(playlistDialog, "Save");
      await tabTo(page, save, "Save");
      await expectInsideWindow(page, save, "Save");
      await page.keyboard.press("Enter");
      await expect(playlistDialog).toBeHidden();
      await expect(newPlaylist, "the focus returns to New playlist").toBeFocused();
      await expect(rowOf(page, kbList)).toContainText("2 dashboards");
      const stored = (await json<ApiDisplays>(page.request, "/api/displays")).playlists.find((p) => p.name === kbList);
      expect(stored?.items.map((item) => item.dashboard_name), "the playlist holds the dashboards in the order made").toEqual([DASH_A, DASH_B]);

      // The display.
      await expect(newDisplay).not.toHaveAttribute("aria-disabled", "true");
      await tabTo(page, newDisplay, "New display", { max: 6 });
      await page.keyboard.press("Enter");
      const displayDialog = dialogOf(page, "New display");
      await expect(displayDialog).toBeVisible();
      await expect(displayDialog.getByLabel("Name", { exact: true })).toBeFocused();
      await page.keyboard.type(kbScreen);
      await page.keyboard.press("Tab");
      await chooseFocused(page, displayDialog.getByLabel("Playlist", { exact: true }), kbList);
      await tabTo(page, button(displayDialog, "Create display"), "Create display");
      await page.keyboard.press("Enter");
      await expect(button(displayDialog, "Copy link"), "the focus lands on Copy link").toBeFocused();
      const shown = await displayDialog.getByLabel("Display link", { exact: true }).inputValue();
      const secret = shown.slice(shown.indexOf("#") + 1);
      expect(/^[A-Za-z0-9_-]{43}$/.test(secret), "the secret is 43 URL-safe characters").toBe(true);
      recordSecret(secret);
      await page.keyboard.press("Enter");
      await expect(displayDialog.getByRole("status")).toHaveText(/^(Copied|Press Ctrl\+C to copy)$/);
      await expectNoSidewaysScroll(page, `the link step at ${pass.tag}`);
      const done = button(displayDialog, "Done");
      await tabTo(page, done, "Done");
      await expectInsideWindow(page, done, "Done");
      await page.keyboard.press("Enter");
      await expect(displayDialog).toBeHidden();
      await expect(newDisplay, "the focus returns to New display").toBeFocused();
      expect((await page.content()).includes(secret), "after Done the page holds no trace of the secret").toBe(false);

      // The row menu and Revoke.
      const actions = page.getByRole("button", { name: `Actions for ${kbScreen}`, exact: true });
      await tabTo(page, actions, "the screen's Actions button", { max: 60 });
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu", { name: `Actions for ${kbScreen}`, exact: true });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Rename", exact: true })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await expect(menu.getByRole("menuitem", { name: "Revoke", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      const confirm = dialogOf(page, `Revoke ${kbScreen}?`);
      await expect(confirm).toBeVisible();
      await expect(button(confirm, "Cancel"), "the confirmation opens on the harmless button").toBeFocused();
      await page.keyboard.press("Tab");
      await expect(button(confirm, "Revoke")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(confirm).toBeHidden();
      await expect(actions, "the focus returns to the row's Actions button").toBeFocused();
      await expect(rowOf(page, kbScreen).getByText("Revoked", { exact: true })).toBeVisible();
      await expectNoSidewaysScroll(page, `the Displays page at ${pass.tag}, after the revoke`);
    });
  }

  // -------------------------------------------------------------------------------------------------------------------------------
  // Case 6

  // LAST, on purpose: ten wrong secrets block the stack's one client address for 15 minutes, and the block also refuses a RIGHT secret, so no claim that follows would connect. It
  // also needs the limiter to be empty, which holds because no earlier case makes a wrong claim. W28_SKIP_BLOCK skips it when a stack has run it already.
  test("6. the eleventh wrong claim from one address is refused with Retry-After", async ({ request }) => {
    test.skip(SKIP_BLOCK, "W28_SKIP_BLOCK is set: this case blocks the stack's client address for 15 minutes");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const wrong = (): string => Array.from({ length: 43 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
    const claim = (secret: string) => request.post("/api/display/claim", { data: { secret } });
    for (let attempt = 1; attempt <= 10; attempt++) {
      const response = await claim(wrong());
      expect(response.status(), `wrong claim ${attempt} of 10 answers 401`).toBe(401);
      expect(await response.json(), `wrong claim ${attempt} of 10 has the one body`).toEqual(INVALID_LINK);
    }
    const blocked = await claim(wrong());
    expect(blocked.status(), "the eleventh claim is refused as blocked").toBe(429);
    const retryAfter = Number(blocked.headers()["retry-after"]);
    expect(Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 900, `Retry-After is a number of seconds up to 15 minutes (got ${blocked.headers()["retry-after"]})`).toBe(true);
  });
});
