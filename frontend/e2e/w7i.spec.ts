import { expect, test, type Browser, type Page, type Route } from "@playwright/test";
import { navLink } from "./shell";

// W7i (polish after the W7e to W7h waves). Part D2, "Can't reach the server": what a visitor sees when the API is not there. The scratch stack's
// Caddy answers 502 when the api container is stopped; here the answer is made up with `page.route`, which is the same thing to the page and needs
// no container action. State this spec relies on (left by the earlier projects): admin `admin` / `correct-horse`. Nothing is created or changed.
//
// What is checked: a page opened while `/api/me` is answered 502 shows a "Can't reach the server" panel at the SAME address (no redirect to the
// sign-in page, nothing remembered for after it) and opens the page when the answer is back and Retry now is pressed; a page already open whose
// requests all get 502 shows the notice in the shell and loses it when the answers are back; and a lost session still ends on the sign-in page.

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
      await expect(heading1(page, "Sources")).toBeVisible();
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
      await navLink(page, "Users").click(); // new requests: the sources page's own poll could be ten seconds away
      await expect(notice(page)).toBeVisible({ timeout: 30_000 });
      await expect(notice(page).getByRole("button", { name: "Retry now", exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/users$/); // still the same page, not the sign-in page

      await page.unroute(isApi, badGateway);
      await notice(page).getByRole("button", { name: "Retry now", exact: true }).click();
      await expect(notice(page)).toHaveCount(0, { timeout: 30_000 });
      await expect(heading1(page, "Users")).toBeVisible();
    });
  });

  test("a lost session still ends on the sign-in page: it is not mistaken for an unreachable server", async ({ browser }) => {
    await withPage(browser, async (page) => {
      await page.goto("/sources");
      await expect(heading1(page, "Sources")).toBeVisible();
      await page.context().clearCookies();
      await navLink(page, "Users").click();
      await expect(heading1(page, "Sign in")).toBeVisible();
      await expect(page.getByText("Can't reach the server")).toHaveCount(0);
    });
  });
});
