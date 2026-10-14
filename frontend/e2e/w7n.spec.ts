import { expect, test, type Browser, type Locator, type Page, type Route } from "@playwright/test";
import { userBlock } from "./shell";

// W7n (the owner's gold M as the logo and the favicon) on the state the earlier projects leave behind: admin `admin` / `correct-horse`.
// Nothing is created and nothing is changed: a look is only ever put on <html> inside one page (never saved on the account), and a test that
// needs a session signs in through the API in its own browser context. The sign-in page is looked at signed out (test 4) and walked through in test 6.
//
// What is checked. (1) The server: the HTML links the three icons and every linked file (and the logo) answers as an image, not as the
// app's HTML (Caddy's SPA fallback would answer an absent file with 200 text/html). (2) The bar's mark is the owner's gold in all eight
// looks: the pixel is read from a screenshot of the <img> (what the browser really paints, so a theme's filter, opacity or blend would
// show), not from a canvas `drawImage` of it, which ignores CSS. (3) The minimized rail keeps the mark. (4) The sign-in page has it.
// (5) The static copy of the shell in index.html draws the mark where the real bar later does. (6) No request for an icon fails and
// the console never names one. (7) With the logo blocked the bar keeps its geometry.
//
// Test 6 does NOT assert "no console error": /login and / always make one 401 on /api/me before sign-in, and Chromium logs "Failed to load
// resource ... 401" for it. The rule is narrower on purpose: no response of 400 or more for an icon or logo URL, and no console message (of any
// type, text or source URL) that names `logo-mark`, `favicon`, `apple-touch` or `preload` (an unused preload link logs a warning that names
// the file).
//
// The static copy is looked at the way w7h does: only the app's module script (`**/assets/index-*.js`) is held with `page.route`, never
// the stylesheet (the copy is `hidden` until app.css shows it) and never `/assets/*` as a whole.

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse" };
const GOLD = [210, 158, 18]; // #D29E12, the owner's square
const APP_SCRIPT = "**/assets/index-*.js";
const NEAR = 0.5; // px: how far two boxes may differ
const MODES = ["light", "dark"] as const;
const THEMES = ["navy-gold", "maroon-gold", "graphite", "desert-gold"] as const;
const DESERT_EDGE = "rgb(110, 87, 0)"; // --top-brand-edge of desert-gold (#6e5700), the one bar that is the mark's own gold
const ICON_URLS = ["/logo-mark.svg", "/favicon.svg", "/favicon.ico", "/apple-touch-icon.png"];
const NAMES_AN_ICON = /logo-mark|favicon|apple-touch|preload/i;

interface Box { x: number; y: number; width: number; height: number }

