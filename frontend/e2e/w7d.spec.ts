import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { roleLabel } from "./roles";
import { signOut, userBlock } from "./shell";

// W7d (the Appearance choice in the profile panel: Mode and Theme colour, stored on the account, mirrored in the browser) on the state
// the earlier projects leave behind: admin `admin` / `correct-horse` and the asset MV2. The spec makes a viewer and one dashboard with a
// stat widget through the API (with a run suffix) and removes them again; whatever happens, afterAll puts the admin's choice back to
// Light and Navy and gold, which is what a re-run and the later gallery expect.
//
// Locators: the panel is `#profile-panel` (hidden while closed, so a radio is only ever looked up through it, inside its group); the
// groups are `Mode` and `Theme colour`, the radios are matched with `exact: true`. The look is read from <html data-mode data-theme>.
// The choice is saved in the background, so every choice waits for the PUT before the test reloads or reads the account.

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse", role: "admin" };
const VIEWER = { username: "w7d-viewer", password: "w7d-viewer-pass", role: "viewer" };
type Account = typeof ADMIN;
interface Look { mode: string; theme: string }

const DEFAULT_LOOK: Look = { mode: "light", theme: "navy-gold" };
const MAROON_DARK: Look = { mode: "dark", theme: "maroon-gold" };
const MIRROR_KEY = "dcdash.appearance";

const RUN = Date.now().toString(36);
const DASHBOARD = `W7d dark ${RUN}`;
const WIDGET = `W7d stat ${RUN}`;

// Computed colours (Chromium prints rgb(...)): the page ground of both modes, the maroon side panel, the navy one of the default.
const PAGE_LIGHT = "rgb(255, 255, 255)";
const PAGE_DARK = "rgb(21, 24, 30)";
const SIDE_MAROON = "rgb(125, 8, 73)";
const SIDE_NAVY = "rgb(40, 51, 84)";

async function signIn(page: Page, who: Account) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(who.username);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(userBlock(page)).toContainText(who.username);
  await expect(userBlock(page)).toContainText(roleLabel(who.role));
}

/** Runs `use` with the request context of a fresh browser context in which the admin is signed in. */
async function asAdmin<T>(browser: Browser, use: (request: APIRequestContext) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    const login = await context.request.post("/api/login", { data: { username: ADMIN.username, password: ADMIN.password } });
    expect(login.ok(), "the admin signs in").toBe(true);
    return await use(context.request);
  } finally {
    await context.close();
  }
}

/** Stores the admin's look on the account, so a test starts from a known choice whatever an earlier one left. */
async function setAdminLook(browser: Browser, look: Look): Promise<void> {
  await asAdmin(browser, async (request) => {
    const saved = await request.put("/api/me/preferences", { data: look });
    expect(saved.ok(), `storing ${JSON.stringify(look)}: ${saved.status()} ${await saved.text()}`).toBe(true);
  });
}

const html = (page: Page) => page.locator("html");
const panelOf = (page: Page) => page.locator("#profile-panel");
const modeGroup = (page: Page) => panelOf(page).getByRole("group", { name: "Mode", exact: true });
const themeGroup = (page: Page) => panelOf(page).getByRole("group", { name: "Theme colour", exact: true });
const radio = (group: Locator, label: string) => group.getByLabel(label, { exact: true });

async function expectLook(page: Page, look: Look): Promise<void> {
  await expect(html(page)).toHaveAttribute("data-mode", look.mode);
  await expect(html(page)).toHaveAttribute("data-theme", look.theme);
}

const mirrorOf = (page: Page) => page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? "null") as Look | null, MIRROR_KEY);

const isSave = (r: { url(): string; request(): { method(): string } }) => new URL(r.url()).pathname === "/api/me/preferences" && r.request().method() === "PUT";

/** Runs `act` (a choice in the panel) and waits for the PUT it causes; the choice must be a change, or no PUT is sent. */
async function saving(page: Page, act: () => Promise<void>): Promise<void> {
  const [response] = await Promise.all([page.waitForResponse(isSave), act()]);
  expect(response.ok(), `saving the look: ${response.status()}`).toBe(true);
}

