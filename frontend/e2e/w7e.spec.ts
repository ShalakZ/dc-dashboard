import { expect, test, type APIRequestContext, type Browser, type Page, type Route } from "@playwright/test";
import { roleLabel } from "./roles";
import { navLink, userBlock } from "./shell";

// W7e (the content accent follows the theme colour; Mode and Theme colour are dropdowns; a loading bar along the top edge in the theme's
// marker colour; kind icons in the Assets workspace) on the state the earlier projects leave behind: admin `admin` / `correct-horse` and
// the root asset `Site`. The spec makes two assets (a Panel with a long name and a Rack), one dashboard with a stat widget and nothing
// else, through the API with a run suffix, and removes them again; whatever happens, afterAll puts the admin's choice back to Light and
// Navy and gold, which is what a re-run and the later gallery expect.
//
// Colours are compared with the look's own tokens, read through a probe element on <html> (`tokenColour`), so the spec pins the wiring (a
// button, a link, the selected row, the bar take THE THEME'S token) and not the palette: the palette is pinned by themes.css.test.ts, and
// the owner may tune it. The one literal is the blue every look had before W7e (the old widget island's #1d5bd8), which no look but Graphite light may still have.
//
// The two selects are `#profile-panel` > `Mode` and `Theme colour` (matched with `exact: true`, as in w7d). The panel is an overlay on the
// top right of the page, so a test that hovers or clicks the page header closes it first (`chooseLook` always leaves it closed).
// A native select popup has no DOM: the keyboard steps wait a moment after opening it, and rely on what Chromium does with an open popup
// (only the Escape KEYUP reaches the page, so the popup closes alone and the panel stays open; the highlighted option is kept).

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse", role: "admin" };
type Account = typeof ADMIN;
interface Look { mode: "light" | "dark"; theme: string }

const THEMES = ["navy-gold", "maroon-gold", "graphite", "desert-gold"];
// Light first, so a run that starts on the default look (Light, Navy and gold) begins with a no-op.
const LOOKS: Look[] = (["light", "dark"] as const).flatMap((mode) => THEMES.map((theme) => ({ mode, theme })));
const DEFAULT_LOOK: Look = { mode: "light", theme: "navy-gold" };
const MAROON_DARK: Look = { mode: "dark", theme: "maroon-gold" };

const RUN = Date.now().toString(36);
const PANEL = `W7e ${RUN} panel with a rather long name for the header`; // 57 characters: the header tile and the tree row have to cope
const RACK = `W7e ${RUN} rack`;
const DASHBOARD = `W7e ${RUN}`;
const WIDGET = `W7e stat ${RUN}`;

const OLD_BLUE = "rgb(29, 91, 216)"; // the accent every look had before W7e, and the old widget island's blue (#1d5bd8)
const ISLAND_ACCENT = "#1d5bd8"; // the same blue as the custom property's text; w13 took the island out, so no widget has it of its own any more
const HOLD_MS = 1500; // how long a held /api/assets answer is kept back

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
const modeSelect = (page: Page) => panelOf(page).getByLabel("Mode", { exact: true });
const themeSelect = (page: Page) => panelOf(page).getByLabel("Theme colour", { exact: true });
const tree = (page: Page) => page.getByRole("region", { name: "Asset tree" });
const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const bar = (page: Page) => page.locator(".top-progress");

async function expectLook(page: Page, look: Look): Promise<void> {
  await expect(html(page)).toHaveAttribute("data-mode", look.mode);
  await expect(html(page)).toHaveAttribute("data-theme", look.theme);
}

const isSave = (r: { url(): string; request(): { method(): string } }) => new URL(r.url()).pathname === "/api/me/preferences" && r.request().method() === "PUT";

/** Runs `act` (a choice in the panel) and waits for the PUT it causes; the choice must be a change, or no PUT is sent. */
async function saving(page: Page, act: () => Promise<unknown>): Promise<void> {
  const [response] = await Promise.all([page.waitForResponse(isSave), act()]);
  expect(response.ok(), `saving the look: ${response.status()}`).toBe(true);
}

async function openPanel(page: Page): Promise<void> {
  await userBlock(page).click();
  await expect(panelOf(page)).toBeVisible();
}

async function closePanel(page: Page): Promise<void> {
  if (!(await panelOf(page).isVisible())) return;
  await page.keyboard.press("Escape"); // both selects are closed here, so the page's own Escape handler closes the panel
  await expect(panelOf(page)).toBeHidden();
}

