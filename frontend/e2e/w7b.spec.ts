import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { roleLabel } from "./roles";
import { userBlock } from "./shell";

// W7b (the shared controls: the three-dot row menu, the trash button and the `?` tips; the Storage tiles and the rows-per-day range; the
// sign-in protection switch; the Tariffs sections) on the state the earlier projects leave behind: admin `admin` / `correct-horse` and at
// least one source. Every case signs in on its own and gets a fresh browser context, so no popover state carries over from one case to
// the next. The only thing written to the database is the sign-in policy in the Settings case; it is put back through the API in a
// `finally` and again in afterAll.
//
// The menu items exist only while a menu is open, so every lookup is scoped to the open menu (named after its trigger), never page-wide.
// The `?` tips all carry the name "What does this mean?": a tip is always looked up inside the tile or the field it sits in.

const ADMIN = { username: "admin", password: "correct-horse" };

// The same default as playwright.config.ts: the context afterAll opens needs it spelled out.
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";

// No account has this name: a wrong password for it is counted like any other (the block never depends on the account), and nothing
// real can be locked out by it. The limiter key is (client address, name), so only this name is ever blocked.
const GHOST = "w7b-nobody";

const DAY_MS = 86_400_000;
/** A `YYYY-MM-DD` UTC day moved by whole days (the page's days are UTC days; this browser's zone plays no part). */
const shift = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10);

interface ApiPolicy { max_failures: number; block_minutes: number; enabled: boolean }

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN.username);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(userBlock(page)).toContainText(ADMIN.username);
  await expect(userBlock(page)).toContainText(roleLabel("admin"));
}

async function getJson<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.ok(), path).toBe(true);
  return (await response.json()) as T;
}

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Sources: the row menu and the trash button

/** The Sources page and its first row: the row's menu button, the source's name (from the button's label) and the menu it opens. */
async function firstSource(page: Page) {
  await page.goto("/sources");
  await expect(heading1(page, "Sources")).toBeVisible();
  const row = page.locator("tbody tr").first();
  const trigger = row.getByRole("button", { name: /^Actions for / });
  await expect(trigger).toBeVisible();
  const label = (await trigger.getAttribute("aria-label")) ?? "";
  expect(label, "the first row has an Actions button").toMatch(/^Actions for ./);
  const menu = page.getByRole("menu", { name: label, exact: true });
  return { row, trigger, name: label.slice("Actions for ".length), menu, items: menu.getByRole("menuitem") };
}

