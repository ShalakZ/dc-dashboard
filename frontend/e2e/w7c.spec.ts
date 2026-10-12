import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { roleLabel } from "./roles";
import { expectNoRowAction, navLink, rowAction, signOut, userBlock } from "./shell";

// W7c (the default dashboard and the Billing year/month picker) on the state the earlier projects leave behind: admin `admin` /
// `correct-horse` and the metered assets the collector has been polling. The spec makes its own two dashboards (with a run suffix, so a
// second run on the same stack does not collide), an operator and a viewer through the API, and removes them again; whatever happens,
// afterAll puts the default back to "none", which is what the later runs and the gallery expect.
//
// Locators: the sidebar's Dashboards link goes through `navLink`, the crumb through the Breadcrumb landmark (both have the name
// "Dashboards"). A dashboard row is found by its name LINK, not by its name cell: with the Default badge beside the link, the cell's
// own name is "<name> Default". The badge text is looked up inside one row, never page-wide ("Make default" and Tariffs' "Site default
// rates" contain the word). The Year and Month selects are matched with `exact: true`.

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse", role: "admin" };
const OPERATOR = { username: "w7c-operator", password: "w7c-operator-pass", role: "operator" };
const VIEWER = { username: "w7c-viewer", password: "w7c-viewer-pass", role: "viewer" };
type Account = typeof ADMIN;

const RUN = Date.now().toString(36);
const MAIN = `W7c main ${RUN}`;
const OTHER = `W7c other ${RUN}`;

async function signIn(page: Page, who: Account) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(who.username);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(userBlock(page)).toContainText(who.username);
  await expect(userBlock(page)).toContainText(roleLabel(who.role));
}

async function getJson<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.ok(), path).toBe(true);
  return (await response.json()) as T;
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

/** Runs `use` with a page of a fresh browser context in which `who` is signed in. */
async function asUser(browser: Browser, who: Account, use: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1600, height: 1000 } });
  try {
    const page = await context.newPage();
    await signIn(page, who);
    await use(page);
  } finally {
    await context.close();
  }
}

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const dashRow = (page: Page, name: string) => page.getByRole("row").filter({ has: page.getByRole("link", { name, exact: true }) });
const badge = (page: Page, name: string) => dashRow(page, name).getByText("Default", { exact: true });
const onPath = (path: string) => new RegExp(`${path.replace(/\//g, "\\/")}$`);