/** Chooses `look` through the two selects (only the ones that change, or no PUT is sent) and leaves the panel closed. */
async function chooseLook(page: Page, look: Look): Promise<void> {
  if (!(await panelOf(page).isVisible())) await openPanel(page);
  if ((await modeSelect(page).inputValue()) !== look.mode) await saving(page, () => modeSelect(page).selectOption(look.mode));
  if ((await themeSelect(page).inputValue()) !== look.theme) await saving(page, () => themeSelect(page).selectOption(look.theme));
  await expectLook(page, look);
  await closePanel(page);
}

/** The colour a token has in the page's current look, as the browser prints a computed colour (rgb(...)). */
function tokenColour(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.documentElement.appendChild(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);
}

/** A custom property of <html> as written, lower-cased. */
function tokenText(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase(), token);
}

/** Two animation frames: whatever the page does about a changed look has happened by then. */
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

const sidewaysOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

// The loading bar, recorded from inside the page so a flash that lasts a few hundred milliseconds cannot be missed between two polls:
// `changes` holds every data-phase the bar took (read in the same task as the change), `samples` the bar every 50 ms.
interface BarSample { phase: string; width: number; opacity: number; bg: string; at: number }
interface BarRecord { changes: BarSample[]; samples: BarSample[] }
type WithBar = Window & { __w7eBar: BarRecord };

/** Starts recording the bar in every document this page loads from now on (call it before the first goto). */
async function watchBar(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record: BarRecord = { changes: [], samples: [] };
    (window as unknown as WithBar).__w7eBar = record;
    const start = performance.now();
    const read = (el: Element): BarSample => {
      const fill = el.firstElementChild;
      const style = fill ? getComputedStyle(fill) : null;
      return {
        phase: el.getAttribute("data-phase") ?? "",
        width: fill ? fill.getBoundingClientRect().width : 0,
        opacity: style ? Number(style.opacity) : 0,
        bg: style ? style.backgroundColor : "",
        at: Math.round(performance.now() - start),
      };
    };
    const seen = new WeakSet<Element>();
    const look = () => {
      const el = document.querySelector(".top-progress");
      if (!el || seen.has(el)) return;
      seen.add(el);
      record.changes.push(read(el));
      new MutationObserver(() => record.changes.push(read(el))).observe(el, { attributes: true, attributeFilter: ["data-phase"] });
    };
    new MutationObserver(look).observe(document, { childList: true, subtree: true });
    setInterval(() => {
      const el = document.querySelector(".top-progress");
      if (el) record.samples.push(read(el));
    }, 50);
  });
}

const barRecord = (page: Page) => page.evaluate(() => (window as unknown as WithBar).__w7eBar);
const clearBarRecord = (page: Page) =>
  page.evaluate(() => {
    const record = (window as unknown as WithBar).__w7eBar;
    record.changes.length = 0;
    record.samples.length = 0;
  });
const lastPhase = async (page: Page) => (await barRecord(page)).changes.at(-1)?.phase;

/** Keeps every /api/assets answer back for HOLD_MS (the tree and the Assets pages wait for it); returns what removes the hold. */
async function holdAssets(page: Page): Promise<() => Promise<void>> {
  const hold = async (route: Route) => {
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    await route.continue().catch(() => undefined); // the page may have gone by now
  };
  await page.route("**/api/assets", hold);
  return () => page.unroute("**/api/assets", hold);
}

/** After a (re)load with the hold on: waits until the bar has run and is idle again, and returns what it recorded. */
async function barAfterLoad(page: Page): Promise<BarRecord> {
  await expect.poll(async () => (await barRecord(page)).changes.some((c) => c.phase === "run"), { message: "the bar ran during the held load", timeout: 15_000 }).toBe(true);
  await expect.poll(() => lastPhase(page), { message: "the bar is idle again after the load", timeout: 15_000 }).toBe("idle");
  return barRecord(page);
}