/** The open menu lies inside the window, is not a child of the scrolling `.table-wrap`, and nothing covers or cuts off any of its items. */
async function expectMenuReachable(page: Page, menu: Locator) {
  const viewport = page.viewportSize();
  expect(viewport, "the project sets a viewport").not.toBeNull();
  await expect(async () => {
    const box = await menu.boundingBox();
    expect(box, "the open menu has a box").not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  }).toPass({ timeout: 5_000 });
  expect(await menu.evaluate((el) => el.closest(".table-wrap") === null), "the menu is outside .table-wrap").toBe(true);
  // At the middle of every item, the element that is really there is the item (or something inside it): not the table, not the page edge.
  const hidden = await menu.evaluate((el) =>
    Array.from(el.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .filter((item) => {
        const box = item.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return hit === null || !el.contains(hit);
      })
      .map((item) => item.textContent ?? ""),
  );
  expect(hidden, "menu items covered by something else or cut off").toEqual([]);
  // The menu stands beside its trigger, not over the rows around it: the triggers of the rows above and below still receive the pointer.
  const covered = await menu.evaluate((el) => {
    const row = document.getElementById(el.getAttribute("aria-labelledby") ?? "")?.closest("tr");
    return [row?.previousElementSibling, row?.nextElementSibling]
      .map((neighbour) => neighbour?.querySelector<HTMLElement>(".row-menu-btn"))
      .filter((button): button is HTMLElement => !!button)
      .filter((button) => {
        const box = button.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return hit !== null && el.contains(hit);
      })
      .map((button) => button.getAttribute("aria-label") ?? "");
  });
  expect(covered, "the menu covers the Actions button of a neighbouring row").toEqual([]);
}

test("Sources: the row menu works from the keyboard", async ({ page }) => {
  const { trigger, menu, items } = await firstSource(page);

  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(await items.count(), "the menu offers at least two actions").toBeGreaterThanOrEqual(2);
  await expect(items.first()).toBeFocused(); // Enter puts the focus on the first item

  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  // ArrowUp on the closed button opens the menu on its LAST item
  await page.keyboard.press("ArrowUp");
  await expect(menu).toBeVisible();
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("Sources: hover opens the row menu and a click keeps it open", async ({ page }) => {
  const { trigger, menu } = await firstSource(page);
  const title = heading1(page, "Sources");

  // A mouse resting on the button opens the menu; leaving it closes the menu again (it is not pinned).
  await title.hover(); // the mouse starts away from every button
  await trigger.hover();
  await expect(menu).toBeVisible();
  await title.hover();
  await expect(menu).toBeHidden();

  // Hover opens it, a click pins it: the pointer leaves and the menu stays.
  await trigger.hover();
  await expect(menu).toBeVisible();
  await trigger.click();
  await expect(menu).toBeVisible();
  await title.hover();
  await page.waitForTimeout(600); // longer than the menu's 150 ms grace on leaving: an unpinned menu would be gone by now
  await expect(menu).toBeVisible();

  // The second click on the button closes it.
  await trigger.click();
  await expect(menu).toBeHidden();
});

test("Sources: an open row menu is not clipped or covered, at 1600 and at 1024 pixels wide", async ({ page }) => {
  const { trigger, menu } = await firstSource(page);

  await trigger.click();
  await expect(menu).toBeVisible();
  await expectMenuReachable(page, menu);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // A resize closes an open menu, so the window is narrowed first and the menu opened afterwards.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024);
  await trigger.click();
  await expect(menu).toBeVisible();
  await expectMenuReachable(page, menu);
  // The menu is a floating layer and the page has no sideways scroll of its own.
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: "the page's sideways overflow in pixels" })
    .toBeLessThanOrEqual(0);
});

test("Source points: the menu of the last row stays inside the window and leaves the Actions button of the row above uncovered", async ({ page }) => {
  const sources = await getJson<{ id: number }[]>(page, "/api/sources");
  let sourceId: number | undefined;
  for (const source of sources) {
    if ((await getJson<unknown[]>(page, `/api/sources/${source.id}/points`)).length >= 3) {
      sourceId = source.id;
      break;
    }
  }
  expect(sourceId, "a source with at least three points (the simulator source of the first-run journey)").toBeDefined();
  await page.goto(`/sources/${sourceId}/points`);
  await expect(heading1(page, "Points")).toBeVisible();

  const last = page.getByRole("button", { name: /^Actions for / }).last();
  await last.scrollIntoViewIfNeeded();
  const label = (await last.getAttribute("aria-label")) ?? "";
  const menu = page.getByRole("menu", { name: label, exact: true });
  await last.click();
  await expect(menu).toBeVisible();
  await expectMenuReachable(page, menu);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("Sources: the trash button asks first, and Cancel keeps the source", async ({ page }) => {
  const { row, name } = await firstSource(page);
  const asked: { type: string; message: string }[] = [];
  // Registered before the click: the click does not return until the dialog has been answered.
  page.once("dialog", async (dialog) => {
    asked.push({ type: dialog.type(), message: dialog.message() });
    await dialog.dismiss();
  });

  await row.getByRole("button", { name: `Delete ${name}`, exact: true }).click();

  await expect.poll(() => asked.length, { message: "the browser's confirm dialog opened once" }).toBe(1);
  expect(asked[0].type).toBe("confirm");
  expect(asked[0].message).toContain(`Delete source "${name}"`);
  await expect(row.getByRole("button", { name: `Delete ${name}`, exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: `Actions for ${name}`, exact: true })).toBeVisible();
  const sources = await getJson<{ name: string }[]>(page, "/api/sources");
  expect(sources.map((s) => s.name), "the source is still stored").toContain(name);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Storage: the tips and the rows-per-day range

test("Storage: tips open and close, and the rows per day follow the chosen days", async ({ page }) => {
  await page.goto("/storage");
  await expect(heading1(page, "Storage")).toBeVisible();

  const tile = (title: string) => page.locator(".storage-tiles .tile").filter({ hasText: title });
  const tipIn = (scope: Locator) => scope.getByRole("button", { name: "What does this mean?" });

  await test.step("a tile tip opens on a click, and Escape closes it with the focus back on its button", async () => {
    const database = tile("Database size");
    await tipIn(database).click();
    await expect(database.getByRole("note")).toContainText("Everything the database holds on disk");
    await expect(tipIn(database)).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(database.getByRole("note")).toHaveCount(0);
    await expect(tipIn(database)).toBeFocused();
    await expect(tipIn(database)).toHaveAttribute("aria-expanded", "false");
  });

  await test.step("only one tip is open at a time", async () => {
    const database = tile("Database size");
    const rollups = tile("Rollups");
    await tipIn(database).click();
    await expect(database.getByRole("note")).toBeVisible();
    await tipIn(rollups).click();
    await expect(rollups.getByRole("note")).toBeVisible();
    await expect(database.getByRole("note")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(rollups.getByRole("note")).toHaveCount(0);
  });

  await test.step("a field tip explains the setting next to it", async () => {
    const field = page.locator(".retention-form .has-tip").filter({ has: page.getByLabel("Raw retention (days)", { exact: true }) });
    await tipIn(field).click();
    await expect(field.getByRole("note")).toContainText("deleted by a daily job");
    await page.keyboard.press("Escape");
    await expect(field.getByRole("note")).toHaveCount(0);
  });

  const rowsDay = page.locator(".rows-day");
  const dayRows = rowsDay.locator("tbody tr");
  const from = rowsDay.getByLabel("Rows from day", { exact: true });
  const to = rowsDay.getByLabel("Rows to day", { exact: true });
  const problem = rowsDay.getByRole("alert"); // scoped: the warning banners above are alerts too
  const last7 = rowsDay.getByRole("button", { name: "Last 7 days", exact: true });

  await expect(dayRows).toHaveCount(7);
  // The page's own days (the server's UTC days), not this browser's clock.
  const firstDay = await from.inputValue();
  const lastDay = await to.inputValue();
  expect(firstDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(shift(firstDay, 6), "seven days, oldest first").toBe(lastDay);
  // The day column only: the row counts of the newest hours may still move while the spec runs.
  const days = dayRows.locator("td:first-child");
  const sevenDays = Array.from({ length: 7 }, (_, i) => shift(firstDay, i));
  await expect(days).toHaveText(sevenDays);

  await test.step("a last day before the first day shows the message and leaves the table alone", async () => {
    await to.fill(shift(firstDay, -1));
    await expect(problem).toHaveText("The first day must not be after the last day.");
    await expect(dayRows).toHaveCount(7);
    await expect(days).toHaveText(sevenDays);
  });

  await test.step("Last 7 days takes the message away and puts the days back", async () => {
    await last7.click();
    await expect(problem).toHaveCount(0);
    await expect(from).toHaveValue(firstDay);
    await expect(to).toHaveValue(lastDay);
    await expect(days).toHaveText(sevenDays);
  });

  await test.step("a range of the last 3 days shows 3 rows", async () => {
    const start = shift(lastDay, -2);
    const [answer] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/storage/rows-per-day"),
      from.fill(start),
    ]);
    expect(answer.status()).toBe(200);
    expect(new URL(answer.url()).searchParams.get("start")).toBe(start);
    expect(new URL(answer.url()).searchParams.get("end")).toBe(lastDay);
    const range = (await answer.json()) as { days: { day: string; rows: number }[]; total_rows: number; first_day: string | null };
    expect(range.days.map((d) => d.day), "the server answers one entry per day, zero filled").toEqual([start, shift(start, 1), lastDay]);
    await expect(problem).toHaveCount(0);
    if (range.first_day === null) {
      // A site with no hourly rows yet has nothing to list: the page says so instead of drawing a table of zeros.
      test.info().annotations.push({ type: "rows-per-day", description: "no hourly rows on this stack: checked the empty message" });
      await expect(rowsDay.getByText("No readings stored yet.", { exact: true })).toBeVisible();
      await expect(dayRows).toHaveCount(0);
    } else {
      await expect(dayRows).toHaveCount(3);
      await expect(dayRows.locator("td:first-child")).toHaveText(range.days.map((d) => d.day));
      await expect(dayRows.locator("td.num")).toHaveText(range.days.map((d) => d.rows.toLocaleString("en-US")));
      const rows = range.total_rows;
      await expect(rowsDay.getByText(`${rows.toLocaleString("en-US")} ${rows === 1 ? "row" : "rows"} in total`, { exact: true })).toBeVisible();
    }
  });

  await test.step("Last 7 days restores the 7 rows", async () => {
    await last7.click();
    await expect(dayRows).toHaveCount(7);
    await expect(days).toHaveText(sevenDays);
    await expect(from).toHaveValue(firstDay);
    await expect(to).toHaveValue(lastDay);
    await expect(problem).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Settings: the sign-in protection switch

test.describe("W7b: the sign-in protection switch", () => {
  // The two numbers as they were before the spec touched them (the defaults until beforeAll has read them).
  let found = { max_failures: 5, block_minutes: 5 };

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

  /** Protection ON with these numbers. Going from OFF to ON needs no confirmation. */
  async function putOn(request: APIRequestContext, numbers: { max_failures: number; block_minutes: number }) {
    const put = await request.put("/api/settings/sign-in", { data: { ...numbers, enabled: true } });
    expect(put.ok(), `putting the sign-in policy back: ${put.status()} ${await put.text()}`).toBe(true);
  }

  test.beforeAll(async ({ browser }) => {
    // Remember the numbers, and start from ON whatever an earlier run left behind.
    await asAdmin(browser, async (request) => {
      const got = await request.get("/api/settings/sign-in");
      expect(got.ok(), `reading the policy: ${got.status()} ${await got.text()}`).toBe(true);
      const { max_failures, block_minutes } = (await got.json()) as ApiPolicy;
      found = { max_failures, block_minutes };
      await putOn(request, found);
    });
  });

  test.afterAll(async ({ browser }) => {
    await asAdmin(browser, (request) => putOn(request, found));
  });

  const form = (page: Page) => page.getByRole("form", { name: "Sign-in protection", exact: true });
  const toggle = (page: Page) => form(page).getByRole("switch", { name: /Block an account/ });
  const save = (page: Page) => form(page).getByRole("button", { name: "Save sign-in protection", exact: true });
  const warning = (page: Page) => form(page).getByText(/Sign-in protection is off/);
  const dialog = (page: Page) => page.getByRole("dialog", { name: "Stop blocking accounts?", exact: true });
  const policyOf = (page: Page) => getJson<ApiPolicy>(page, "/api/settings/sign-in");
  const policyPut = (page: Page) =>
    page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === "/api/settings/sign-in");

  async function openSettings(page: Page) {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Sign-in protection", exact: true })).toBeVisible();
    // The form shows the switch ON for a moment before the saved answer is applied; the number box is filled by the same update,
    // so once it holds the saved number the switch shows the saved state as well.
    await expect(page.getByLabel("Failed sign-ins before a block", { exact: true })).toHaveValue(String(found.max_failures));
  }

  async function wrongPasswords(request: APIRequestContext, count: number): Promise<number[]> {
    const statuses: number[] = [];
    for (let i = 1; i <= count; i++) {
      const answer = await request.post("/api/login", { data: { username: GHOST, password: `not-the-password-${i}` } });
      statuses.push(answer.status());
    }
    return statuses;
  }

  test("switch off asks first, off blocks nobody, and switching on starts blocking again", async ({ page, request }) => {
    test.setTimeout(180_000);
    try {
      await test.step("off + Save asks first; Cancel keeps protection on, also after a reload", async () => {
        await openSettings(page);
        await expect(toggle(page)).toBeChecked();
        await toggle(page).uncheck();
        await expect(warning(page)).toBeVisible();
        await save(page).click();
        await expect(dialog(page)).toBeVisible();
        expect((await policyOf(page)).enabled, "nothing is saved before the answer").toBe(true);
        await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(dialog(page)).toBeHidden();
        await expect(toggle(page)).toBeChecked();
        await expect(warning(page)).toHaveCount(0);

        await openSettings(page); // a full page load, like a reload
        await expect(toggle(page)).toBeChecked();
        expect((await policyOf(page)).enabled, "still on in the database").toBe(true);
      });

      await test.step("Switch off saves it: after a reload the switch is off and the warning shows", async () => {
        await toggle(page).uncheck();
        await save(page).click();
        await expect(dialog(page)).toBeVisible();
        const [answer] = await Promise.all([
          policyPut(page),
          dialog(page).getByRole("button", { name: "Switch off", exact: true }).click(),
        ]);
        expect(answer.status()).toBe(200);
        expect(new URL(answer.url()).searchParams.get("confirm")).toBe("true");
        await expect(dialog(page)).toBeHidden(); // closes once the answer is in: reloading earlier could cut the request off
        expect((await policyOf(page)).enabled).toBe(false);

        await openSettings(page); // a full page load, like a reload
        await expect(toggle(page)).not.toBeChecked();
        await expect(warning(page)).toBeVisible();
      });

      await test.step("with protection off, eight wrong passwords are all refused with 401 and none is blocked", async () => {
        expect(await wrongPasswords(request, 8)).toEqual(Array(8).fill(401));
      });

      await test.step("switching on needs no question and protection works again from zero", async () => {
        await toggle(page).check();
        await expect(warning(page)).toHaveCount(0);
        const [answer] = await Promise.all([policyPut(page), save(page).click()]);
        expect(answer.status()).toBe(200);
        expect(new URL(answer.url()).searchParams.has("confirm")).toBe(false);
        await expect(dialog(page)).toHaveCount(0);
        expect((await policyOf(page)).enabled).toBe(true);

        await openSettings(page); // a full page load, like a reload
        await expect(toggle(page)).toBeChecked();
        await expect(warning(page)).toHaveCount(0);

        // The eight attempts above were not counted: it takes the full number again, and the one after that is blocked.
        const attempts = await wrongPasswords(request, found.max_failures + 1);
        expect(attempts).toEqual([...Array(found.max_failures).fill(401), 429]);
      });
    } finally {
      // Whatever happened above: protection on again, through the API (a failing page step must not leave the site unprotected).
      // putOn asserts that the answer is ok: a restore that failed is a failure of this test, not something to swallow.
      await putOn(page.request, found);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Tariffs: what each section is for, and a tip

test("Tariffs: each section says what it is for, and a tip explains the rate field", async ({ page }) => {
  await page.goto("/tariffs");
  await expect(heading1(page, "Tariffs")).toBeVisible();

  await expect(page.locator(".sect-head h2")).toHaveText(["Currency", "Site default rate", "Asset overrides"]);
  const purposes = page.locator(".sect-purpose");
  await expect(purposes).toHaveText([/unit costs are shown in/, /no override on itself or on an asset above it/, /unless a lower asset has its own/]);
  for (let i = 0; i < 3; i++) await expect(purposes.nth(i)).toBeVisible();

  // "Rate per kWh" is also a column header and a field of the override form: the tip is looked up in the site default form.
  const rate = page
    .getByRole("form", { name: "Add site default rate", exact: true })
    .locator(".has-tip")
    .filter({ hasText: "Rate per kWh" });
  const tip = rate.getByRole("button", { name: "What does this mean?" });
  await tip.click();
  await expect(rate.getByRole("note")).toContainText("price of one kilowatt-hour");
  await page.keyboard.press("Escape");
  await expect(rate.getByRole("note")).toHaveCount(0);
  await expect(tip).toBeFocused();
});