test.describe("W7c: the default dashboard", () => {
  let main = 0;
  let other = 0;

  test.beforeAll(async ({ browser }) => {
    await asAdmin(browser, async (request) => {
      // A clean start: no default, and no account left over from an earlier run that stopped half way.
      const cleared = await request.put("/api/dashboards/default", { data: { dashboard_id: null } });
      expect(cleared.ok(), `clearing the default: ${cleared.status()} ${await cleared.text()}`).toBe(true);
      const users = (await (await request.get("/api/users")).json()) as { id: number; username: string }[];
      for (const old of users.filter((u) => u.username === OPERATOR.username || u.username === VIEWER.username)) {
        await request.delete(`/api/users/${old.id}`);
      }
      for (const who of [OPERATOR, VIEWER]) {
        const made = await request.post("/api/users", { data: { username: who.username, password: who.password, role: who.role } });
        expect(made.ok(), `creating ${who.username}: ${made.status()} ${await made.text()}`).toBe(true);
      }
      const ids: number[] = [];
      for (const name of [MAIN, OTHER]) {
        const made = await request.post("/api/dashboards", { data: { name, range: "24h" } });
        expect(made.ok(), `creating ${name}: ${made.status()} ${await made.text()}`).toBe(true);
        ids.push(((await made.json()) as { id: number }).id);
      }
      [main, other] = ids;
    });
  });

  test.afterAll(async ({ browser }) => {
    await asAdmin(browser, async (request) => {
      await request.put("/api/dashboards/default", { data: { dashboard_id: null } });
      for (const id of [main, other]) if (id) await request.delete(`/api/dashboards/${id}`); // the second one is gone already when the test got that far
      const users = (await (await request.get("/api/users")).json()) as { id: number; username: string }[];
      for (const mine of users.filter((u) => u.username === OPERATOR.username || u.username === VIEWER.username)) {
        await request.delete(`/api/users/${mine.id}`);
      }
    });
  });

  test("an administrator marks a dashboard as the default, and the sidebar, / and sign-in follow it", async ({ page, browser }) => {
    test.setTimeout(300_000);
    const dashboardsLink = navLink(page, "Dashboards");

    await test.step("with no default the Dashboards entry opens the list and / opens Assets", async () => {
      await signIn(page, ADMIN);
      await expect(dashboardsLink).toHaveAttribute("href", "/dashboards");
      await dashboardsLink.click();
      await expect(heading1(page, "Dashboards")).toBeVisible();
      await expect(dashRow(page, MAIN)).toBeVisible();
      await expect(dashRow(page, OTHER)).toBeVisible();
      await expect(page.getByRole("table").getByText("Default", { exact: true })).toHaveCount(0);
      await page.goto("/");
      await expect(page).toHaveURL(onPath("/assets"));
    });

    await test.step("Make default in the row's menu puts the Default badge on that row, and the menu then offers Clear default", async () => {
      await page.goto("/dashboards");
      await expect(heading1(page, "Dashboards")).toBeVisible();
      const row = dashRow(page, MAIN);
      await expect(row).toBeVisible();
      await (await rowAction(page, row, "Make default")).click();
      await expect(badge(page, MAIN)).toBeVisible();
      await expect(badge(page, OTHER)).toHaveCount(0);
      expect(await getJson(page, "/api/dashboards/default")).toEqual({ dashboard_id: main });

      await expectNoRowAction(page, row, "Make default");
      const clear = await rowAction(page, row, "Clear default");
      await expect(clear).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(clear).toBeHidden();
      // The other row still offers Make default (and nothing to clear).
      await expectNoRowAction(page, dashRow(page, OTHER), "Clear default");
      // The default row's name link keeps its plain name: the badge is beside it, not inside it.
      await expect(page.getByRole("link", { name: MAIN, exact: true })).toBeVisible();
    });

    await test.step("the sidebar opens the default dashboard and stays highlighted on the list and on every dashboard", async () => {
      await expect(dashboardsLink).toHaveAttribute("href", `/dashboards/${main}`);
      await expect(dashboardsLink).toHaveAttribute("aria-current", "page"); // on /dashboards
      await page.goto(`/dashboards/${other}`);
      await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(OTHER);
      await expect(dashboardsLink).toHaveAttribute("href", `/dashboards/${main}`);
      await expect(dashboardsLink).toHaveAttribute("aria-current", "page"); // on another dashboard

      await dashboardsLink.click();
      await expect(page).toHaveURL(onPath(`/dashboards/${main}`));
      await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(MAIN);
      await expect(dashboardsLink).toHaveAttribute("aria-current", "page");
      await expect(navLink(page, "Billing")).not.toHaveAttribute("aria-current", "page");
    });

    await test.step("the Dashboards crumb still leads to the list, and / opens the default dashboard", async () => {
      await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Dashboards", exact: true }).click();
      await expect(page).toHaveURL(onPath("/dashboards"));
      await expect(heading1(page, "Dashboards")).toBeVisible();
      await expect(dashRow(page, OTHER)).toBeVisible();

      await page.goto("/");
      await expect(page).toHaveURL(onPath(`/dashboards/${main}`));
    });

    await test.step("signing out from another page and in again lands on the default dashboard", async () => {
      await page.goto("/billing");
      await expect(heading1(page, "Billing")).toBeVisible();
      await signOut(page);
      await signIn(page, ADMIN);
      await expect(page).toHaveURL(onPath(`/dashboards/${main}`));
    });

    await test.step("a lost session (no sign-out) still remembers the page it was on", async () => {
      await page.goto("/billing");
      await expect(heading1(page, "Billing")).toBeVisible();
      await page.context().clearCookies();
      // No reload and no click: the status chip's own poll gets the 401 (the path AuthProvider's unauthorized handler takes). A click on
      // a sidebar link would race with that poll, which may already have taken the page to the sign-in form.
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 30_000 });
      await signIn(page, ADMIN);
      await expect(page).toHaveURL(onPath("/billing"));
    });

    await test.step("an operator sees the badge and the trash button but no Actions menu; a viewer sees the badge and no Actions column", async () => {
      await asUser(browser, OPERATOR, async (operator) => {
        await expect(navLink(operator, "Dashboards")).toHaveAttribute("href", `/dashboards/${main}`);
        await operator.goto("/dashboards");
        await expect(heading1(operator, "Dashboards")).toBeVisible();
        await expect(badge(operator, MAIN)).toBeVisible();
        await expect(badge(operator, OTHER)).toHaveCount(0);
        await expect(dashRow(operator, MAIN).getByRole("button", { name: `Delete ${MAIN}`, exact: true })).toBeVisible();
        await expect(operator.getByRole("button", { name: /^Actions for / })).toHaveCount(0);
      });
      await asUser(browser, VIEWER, async (viewer) => {
        await expect(navLink(viewer, "Dashboards")).toHaveAttribute("href", `/dashboards/${main}`);
        await viewer.goto("/dashboards");
        await expect(heading1(viewer, "Dashboards")).toBeVisible();
        await expect(badge(viewer, MAIN)).toBeVisible();
        await expect(viewer.getByRole("columnheader", { name: "Actions" })).toHaveCount(0);
        await expect(viewer.getByRole("button", { name: /^(Actions for |Delete )/ })).toHaveCount(0);
        // The API refuses what the UI hides.
        expect((await viewer.request.put("/api/dashboards/default", { data: { dashboard_id: other } })).status()).toBe(403);
      });
    });

    await test.step("Clear default takes the badge off, and the sidebar and / go back to the list and Assets", async () => {
      await page.goto("/dashboards");
      await expect(badge(page, MAIN)).toBeVisible();
      await (await rowAction(page, dashRow(page, MAIN), "Clear default")).click();
      await expect(badge(page, MAIN)).toHaveCount(0);
      expect(await getJson(page, "/api/dashboards/default")).toEqual({ dashboard_id: null });
      await expect(navLink(page, "Dashboards")).toHaveAttribute("href", "/dashboards");
      await page.goto("/");
      await expect(page).toHaveURL(onPath("/assets"));
    });

    await test.step("deleting the default dashboard asks first, says so, and leaves no default", async () => {
      await page.goto("/dashboards");
      await (await rowAction(page, dashRow(page, OTHER), "Make default")).click();
      await expect(badge(page, OTHER)).toBeVisible();
      await expect(navLink(page, "Dashboards")).toHaveAttribute("href", `/dashboards/${other}`);

      let asked = "";
      page.once("dialog", async (dialog) => {
        asked = dialog.message();
        await dialog.accept();
      });
      await dashRow(page, OTHER).getByRole("button", { name: `Delete ${OTHER}`, exact: true }).click();
      await expect(page.getByRole("link", { name: OTHER, exact: true })).toHaveCount(0);
      expect(asked).toContain(`Delete dashboard "${OTHER}"`);
      expect(asked).toContain("It is the default dashboard");

      expect(await getJson(page, "/api/dashboards/default")).toEqual({ dashboard_id: null });
      await expect(navLink(page, "Dashboards")).toHaveAttribute("href", "/dashboards");
      await page.goto("/");
      await expect(page).toHaveURL(onPath("/assets"));
    });

    await test.step("the Audit page words every change, and the deletion says it was the default", async () => {
      await page.goto(`/audit?q=${encodeURIComponent(MAIN)}`);
      await expect(heading1(page, "Audit log")).toBeVisible();
      await expect(page.getByRole("row").filter({ hasText: `Made dashboard ${MAIN} the default dashboard` }).first()).toBeVisible();
      await expect(page.getByRole("row").filter({ hasText: `Cleared the default dashboard (was ${MAIN})` }).first()).toBeVisible();

      await page.goto(`/audit?q=${encodeURIComponent(OTHER)}`);
      await expect(page.getByRole("row").filter({ hasText: `Made dashboard ${OTHER} the default dashboard` }).first()).toBeVisible();
      await expect(page.getByRole("row").filter({ hasText: `Deleted dashboard ${OTHER} (it was the default dashboard)` }).first()).toBeVisible();
    });
  });
});

