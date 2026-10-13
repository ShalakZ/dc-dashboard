import { expect, test, type Browser, type Page, type Route } from "@playwright/test";
import { mainNav, navLink } from "./shell";

// W7i (polish after the W7e to W7h waves). Part D2, "Can't reach the server": what a visitor sees when the API is not there. The scratch stack's
// Caddy answers 502 when the api container is stopped; here the answer is made up with `page.route`, which is the same thing to the page and needs
// no container action. State this spec relies on (left by the earlier projects): admin `admin` / `correct-horse`. The first describe creates and
// changes nothing.
//
// What is checked: a page opened while `/api/me` is answered 502 shows a "Can't reach the server" panel at the SAME address (no redirect to the
// sign-in page, nothing remembered for after it) and opens the page when the answer is back and Retry now is pressed; a page already open whose
// requests all get 502 shows the notice in the shell and loses it when the answers are back; and a lost session still ends on the sign-in page.
//
// F2, a very long asset kind: the second describe makes two assets of its own (a run prefix in their names, a 200-character kind without a
// space for one) through the API and deletes everything with the prefix in afterAll; it measures the Assets Tree and an asset's page.

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse" };
const RETURN_KEY = "dcdash.returnTo"; // where a lost session sends the visitor back to after signing in again

/** What Caddy answers for an API that is not there. */
const badGateway = (route: Route) => route.fulfill({ status: 502, contentType: "text/plain", body: "502 Bad Gateway" });
/** Every API request except the live stream (an EventSource that is not answered is not what is being tested). */
const isApi = (url: URL) => url.pathname.startsWith("/api/") && url.pathname !== "/api/stream";

/** Runs `use` on a page of a fresh browser context (so a route, a cookie or a remembered state never leaks), signed in as the admin. */
async function withPage<T>(browser: Browser, use: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    const login = await page.request.post("/api/login", { data: ADMIN });
    expect(login.ok(), `signing in: ${login.status()}`).toBe(true);
    return await use(page);
  } finally {
    await context.close();
  }
}

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
/** The shell's notice (role status), told apart from the loading bar and other status regions by its text. */
const notice = (page: Page) => page.getByRole("status").filter({ hasText: "Can't reach the server" });