async function signIn(page: Page): Promise<void> {
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in: ${login.status()}`).toBe(true);
}

/** Signs in through the API on the page and opens `/`, with the real shell standing. */
async function openHome(page: Page): Promise<void> {
  await signIn(page);
  await page.goto("/");
  await expect(userBlock(page)).toContainText(ADMIN.username);
  await expect(page.locator(".sk-shell")).toHaveCount(0);
}

/** The bar's mark in the real shell (the static copy and the skeleton are `.sk-shell`, and carry the same markup). */
const barMark = (page: Page) => page.locator(".shell:not(.sk-shell) .navbar .brand img.brand-mark");
const barName = (page: Page) => page.locator(".shell:not(.sk-shell) .navbar .brand .lbl");

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, "the element has a box on screen").not.toBeNull();
  return box!;
}

function expectSize(box: Box, width: number, height: number, what: string): void {
  expect(Math.abs(box.width - width), `${what}: width ${box.width} against ${width}`).toBeLessThanOrEqual(NEAR);
  expect(Math.abs(box.height - height), `${what}: height ${box.height} against ${height}`).toBeLessThanOrEqual(NEAR);
}

function expectNear(actual: Box, expected: Box, what: string): void {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(actual[key] - expected[key]), `${what}: ${key} ${actual[key]} against ${expected[key]}`).toBeLessThanOrEqual(NEAR);
  }
}

/** The image has been decoded (a file that did not load, or an empty one, has no natural width). */
const decoded = (img: Locator) => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0);

/** Two animation frames: whatever the page does about a changed look has happened by then. */
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/**
 * The [r, g, b, a] the browser really draws at (x, y) of the element's box. A screenshot of the element is what is on screen (a CSS
 * filter, opacity or blend mode on it or above it is in it), decoded in the page with createImageBitmap (no network, so no content
 * security policy is involved).
 */
async function drawnPixel(locator: Locator, x: number, y: number): Promise<number[]> {
  const png = (await locator.screenshot()).toString("base64");
  return locator.page().evaluate(
    async ([data, px, py]: [string, number, number]) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(bitmap, 0, 0);
      return Array.from(context.getImageData(px, py, 1, 1).data);
    },
    [png, x, y],
  );
}

interface MarkState {
  mode: string | null;
  theme: string | null;
  filter: string;
  opacity: string;
  blend: string;
  outlineColor: string;
  outlineStyle: string;
  outlineWidth: string;
  barColour: string;
}

/** The look on <html> and what the mark and the bar compute to, in one read. */
const markState = (mark: Locator): Promise<MarkState> =>
  mark.evaluate((el) => {
    const style = getComputedStyle(el);
    const root = document.documentElement;
    return {
      mode: root.getAttribute("data-mode"),
      theme: root.getAttribute("data-theme"),
      filter: style.filter,
      opacity: style.opacity,
      blend: style.mixBlendMode,
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      barColour: getComputedStyle(document.querySelector(".shell:not(.sk-shell) .navbar")!).backgroundColor,
    };
  });

/** Keeps the app's script back until `release()`: the static copy in index.html is then the only shell on the page. */
async function holdScript(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(APP_SCRIPT, async (route: Route) => {
    await gate;
    await route.continue().catch(() => undefined); // the page may be gone by now
  });
  return { release };
}

/** The first stylesheet has been applied: before that the UA's `[hidden]` alone hides the static copy, which would make a "visible" check mean nothing. */
const sheetLoaded = (page: Page) =>
  page.waitForFunction(() => !!document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')?.sheet);

/** The attributes of every `<link>` in an HTML text, names in lower case. */
function linkTags(html: string): Record<string, string>[] {
  return [...html.matchAll(/<link\b[^>]*>/gi)].map((tag) =>
    Object.fromEntries([...tag[0].matchAll(/([a-z-]+)="([^"]*)"/gi)].map((attribute) => [attribute[1].toLowerCase(), attribute[2]])),
  );
}

/** A fresh browser context (so a cache or a block never leaks) with the admin signed in, on one page. */
async function signedInPage(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await signIn(page);
  return { page, close: () => context.close() };
}

/**
 * The bar's mark box and the name's x on a fresh load of `/`, in a context of its own (so no cache stands in for a blocked file), with the
 * logo's request aborted or not. "Name" is `.brand .lbl`, not `.brand` itself, whose box is `--side-w` wide whatever the mark does.
 */
async function barGeometry(browser: Browser, blockLogo: boolean) {
  const { page, close } = await signedInPage(browser);
  try {
    if (blockLogo) await page.route("**/logo-mark.svg", (route) => route.abort());
    await page.goto("/");
    await expect(userBlock(page)).toContainText(ADMIN.username);
    await expect(page.locator(".sk-shell")).toHaveCount(0);
    await expect(barName(page)).toHaveText("DC Dashboard");
    await expect(barName(page)).toBeVisible();
    // An aborted request ends as a failed load (complete, no natural width); an open one as a decoded image.
    await expect.poll(() => barMark(page).evaluate((el) => (el as HTMLImageElement).complete), { message: "the logo request has ended" }).toBe(true);
    await settled(page);
    return { mark: await boxOf(barMark(page)), nameX: (await boxOf(barName(page))).x, drawn: await decoded(barMark(page)) };
  } finally {
    await close();
  }
}

test.describe("W7n: the brand mark and the icons", () => {
  test("(1) the HTML links the three icons, and every icon and the logo is served as an image", async ({ request }) => {
    for (const path of ["/", "/login"]) {
      const response = await request.get(path);
      expect(response.ok(), path).toBe(true);
      const links = linkTags(await response.text());
      expect(links.filter((l) => l.rel === "preload"), `${path}: no preload link`).toEqual([]);
      const icons = links.filter((l) => l.rel === "icon");
      expect(icons.map((l) => l.href), `${path}: the ICO first, then the SVG (what makes Chromium prefer the SVG)`).toEqual(["/favicon.ico", "/favicon.svg"]);
      expect(icons[0].sizes, `${path}: the ICO says 48x48`).toBe("48x48");
      expect(icons[1].type, `${path}: the SVG's type`).toBe("image/svg+xml");
      expect(icons[1].sizes, `${path}: the SVG says any`).toBe("any");
      expect(links.filter((l) => l.rel === "apple-touch-icon").map((l) => l.href), `${path}: the touch icon`).toEqual(["/apple-touch-icon.png"]);
    }

    for (const path of ICON_URLS) {
      const response = await request.get(path);
      expect(response.status(), `${path}: status`).toBe(200);
      const type = response.headers()["content-type"] ?? "";
      expect(type, `${path}: an image type, never the app's text/html (got ${type})`).toMatch(/^image\//);
      const cache = response.headers()["cache-control"] ?? "";
      expect(cache, `${path}: Cache-Control (${cache}) must not be immutable, a swapped logo has to show`).not.toContain("immutable");
      const body = await response.body();
      expect(body.length, `${path}: a non-empty body`).toBeGreaterThan(0);
      const head = [...body.subarray(0, 4)];
      if (path === "/favicon.ico") expect(head, "the ICO starts 00 00 01 00").toEqual([0, 0, 1, 0]);
      if (path === "/apple-touch-icon.png") expect(head, "the PNG signature").toEqual([0x89, 0x50, 0x4e, 0x47]);
      if (path.endsWith(".svg")) {
        const text = body.toString("utf8");
        expect(text, `${path}: an SVG document`).toContain("<svg");
        expect(text, `${path}: the white wordmark is not in it`).not.toMatch(/#ffffff/i);
      }
    }
  });

  test("(2) the bar's mark is the owner's gold in every one of the eight looks, with no theme touching it", async ({ page }) => {
    test.setTimeout(180_000);
    await openHome(page);
    const mark = barMark(page);
    await expect(mark).toBeVisible();
    await expect.poll(() => decoded(mark), { message: "the logo loaded and decoded" }).toBe(true);
    expectSize(await boxOf(mark), 29, 28, "the mark's box");

    for (const mode of MODES) {
      for (const theme of THEMES) {
        await test.step(`${mode}, ${theme}`, async () => {
          // Attributes on <html> are all a look is to CSS (themes.css), and nothing in the page rewrites them without a change of the account's look.
          await page.evaluate(([m, t]: string[]) => {
            document.documentElement.setAttribute("data-mode", m);
            document.documentElement.setAttribute("data-theme", t);
          }, [mode, theme]);
          await settled(page);
          const state = await markState(mark);
          expect([state.mode, state.theme], "the look is on <html>").toEqual([mode, theme]);
          expect(state.filter, "no filter on the mark").toBe("none");
          expect(state.opacity, "the mark is opaque").toBe("1");
          expect(state.blend, "no blend mode on the mark").toBe("normal");

          // (2, 2) is inside the square and clear of the M, which starts about 3.6 px in.
          const pixel = await drawnPixel(mark, 2, 2);
          GOLD.forEach((channel, i) => {
            expect(Math.abs(pixel[i] - channel), `${mode}, ${theme}: channel ${i} of the pixel at (2, 2) is ${pixel.join(",")}, the gold is ${GOLD.join(",")}`).toBeLessThanOrEqual(2);
          });
          expect(pixel[3], `${mode}, ${theme}: the pixel is opaque`).toBe(255);

          // The keyline is invisible (the bar's own colour) on three bars and shows only on desert-gold, whose bar is the mark's gold.
          expect([state.outlineStyle, state.outlineWidth], `${mode}, ${theme}: a 1 px solid outline`).toEqual(["solid", "1px"]);
          if (theme === "desert-gold") {
            expect(state.outlineColor, `${mode}, ${theme}: the keyline`).toBe(DESERT_EDGE);
            expect(state.barColour, `${mode}, ${theme}: the keyline differs from the bar`).not.toBe(DESERT_EDGE);
          } else {
            expect(state.outlineColor, `${mode}, ${theme}: the keyline is the bar's own colour`).toBe(state.barColour);
          }

          const after = await markState(mark);
          expect([after.mode, after.theme], `${mode}, ${theme}: the look held while it was measured`).toEqual([mode, theme]);
        });
      }
    }
  });

  test("(3) the minimized rail still shows the mark and still has the name", async ({ page }) => {
    await openHome(page);
    const mark = barMark(page);
    await expect(mark).toBeVisible();
    await page.locator(".side-toggle").click();
    await expect(page.locator(".shell:not(.sk-shell)")).toHaveAttribute("data-sidebar", "minimized");
    await settled(page);
    await expect(mark).toBeVisible();
    expectSize(await boxOf(mark), 29, 28, "the mark's box in the rail");
    expect(await decoded(mark), "the logo is drawn in the rail").toBe(true);
    // The name is clipped to 1 px, not removed: a screen reader still reads it, once.
    await expect(page.locator(".navbar .brand").getByText("DC Dashboard")).toHaveCount(1);
    await expect(barName(page)).toHaveText("DC Dashboard");
  });

  test("(4) the sign-in page shows the mark beside the name", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1, name: "Sign in", exact: true })).toBeVisible();
    const mark = page.locator(".auth-brand img");
    await expect(mark).toBeVisible();
    await expect.poll(() => decoded(mark), { message: "the logo loaded and decoded" }).toBe(true);
    expectSize(await boxOf(mark), 58, 56, "the sign-in mark's box");
    await expect(page.locator(".auth-brand")).toContainText("DC Dashboard");
  });

  test("(5) the static copy of the shell draws the mark where the real bar does", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const script = await holdScript(page);
    await page.goto("/assets", { waitUntil: "commit" }); // DOMContentLoaded would wait for the held module
    await sheetLoaded(page);
    const copy = page.locator(".sk-shell[hidden] .brand img");
    await expect(copy, "the static copy's mark shows although its shell has the hidden attribute").toBeVisible();
    await expect(page.locator(".sk-shell:not([hidden])"), "React has not run").toHaveCount(0);
    await expect.poll(() => decoded(copy), { message: "the static copy's logo loaded and decoded" }).toBe(true);
    const painted = await boxOf(copy);
    expectSize(painted, 29, 28, "the static copy's mark");

    script.release();
    await expect(userBlock(page)).toContainText(ADMIN.username);
    await expect(page.locator(".sk-shell")).toHaveCount(0);
    await settled(page);
    expectNear(await boxOf(barMark(page)), painted, "the real bar's mark against the static copy's");
  });

  test("(6) no request for an icon fails and the console never names one", async ({ page }) => {
    const seen: { path: string; status: number }[] = [];
    const naming: string[] = [];
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (ICON_URLS.includes(path)) seen.push({ path, status: response.status() });
    });
    page.on("console", (message) => {
      const text = `${message.text()} ${message.location().url}`;
      if (NAMES_AN_ICON.test(text)) naming.push(`${message.type()}: ${text}`);
    });

    await page.goto("/login");
    await expect(page.locator(".auth-brand img")).toBeVisible();
    await page.getByLabel("Username").fill(ADMIN.username);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(userBlock(page)).toContainText(ADMIN.username);
    await page.goto("/"); // the home page again, from the server: the static copy first, then the real shell
    await expect(userBlock(page)).toContainText(ADMIN.username);
    await expect(barMark(page)).toBeVisible();

    expect(seen.filter((s) => s.path === "/logo-mark.svg").length, "the logo was requested (the rule below is not about nothing)").toBeGreaterThan(0);
    expect(seen.filter((s) => s.status >= 400), "no icon or logo request answered 400 or more").toEqual([]);
    expect(naming, "no console message names an icon, the logo or a preload").toEqual([]);
  });

  test("(7) with the logo blocked the bar keeps its geometry and the name", async ({ browser }) => {
    test.setTimeout(120_000);
    const open = await barGeometry(browser, false);
    expect(open.drawn, "control: the logo is drawn when it is not blocked").toBe(true);
    const shut = await barGeometry(browser, true);
    expect(shut.drawn, "the logo really is blocked").toBe(false);
    expectSize(shut.mark, 29, 28, "the blocked mark's box");
    expectNear(shut.mark, open.mark, "the blocked mark's box against the loaded one");
    expect(Math.abs(shut.nameX - open.nameX), `the name's x: ${shut.nameX} blocked against ${open.nameX}`).toBeLessThanOrEqual(NEAR);
  });
});