test.describe.serial("W7e: theme colours, dropdowns, loading bar, icons", () => {
  let panelId = 0;
  let rackId = 0;
  let dashboardId = 0;

  test.beforeAll(async ({ browser }) => {
    await asAdmin(browser, async (request) => {
      const saved = await request.put("/api/me/preferences", { data: DEFAULT_LOOK });
      expect(saved.ok(), `starting from the default look: ${saved.status()} ${await saved.text()}`).toBe(true);

      const assets = (await (await request.get("/api/assets")).json()) as { id: number; parent_id: number | null; name: string }[];
      const root = assets.find((a) => a.name === "Site" && a.parent_id === null) ?? assets.find((a) => a.parent_id === null);
      expect(root, "a root asset to put the test assets under").toBeTruthy();
      const make = async (name: string, kind: string) => {
        const made = await request.post("/api/assets", { data: { name, parent_id: root!.id, kind, sort_order: 0 } });
        expect(made.ok(), `creating ${name}: ${made.status()} ${await made.text()}`).toBe(true);
        return ((await made.json()) as { id: number }).id;
      };
      panelId = await make(PANEL, "Panel");
      rackId = await make(RACK, "Rack");

      // A dashboard with one stat widget, to read the accent inside a widget frame (the frame exists whether or not there is data).
      const mv2 = assets.find((a) => a.name === "MV2") ?? root!;
      const created = await request.post("/api/dashboards", { data: { name: DASHBOARD, range: "24h" } });
      expect(created.ok(), `creating the dashboard: ${created.status()} ${await created.text()}`).toBe(true);
      const dashboard = (await created.json()) as { id: number; updated_at: string };
      dashboardId = dashboard.id;
      const widgets = [
        {
          type: "stat", title: WIDGET, x: 0, y: 0, w: 4, h: 2,
          config: { assets: [mv2.id], source: "metric", metric: "active_power_kw", aggregation: "last", range: null },
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
      for (const id of [panelId, rackId]) if (id) await request.delete(`/api/assets/${id}`);
    });
  });

  test("buttons, links, hover and the selected row take the theme's colour in all four presets, light and dark", async ({ page, browser }) => {
    test.setTimeout(240_000);
    await setAdminLook(browser, DEFAULT_LOOK);
    await signIn(page, ADMIN);
    await page.goto(`/assets/${panelId}`);
    await expect(heading1(page, PANEL)).toBeVisible();

    const add = page.getByRole("button", { name: "Add asset", exact: true });
    const crumb = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Assets Tree", exact: true });
    const row = page.locator(".node.is-selected");

    for (const look of LOOKS) {
      await test.step(`${look.theme}, ${look.mode}`, async () => {
        await chooseLook(page, look);
        const accent = await tokenColour(page, "--accent");
        const hover = await tokenColour(page, "--accent-hover");
        const ink = await tokenColour(page, "--accent-ink");
        if (look.theme !== "graphite" || look.mode !== "light") expect(accent, "no longer the blue every look had before").not.toBe(OLD_BLUE);

        await expect(add, "the page's primary button is the accent").toHaveCSS("background-color", accent);
        await expect(crumb, "a link is the accent").toHaveCSS("color", accent);
        await expect(row, "the open row has no tint, only the bar").toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(row.getByRole("link"), "its name is the ink").toHaveCSS("color", ink);
        await expect.poll(() => row.evaluate((el) => getComputedStyle(el).boxShadow), { message: "its marker is the accent" }).toContain(accent);

        await add.hover();
        await expect(add, "the primary button's hover").toHaveCSS("background-color", hover);
      });
    }
  });

  test("keyboard: an open popup closes alone on Esc, arrows then Esc keep the highlighted option, Enter picks, and the choice survives a reload", async ({ page, browser }) => {
    test.setTimeout(180_000);
    await setAdminLook(browser, DEFAULT_LOOK);
    await signIn(page, ADMIN);
    await page.goto("/assets");
    await expect(heading1(page, "Assets Tree")).toBeVisible();
    const trigger = userBlock(page);
    const popup = () => page.waitForTimeout(250); // the open popup has no DOM to wait for

    await test.step("the panel has two labelled combo boxes", async () => {
      await openPanel(page);
      await expect(panelOf(page).getByRole("combobox")).toHaveCount(2);
      await expect(panelOf(page).getByRole("combobox", { name: "Mode", exact: true })).toBeVisible();
      await expect(panelOf(page).getByRole("combobox", { name: "Theme colour", exact: true })).toBeVisible();
    });

    await test.step("Space opens Mode's popup and Esc closes the popup only; Enter and Esc likewise; the panel and the choice stay", async () => {
      await modeSelect(page).focus();
      await page.keyboard.press("Space");
      await popup();
      await page.keyboard.press("Escape");
      await expect(panelOf(page)).toBeVisible();
      await expect(modeSelect(page)).toBeFocused();
      await page.keyboard.press("Enter");
      await popup();
      await page.keyboard.press("Escape");
      await expect(panelOf(page)).toBeVisible();
      await expect(modeSelect(page)).toBeFocused();
      await expect(modeSelect(page)).toHaveValue("light");
      await expectLook(page, DEFAULT_LOOK);
    });

    await test.step("Esc on the closed select closes the panel and the focus returns to the trigger", async () => {
      await page.keyboard.press("Escape");
      await expect(panelOf(page)).toBeHidden();
      await expect(trigger).toBeFocused();
    });

    await test.step("Space, ArrowDown, Esc keeps the highlighted Dark: the page goes dark, the choice is saved, the panel stays open", async () => {
      await page.keyboard.press("Enter"); // the trigger is focused: open the panel again
      await expect(panelOf(page)).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(modeSelect(page)).toBeFocused();
      await saving(page, async () => {
        await page.keyboard.press("Space");
        await popup();
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(150);
        await page.keyboard.press("Escape");
      });
      await expect(modeSelect(page)).toHaveValue("dark");
      await expectLook(page, { mode: "dark", theme: "navy-gold" });
      await expect(panelOf(page)).toBeVisible();
    });

    await test.step("on Theme colour, Space, ArrowDown, Enter picks Maroon and gold", async () => {
      await page.keyboard.press("Tab");
      await expect(themeSelect(page)).toBeFocused();
      await saving(page, async () => {
        await page.keyboard.press("Space");
        await popup();
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(150);
        await page.keyboard.press("Enter");
      });
      await expect(themeSelect(page)).toHaveValue("maroon-gold");
      await expectLook(page, MAROON_DARK);
      await expect(panelOf(page)).toBeVisible();
    });

    await test.step("the account holds the choice and a reload brings it back", async () => {
      const me = (await (await page.request.get("/api/me")).json()) as { preferences: Look };
      expect(me.preferences).toEqual(MAROON_DARK);
      await page.reload();
      await expectLook(page, MAROON_DARK);
      await openPanel(page);
      await expect(modeSelect(page)).toHaveValue("dark");
      await expect(themeSelect(page)).toHaveValue("maroon-gold");
    });
  });

  test("a refused save puts the dropdown and the page back and says so; the next choice saves", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await setAdminLook(browser, DEFAULT_LOOK);
    await signIn(page, ADMIN);
    await page.goto("/assets");
    await openPanel(page);

    const refuse = (route: Route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "refused" }) })
        : route.fallback();
    await page.route("**/api/me/preferences", refuse);
    const [refused] = await Promise.all([page.waitForResponse(isSave), themeSelect(page).selectOption("maroon-gold")]);
    expect(refused.status()).toBe(500);
    await expect(panelOf(page).getByRole("alert")).toHaveText(/not saved/i);
    await expect(themeSelect(page), "the select shows the confirmed value again").toHaveValue("navy-gold");
    await expectLook(page, DEFAULT_LOOK);
    const me = (await (await page.request.get("/api/me")).json()) as { preferences: Look };
    expect(me.preferences, "the account was not changed").toEqual(DEFAULT_LOOK);

    await page.unroute("**/api/me/preferences", refuse);
    await saving(page, () => themeSelect(page).selectOption("graphite"));
    await expectLook(page, { mode: "light", theme: "graphite" });
    await expect(panelOf(page).getByRole("alert")).toHaveCount(0);
  });

  test("a loading bar in the theme's marker colour runs along the top edge while a page loads, in all four presets, and never blocks a click", async ({ page, browser }) => {
    test.setTimeout(240_000);
    await setAdminLook(browser, DEFAULT_LOOK);
    await watchBar(page);
    await signIn(page, ADMIN);

    await test.step("the / redirect after sign-in leaves the bar idle, not stuck", async () => {
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1_000);
      expect(await lastPhase(page), "the bar has run (it was mounted) and is idle again").toBe("idle");
    });

    await page.goto("/assets");
    await expect(heading1(page, "Assets Tree")).toBeVisible();

    for (const theme of THEMES) {
      await test.step(`${theme}: visible in --side-accent while /api/assets is held, gone after`, async () => {
        const look: Look = { mode: "light", theme };
        await chooseLook(page, look);
        const unhold = await holdAssets(page);
        await page.reload();
        await expectLook(page, look);
        const sideAccent = await tokenColour(page, "--side-accent");

        if (theme === THEMES[0]) {
          await page.waitForFunction(() => document.querySelector(".top-progress")?.getAttribute("data-phase") === "run", undefined, { polling: "raf", timeout: 10_000 });
          const through = await page.evaluate(() => {
            const el = document.querySelector(".top-progress")!;
            return { pointerEvents: getComputedStyle(el).pointerEvents, topmost: document.elementFromPoint(300, 1)?.closest(".top-progress") === null };
          });
          expect(through, "the bar lets the pointer through to the top bar").toEqual({ pointerEvents: "none", topmost: true });
          await userBlock(page).click(); // a click during the load goes through to the page
          await expect(panelOf(page)).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(panelOf(page)).toBeHidden();
        }

        const record = await barAfterLoad(page);
        await unhold();

        const phases = record.changes.map((c) => c.phase);
        expect(phases, "idle, then run, finish, fade, and idle again").toEqual(expect.arrayContaining(["run", "finish", "fade"]));
        expect(phases.find((p) => p !== "idle")).toBe("run");
        const running = record.changes.filter((c) => c.phase === "run");
        for (const entry of running) expect(entry.bg, "the bar is the preset's --side-accent").toBe(sideAccent);
        const width = await page.evaluate(() => document.documentElement.clientWidth);
        const peak = Math.max(...record.samples.filter((s) => s.phase === "run").map((s) => s.width));
        expect(peak, "it sweeps in from the left").toBeGreaterThan(20);
        expect(peak, "and stops short of the end while the load lasts").toBeLessThan(width * 0.86);
        await expect(bar(page)).toHaveAttribute("data-phase", "idle");
        await expect(bar(page).locator("span")).toHaveCSS("opacity", "0");
      });
    }

    await test.step("a change of page shows it for at least 400 ms even when the page is quick", async () => {
      await page.goto("/assets");
      await expect(heading1(page, "Assets Tree")).toBeVisible();
      await expect.poll(() => lastPhase(page), { message: "the first load is over", timeout: 15_000 }).toBe("idle");
      await page.waitForTimeout(500);
      await clearBarRecord(page);
      await navLink(page, "Dashboards").click();
      await expect(page).toHaveURL(/\/dashboards/);
      await expect.poll(async () => (await barRecord(page)).changes.some((c) => c.phase === "finish"), { timeout: 15_000 }).toBe(true);
      const changes = (await barRecord(page)).changes;
      const ranAt = changes.find((c) => c.phase === "run")?.at;
      const finishedAt = changes.find((c) => c.phase === "finish")?.at;
      expect(ranAt, "the bar ran").toBeDefined();
      expect(finishedAt! - ranAt!, "for at least the minimum sweep").toBeGreaterThanOrEqual(380);
    });
  });

  test("with reduced motion the bar is a full line that appears and disappears, with no sweep", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await setAdminLook(browser, DEFAULT_LOOK);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await watchBar(page);
    await signIn(page, ADMIN);
    await page.goto("/assets");
    await expect(heading1(page, "Assets Tree")).toBeVisible();
    await expect.poll(() => lastPhase(page), { timeout: 15_000 }).toBe("idle");

    const unhold = await holdAssets(page);
    await page.reload();
    const record = await barAfterLoad(page);
    await unhold();

    const width = await page.evaluate(() => document.documentElement.clientWidth);
    const running = record.samples.filter((s) => s.phase === "run");
    expect(running.length, "sampled while it ran").toBeGreaterThanOrEqual(3);
    for (const sample of record.samples) expect(Math.abs(sample.width - width), `the line is the viewport wide in the ${sample.phase} phase`).toBeLessThanOrEqual(1);
    for (const sample of running) expect(sample.opacity).toBe(1);
    for (const sample of record.samples.filter((s) => s.phase === "idle")) expect(sample.opacity).toBe(0);
  });

  test("polling never shows the loading bar", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await setAdminLook(browser, DEFAULT_LOOK);
    await watchBar(page);
    await signIn(page, ADMIN);
    await page.goto("/assets");
    await expect(heading1(page, "Assets Tree")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect.poll(() => lastPhase(page), { message: "the first load is over", timeout: 15_000 }).toBe("idle");
    await page.waitForTimeout(1_500);
    expect(await lastPhase(page)).toBe("idle");

    // The fleet summary refetches every 15 s and the status chip every 10 s; the window is longer than the first.
    const polled: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/fleet/summary" || path === "/api/status") polled.push(path);
    });
    await clearBarRecord(page);
    await page.waitForTimeout(18_000);

    expect(polled, "the page polled while the bar was watched").toContain("/api/fleet/summary");
    const record = await barRecord(page);
    expect(record.samples.length, "the bar was sampled").toBeGreaterThan(100);
    expect(record.samples.filter((s) => s.phase !== "idle"), "no sample outside idle").toEqual([]);
    expect(record.changes.filter((c) => c.phase !== "idle"), "no phase but idle").toEqual([]);
  });

  test("the tree and the asset header carry a kind icon: one per row, and a Panel differs from a Rack", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, ADMIN);
    await page.goto(`/assets/${panelId}`);
    await expect(heading1(page, PANEL)).toBeVisible();
    await expect(tree(page).locator(".node").first()).toBeVisible();

    const counts = await tree(page).evaluate((el) => {
      const nodes = Array.from(el.querySelectorAll(".node"));
      return { nodes: nodes.length, withOneIcon: nodes.filter((n) => n.querySelectorAll(".node-icon svg").length === 1).length };
    });
    expect(counts.nodes, "the tree has rows").toBeGreaterThan(2);
    expect(counts.withOneIcon, "every row holds exactly one icon").toBe(counts.nodes);

    const iconOf = (name: string) =>
      tree(page).locator(".node").filter({ has: page.getByRole("link", { name, exact: true }) }).locator(".node-icon svg");
    await expect(iconOf(PANEL)).toHaveCount(1);
    await expect(iconOf(RACK)).toHaveCount(1);
    const panelIcon = await iconOf(PANEL).innerHTML();
    const rackIcon = await iconOf(RACK).innerHTML();
    expect(panelIcon, "a Panel and a Rack have different icons").not.toBe(rackIcon);

    // The header: the h1 sits in .page-title next to a tile that holds the same icon as the tree row.
    const title = page.locator(".page-title");
    await expect(title.getByRole("heading", { level: 1, name: PANEL, exact: true })).toBeVisible();
    await expect(title.locator(".page-tile svg")).toHaveCount(1);
    expect(await title.locator(".page-tile svg").innerHTML(), "the header shows the row's icon").toBe(panelIcon);
  });

  test("the widget's accent is the look's accent in all eight looks (w13 took the fixed blue island out)", async ({ page, browser }) => {
    test.setTimeout(240_000);
    await setAdminLook(browser, DEFAULT_LOOK);
    await signIn(page, ADMIN);
    await page.goto(`/dashboards/${dashboardId}`);
    const frame = page.getByRole("region", { name: WIDGET, exact: true });
    await expect(frame).toBeVisible();

    for (const look of LOOKS) {
      await test.step(`${look.theme}, ${look.mode}`, async () => {
        await chooseLook(page, look);
        const inside = await frame.evaluate((el) => getComputedStyle(el).getPropertyValue("--accent").trim().toLowerCase());
        const outside = await tokenText(page, "--accent");
        expect(inside, `inside the widget frame the accent is the look's own (${outside}), not a fixed one`).toBe(outside);
        if (look.theme !== "graphite" || look.mode !== "light") expect(inside, "and it is no longer the island's blue").not.toBe(ISLAND_ACCENT);
      });
    }
  });

  test("no page scrolls sideways at 1024 px in any of the eight looks", async ({ page, browser }) => {
    test.setTimeout(300_000);
    await setAdminLook(browser, DEFAULT_LOOK);
    await signIn(page, ADMIN);
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024);

    const pages: [string, string][] = [
      [`/assets/${panelId}`, PANEL], // the long name next to the header tile
      ["/assets", "Assets Tree"],
    ];
    for (const [path, name] of pages) {
      await page.goto(path);
      await expect(heading1(page, name)).toBeVisible();
      for (const look of LOOKS) {
        await test.step(`${name === "Assets Tree" ? "the fleet summary" : "the asset page"}, ${look.theme}, ${look.mode}`, async () => {
          await chooseLook(page, look);
          await settled(page);
          await expect.poll(() => sidewaysOverflow(page), { message: "the sideways overflow in pixels" }).toBeLessThanOrEqual(0);
        });
      }
    }
  });
});