test.describe("the server cannot be reached (D2)", () => {
  test("a visit while /api/me gets 502 shows the panel at the same address, remembers nothing, and opens the page after Retry now", async ({ browser }) => {
    await withPage(browser, async (page) => {
      await page.route("**/api/me", badGateway);
      await page.goto("/sources");
      await expect(heading1(page, "Can't reach the server")).toBeVisible();
      await expect(page).toHaveURL(/\/sources$/);
      await expect(heading1(page, "Sign in")).toHaveCount(0);
      expect(await page.evaluate((key: string) => sessionStorage.getItem(key), RETURN_KEY), "no page is remembered for the sign-in").toBeNull();

      await page.unroute("**/api/me");
      await page.getByRole("button", { name: "Retry now", exact: true }).click();
      await expect(heading1(page, "Sources")).toBeVisible({ timeout: 20_000 }); // a scheduled retry already out is answered 502 and the press is ignored; the next retry is 6 s later
      await expect(page).toHaveURL(/\/sources$/);
      await expect(heading1(page, "Can't reach the server")).toHaveCount(0);
    });
  });

  test("a page that is open when every API request gets 502 shows the notice in the shell, and loses it when the answers are back", async ({ browser }) => {
    await withPage(browser, async (page) => {
      await page.goto("/sources");
      await expect(heading1(page, "Sources")).toBeVisible();
      await expect(notice(page)).toHaveCount(0);

      await page.route(isApi, badGateway);
      await navLink(page, "Users & Roles").click(); // new requests: the sources page's own poll could be ten seconds away
      await expect(notice(page)).toBeVisible({ timeout: 30_000 });
      await expect(notice(page).getByRole("button", { name: "Retry now", exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/users$/); // still the same page, not the sign-in page

      await page.unroute(isApi, badGateway);
      await notice(page).getByRole("button", { name: "Retry now", exact: true }).click();
      await expect(notice(page)).toHaveCount(0, { timeout: 30_000 });
      await expect(heading1(page, "Users & Roles")).toBeVisible();
    });
  });

  test("a lost session still ends on the sign-in page: it is not mistaken for an unreachable server", async ({ browser }) => {
    await withPage(browser, async (page) => {
      await page.goto("/sources");
      await expect(heading1(page, "Sources")).toBeVisible();
      await page.context().clearCookies();
      await navLink(page, "Users & Roles").click();
      await expect(heading1(page, "Sign in")).toBeVisible();
      await expect(page.getByText("Can't reach the server")).toHaveCount(0);
    });
  });
});

const RUN = Date.now().toString(36);
const PREFIX = `W7i ${RUN}`;
const LONG_KIND = "K".repeat(200); // the API allows it; a kind is free text from the Add asset dialog

/** How far the page is wider than the window, in pixels (0 or less is fine: nothing scrolls sideways). */
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("a very long asset kind (F2)", () => {
  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      const login = await context.request.post("/api/login", { data: ADMIN });
      expect(login.ok(), "the admin signs in").toBe(true);
      const assets = (await (await context.request.get("/api/assets")).json()) as { id: number; name: string }[];
      for (const asset of assets.filter((a) => a.name.startsWith(PREFIX))) {
        const removed = await context.request.delete(`/api/assets/${asset.id}?confirm=true`);
        expect(removed.ok(), `deleting ${asset.name}: ${removed.status()}`).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  test("a 200-character kind wraps: the Assets Tree and the asset's page are no wider than the window at 1440 and 1024, and the sub line stays clear of the buttons", async ({ browser }) => {
    await withPage(browser, async (page) => {
      const make = async (name: string, kind: string) => {
        const created = await page.request.post("/api/assets", { data: { name, parent_id: null, kind, sort_order: 0 } });
        expect(created.ok(), `creating ${name}: ${created.status()}`).toBe(true);
        return ((await created.json()) as { id: number }).id;
      };
      const longName = `${PREFIX} long kind`;
      const normalName = `${PREFIX} normal kind`;
      const longId = await make(longName, LONG_KIND);
      const normalId = await make(normalName, "generic");

      for (const width of [1440, 1024]) {
        await page.setViewportSize({ width, height: 900 });

        // The fleet summary: the long kind is a row of the "By kind" list, its glyph keeps its 16 px, and the page does not scroll sideways.
        await page.goto("/assets");
        await expect(heading1(page, "Assets Tree")).toBeVisible();
        const kind = page.locator(".kind-list li").filter({ hasText: LONG_KIND });
        await expect(kind, `the long kind is listed at ${width}`).toBeVisible();
        const glyph = await kind.locator("svg.i").first().boundingBox();
        expect(glyph?.width, "the glyph keeps 16 px beside a wrapping name").toBeCloseTo(16, 0);
        await expect.poll(() => overflowX(page), { message: `/assets at ${width}` }).toBeLessThanOrEqual(0);

        // An asset's page: the sub line (kind and number of sub-assets) wraps in its column, left of the Edit and Add asset buttons.
        for (const [id, name] of [[longId, longName], [normalId, normalName]] as const) {
          await page.goto(`/assets/${id}`);
          await expect(heading1(page, name)).toBeVisible();
          const sub = page.locator(".page-head .sub");
          await expect(sub).toBeVisible();
          await expect.poll(() => overflowX(page), { message: `/assets/${id} at ${width}` }).toBeLessThanOrEqual(0);
          const [subBox, actionsBox] = [await sub.boundingBox(), await page.locator(".page-head > .actions").boundingBox()];
          expect(subBox && actionsBox, "the sub line and the buttons are laid out").toBeTruthy();
          expect(subBox!.x + subBox!.width, `the sub line ends before the buttons at ${width}`).toBeLessThanOrEqual(actionsBox!.x);
          const spill = await sub.evaluate((el) => el.scrollWidth - el.clientWidth);
          expect(spill, "no text runs past the sub line's own box").toBeLessThanOrEqual(0);
        }
      }
    });
  });
});

test.describe("keyboard users and a big tree (K1)", () => {
  test("Skip the tree is the first stop in the tree column, and Enter on it puts the focus on the asset pane", async ({ browser }) => {
    await withPage(browser, async (page) => {
      await page.goto("/assets");
      await expect(heading1(page, "Assets Tree")).toBeVisible();
      const skip = page.getByRole("region", { name: "Asset tree" }).getByRole("link", { name: "Skip the tree", exact: true });
      await expect(skip).toBeAttached();
      // From the last stop of the sidebar, Tab: a shell notice is the only thing that may sit between it and the tree column.
      await mainNav(page).locator(".side-toggle").focus();
      for (let presses = 0; presses < 4 && !(await skip.evaluate((el) => el === document.activeElement)); presses++) await page.keyboard.press("Tab");
      await expect(skip, "the link is the first tab stop of the tree column").toBeFocused();
      await expect(skip, "visible while it has the focus").toBeVisible();
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => document.activeElement?.id), "the asset pane has the focus").toBe("asset-detail");
      await expect(page).toHaveURL(/\/assets$/); // no hash was added
    });
  });
});