async function openPanel(page: Page): Promise<void> {
  await userBlock(page).click();
  await expect(panelOf(page)).toBeVisible();
}

/** Two animation frames: whatever the page does about a changed media query has happened by then. */
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

const sidewaysOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe.serial("W7d: appearance", () => {
  let dashboardId = 0;
  let viewerId = 0;

  test.beforeAll(async ({ browser }) => {
    await asAdmin(browser, async (request) => {
      const saved = await request.put("/api/me/preferences", { data: DEFAULT_LOOK });
      expect(saved.ok(), `starting from the default look: ${saved.status()} ${await saved.text()}`).toBe(true);

      // No account left over from an earlier run that stopped half way.
      const users = (await (await request.get("/api/users")).json()) as { id: number; username: string }[];
      for (const old of users.filter((u) => u.username === VIEWER.username)) await request.delete(`/api/users/${old.id}`);
      const made = await request.post("/api/users", { data: { username: VIEWER.username, password: VIEWER.password, role: VIEWER.role } });
      expect(made.ok(), `creating ${VIEWER.username}: ${made.status()} ${await made.text()}`).toBe(true);
      viewerId = ((await made.json()) as { id: number }).id;

      // A dashboard with one stat widget, to look at a widget frame in dark mode (the frame exists whether or not there is data).
      const assets = (await (await request.get("/api/assets")).json()) as { id: number; name: string }[];
      const asset = assets.find((a) => a.name === "MV2") ?? assets[0];
      expect(asset, "an asset to put the stat widget on").toBeTruthy();
      const created = await request.post("/api/dashboards", { data: { name: DASHBOARD, range: "24h" } });
      expect(created.ok(), `creating the dashboard: ${created.status()} ${await created.text()}`).toBe(true);
      const dashboard = (await created.json()) as { id: number; updated_at: string };
      dashboardId = dashboard.id;
      const widgets = [
        {
          type: "stat", title: WIDGET, x: 0, y: 0, w: 4, h: 2,
          config: { assets: [asset.id], source: "metric", metric: "active_power_kw", aggregation: "last", range: null },
        },
      ];
      const filled = await request.put(`/api/dashboards/${dashboardId}`, { data: { name: DASHBOARD, range: "24h", updated_at: dashboard.updated_at, widgets } });
      expect(filled.ok(), `adding the widget: ${filled.status()} ${await filled.text()}`).toBe(true);
    });
  });

  test.afterAll(async ({ browser }) => {
    await asAdmin(browser, async (request) => {
      await request.put("/api/me/preferences", { data: DEFAULT_LOOK });
      if (dashboardId) await request.delete(`/api/dashboards/${dashboardId}`);
      if (viewerId) await request.delete(`/api/users/${viewerId}`);
    });
  });

  test("the profile panel offers Mode and Theme colour; a choice applies at once, is saved on the account and survives a cleared browser", async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, ADMIN);

    await test.step("the account starts on Light and Navy and gold", async () => {
      await expectLook(page, DEFAULT_LOOK);
      await expect(page.locator("body")).toHaveCSS("background-color", PAGE_LIGHT);
      await expect(page.locator(".side")).toHaveCSS("background-color", SIDE_NAVY);
    });

    await test.step("the panel has the two groups with their radios, and the current choice is checked", async () => {
      await openPanel(page);
      await expect(modeGroup(page).getByRole("radio")).toHaveCount(3);
      await expect(themeGroup(page).getByRole("radio")).toHaveCount(4);
      for (const label of ["Light", "Dark", "Match my device"]) await expect(radio(modeGroup(page), label)).toBeVisible();
      for (const label of ["Navy and gold", "Maroon and gold", "Graphite", "Desert gold"]) await expect(radio(themeGroup(page), label)).toBeVisible();
      await expect(radio(modeGroup(page), "Light")).toBeChecked();
      await expect(radio(themeGroup(page), "Navy and gold")).toBeChecked();
    });

    await test.step("Dark applies at once, the panel stays open, and the choice is mirrored in the browser", async () => {
      await saving(page, () => radio(modeGroup(page), "Dark").check());
      await expect(html(page)).toHaveAttribute("data-mode", "dark");
      await expect(page.locator("body")).toHaveCSS("background-color", PAGE_DARK);
      await expect(panelOf(page)).toBeVisible();
      await expect(radio(modeGroup(page), "Dark")).toBeChecked();
    });

    await test.step("Maroon and gold turns the side panel maroon", async () => {
      await saving(page, () => radio(themeGroup(page), "Maroon and gold").check());
      await expectLook(page, MAROON_DARK);
      await expect(page.locator(".side")).toHaveCSS("background-color", SIDE_MAROON);
      expect(await mirrorOf(page)).toEqual(MAROON_DARK);
    });

    await test.step("the account holds it: /api/me answers the choice", async () => {
      const me = (await (await page.request.get("/api/me")).json()) as { preferences: Look };
      expect(me.preferences).toEqual(MAROON_DARK);
    });

    await test.step("with the browser's mirror cleared, a reload brings the choice back from the account", async () => {
      await page.evaluate(() => window.localStorage.clear());
      await page.reload();
      await expectLook(page, MAROON_DARK);
      await expect(page.locator(".side")).toHaveCSS("background-color", SIDE_MAROON);
      await expect.poll(() => mirrorOf(page), { message: "the mirror is written again from the account" }).toEqual(MAROON_DARK);
    });
  });

  test("signing out keeps the look on the sign-in page; another account on the same browser gets its own, not the first one's", async ({ page, browser }) => {
    test.setTimeout(180_000);
    await setAdminLook(browser, MAROON_DARK);
    await signIn(page, ADMIN);
    await expectLook(page, MAROON_DARK);

    await test.step("after Sign out the sign-in page still wears the last look used on this browser", async () => {
      await signOut(page);
      await expectLook(page, MAROON_DARK);
      await expect(page.locator("body")).toHaveCSS("background-color", PAGE_DARK);
      expect(await mirrorOf(page)).toEqual(MAROON_DARK);
    });

    await test.step("a viewer who has never chosen anything signs in on the same browser: the default look, and the mirror follows", async () => {
      await signIn(page, VIEWER);
      await expectLook(page, DEFAULT_LOOK);
      await expect(page.locator("body")).toHaveCSS("background-color", PAGE_LIGHT);
      await expect(page.locator(".side")).toHaveCSS("background-color", SIDE_NAVY);
      expect(await mirrorOf(page)).toEqual(DEFAULT_LOOK);
      await signOut(page);
      await expectLook(page, DEFAULT_LOOK);
    });

    await test.step("the admin signs in again and the account's own choice returns", async () => {
      await signIn(page, ADMIN);
      await expectLook(page, MAROON_DARK);
      await expect(page.locator(".side")).toHaveCSS("background-color", SIDE_MAROON);
    });
  });

  test("Match my device follows the device while it is chosen, and stops following once Light or Dark is picked", async ({ page, browser }) => {
    test.setTimeout(180_000);
    await setAdminLook(browser, DEFAULT_LOOK);
    await page.emulateMedia({ colorScheme: "light" });
    await signIn(page, ADMIN);
    await expectLook(page, DEFAULT_LOOK);
    await openPanel(page);

    await saving(page, () => radio(modeGroup(page), "Match my device").check());
    await expect(radio(modeGroup(page), "Match my device")).toBeChecked();
    await expect(html(page)).toHaveAttribute("data-mode", "light"); // the device is light
    expect(await mirrorOf(page)).toEqual({ mode: "system", theme: "navy-gold" });

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html(page)).toHaveAttribute("data-mode", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(html(page)).toHaveAttribute("data-mode", "light");

    // A page load resolves it before the first paint, from the mirror, and again from the account.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html(page)).toHaveAttribute("data-mode", "dark");
    await page.reload();
    await expect(html(page)).toHaveAttribute("data-mode", "dark");
    await expect(html(page)).toHaveAttribute("data-theme", "navy-gold");

    await openPanel(page);
    await saving(page, () => radio(modeGroup(page), "Light").check());
    await expect(html(page)).toHaveAttribute("data-mode", "light");
    await page.emulateMedia({ colorScheme: "light" });
    await page.emulateMedia({ colorScheme: "dark" });
    await settled(page);
    await expect(html(page), "Light stays Light when the device changes").toHaveAttribute("data-mode", "light");
  });

  test("keyboard: Tab walks the two groups, an arrow changes the choice and stays in the group, Esc closes to the trigger", async ({ page, browser }) => {
    test.setTimeout(180_000);
    await setAdminLook(browser, DEFAULT_LOOK);
    await signIn(page, ADMIN);
    const trigger = userBlock(page);
    const password = panelOf(page).getByRole("link", { name: "Password", exact: true });
    const signOutButton = panelOf(page).getByRole("button", { name: "Sign out", exact: true });

    await test.step("ArrowDown on the trigger opens the panel and lands on Password; Esc closes it and the focus is back on the trigger", async () => {
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      await expect(panelOf(page)).toBeVisible();
      await expect(password).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(panelOf(page)).toBeHidden();
      await expect(trigger).toBeFocused();
    });

    await test.step("Tab from the trigger reaches the Mode group, then Theme colour, then Password, then Sign out", async () => {
      await page.keyboard.press("Enter");
      await expect(panelOf(page)).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(radio(modeGroup(page), "Light")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(radio(themeGroup(page), "Navy and gold")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(password).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(signOutButton).toBeFocused();
      for (let back = 0; back < 3; back++) await page.keyboard.press("Shift+Tab");
      await expect(radio(modeGroup(page), "Light")).toBeFocused();
    });

    await test.step("ArrowDown on a radio picks the next one and keeps the focus in the group; ArrowUp goes back", async () => {
      await saving(page, () => page.keyboard.press("ArrowDown"));
      await expect(radio(modeGroup(page), "Dark")).toBeChecked();
      await expect(radio(modeGroup(page), "Dark")).toBeFocused();
      await expect(html(page)).toHaveAttribute("data-mode", "dark");
      await expect(panelOf(page)).toBeVisible();

      await saving(page, () => page.keyboard.press("ArrowUp"));
      await expect(radio(modeGroup(page), "Light")).toBeChecked();
      await expect(radio(modeGroup(page), "Light")).toBeFocused();
      await expect(html(page)).toHaveAttribute("data-mode", "light");
    });

    await test.step("Esc closes the panel from inside a group and the focus returns to the trigger", async () => {
      await page.keyboard.press("Escape");
      await expect(panelOf(page)).toBeHidden();
      await expect(trigger).toBeFocused();
    });
  });

  test("dark mode: a widget frame stays white and the pages do not scroll sideways at 1440 and 1024", async ({ page, browser }) => {
    test.setTimeout(240_000);
    await setAdminLook(browser, MAROON_DARK);
    await signIn(page, ADMIN);
    await expectLook(page, MAROON_DARK);

    const pages: [string, string][] = [
      [`/dashboards/${dashboardId}`, "the dashboard"],
      ["/assets", "Assets"],
    ];
    for (const [width, height] of [[1440, 900], [1024, 768]]) {
      await page.setViewportSize({ width, height });
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
      for (const [path, name] of pages) {
        await test.step(`${name} at ${width} px`, async () => {
          await page.goto(path);
          await expectLook(page, MAROON_DARK);
          await expect(page.locator("body")).toHaveCSS("background-color", PAGE_DARK);
          if (path.startsWith("/dashboards/")) {
            const frame = page.getByRole("region", { name: WIDGET, exact: true });
            await expect(frame).toBeVisible();
            await expect(frame, "the widget stays a light card on the dark page").toHaveCSS("background-color", PAGE_LIGHT);
          }
          await expect.poll(() => sidewaysOverflow(page), { message: `the sideways overflow of ${name} in pixels` }).toBeLessThanOrEqual(0);
        });
      }
    }
  });

  test("theme-init.js is served as JavaScript and the page loads it without a CSP violation", async ({ page, request }) => {
    const script = await request.get("/theme-init.js");
    expect(script.ok(), "GET /theme-init.js").toBe(true);
    expect(script.headers()["content-type"] ?? "").toMatch(/javascript/i);
    expect(await script.text()).toContain(MIRROR_KEY);

    const violations: string[] = [];
    page.on("console", (message) => {
      if (/content security policy/i.test(message.text())) violations.push(message.text());
    });
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(violations).toEqual([]);
  });
});