test.describe("W7c: the Billing year and month picker", () => {
  const FIRST_MONTH = "2025-03";

  test("Year and Month selects sit beside Previous and Next, start at the current month and jump to a month far back", async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, ADMIN);
    const site = await getJson<{ timezone: string }>(page, "/api/site");
    const now = new Date();
    const inSite = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: site.timezone, ...options }).format(now);
    const currentYear = Number(inSite({ year: "numeric" }));
    const currentMonthNumber = Number(inSite({ month: "numeric" }));
    const currentMonth = `${currentYear}-${String(currentMonthNumber).padStart(2, "0")}`;
    const currentMonthName = inSite({ month: "long" });
    const years = (from: number) => Array.from({ length: Math.max(0, currentYear - from + 1) }, (_, i) => String(from + i));

    const year = page.getByLabel("Year", { exact: true });
    const month = page.getByLabel("Month", { exact: true });
    const previous = page.getByRole("button", { name: "Previous month" });
    const next = page.getByRole("button", { name: "Next month" });

    await test.step("with the real endpoint: the current month, Next disabled, and nothing after the current month on offer", async () => {
      const { first_month: first } = await getJson<{ first_month: string | null }>(page, "/api/billing/months");
      expect(first === null || /^\d{4}-\d{2}$/.test(first), `first_month ${first}`).toBe(true);
      await page.goto("/billing");
      await expect(heading1(page, "Billing")).toBeVisible();
      await expect(year).toHaveValue(String(currentYear));
      await expect(month).toHaveValue(String(currentMonthNumber));
      await expect(next).toBeDisabled();
      await expect(year.locator("option")).toHaveText(years(first === null ? currentYear : Number(first.slice(0, 4))));
      await expect(month.locator("option").last()).toHaveText(currentMonthName); // never a month that has not begun
      if (first !== null && first >= currentMonth) await expect(previous).toBeDisabled();
      else await expect(previous).toBeEnabled();
    });

    await test.step(`with the first month with data at ${FIRST_MONTH}: choosing 2025 and March shows March 2025, and Previous stops there`, async () => {
      // Registered before a FULL page load: the months query is cached for a minute, so a client-side visit would never ask again.
      await page.route("**/api/billing/months", (route) => route.fulfill({ json: { first_month: FIRST_MONTH } }));
      await page.goto("/billing");
      await expect(heading1(page, "Billing")).toBeVisible();
      await expect(year.locator("option")).toHaveText(years(2025));
      await expect(previous).toBeEnabled();

      const [costs] = await Promise.all([
        page.waitForResponse((r) => {
          const url = new URL(r.url());
          return url.pathname === "/api/billing/costs" && url.searchParams.get("month") === FIRST_MONTH;
        }),
        (async () => {
          await year.selectOption("2025");
          await month.selectOption({ label: "March" });
        })(),
      ]);
      expect(costs.ok(), "the costs of March 2025").toBe(true);
      await expect(page.getByText("March 2025", { exact: true })).toBeVisible();
      await expect(year).toHaveValue("2025");
      await expect(month).toHaveValue("3");
      await expect(previous).toBeDisabled();
      await expect(next).toBeEnabled();
      await expect(month.locator("option").first()).toHaveText("March"); // 2025 starts at the first month with data
    });
  });
});
