import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

// W7j (pages that use their space) on the state the earlier projects leave behind: admin `admin` / `correct-horse`, audit entries (the
// sign-ins of every project before this one), a site currency and a site default rate. Nothing is created or changed: the pages are only
// opened, measured and (the Details button) clicked, and the admin signs in through the API.
//
// What it pins, for the five pages Audit log, Storage, Tariffs, Settings and Diagnostics: no sideways scroll at 1920, 1440 and 1024 px; at
// 1440 px the card pairs sit side by side (Settings' two cards have one height and their Save buttons one top; Tariffs' Currency card is a row
// of its own above its two rate cards) and at 1024 px they stack; Tariffs' description is wide; the Audit toolbar is at most two rows and keeps
// every accessible name, its table has a header row and Details opens a detail row; the version line never says "built unknown"; and the
// skeletons of Tariffs, Audit, Storage (at 1024 px; w7f covers 1440) and Settings (at 1440 and 1024 px) sit where the loaded page lands.
// Pixel sizes are NOT pinned, only pairs against each other: a retuned layout needs no edit here.
//
// A skeleton is looked at as in w7f: the request it waits for is held with `page.route` (`hold`) and answered when the test says so.

const ADMIN = { username: "admin", password: "correct-horse" };

const NEAR = 2; // px: how far a skeleton may sit from the content that replaces it
const LEVEL = 1; // px: how far apart two edges may be and still count as level
const ROW_TOLERANCE = 12; // px: controls whose tops are this close are on one row of the toolbar

/** Signs the admin in through the API: the session cookie belongs to the page's browser context. */
async function signIn(page: Page): Promise<void> {
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in: ${login.status()}`).toBe(true);
}

/**
 * Keeps the answer to every request for `path` back until `release()`, then answers it (and every later request for the path) with `answer`:
 * by default the real one. The routes wait on one gate, so there is nothing to unroute.
 */
async function hold(page: Page, path: string, answer: (route: Route) => Promise<void> = (route) => route.continue()) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  await page.route((url) => url.pathname === path, async (route) => {
    requests += 1;
    await gate;
    await answer(route).catch(() => undefined); // the page may be gone by now
  });
  return { release, requests: () => requests };
}

/** The skeleton region of an area, by its label, matched whole. */
const skeleton = (page: Page, label: string) => page.getByRole("status").filter({ hasText: new RegExp(`^${label}$`) });
const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const heading2 = (page: Page, name: string) => page.getByRole("heading", { level: 2, name, exact: true });

/** Two animation frames: whatever the page does about a changed layout has happened by then. */
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

async function setWidth(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
}

/** Every number of `got` within NEAR px of `want`. */
function expectNear(got: object, want: object, what: string): void {
  for (const [key, expected] of Object.entries(want) as [string, number][]) {
    const actual = (got as Record<string, number>)[key];
    expect(Math.abs(actual - expected), `${what}: ${key} is ${actual} px, the content's is ${expected} px`).toBeLessThanOrEqual(NEAR);
  }
}

/** How far the page is wider than the window, in pixels (0 or less is fine: nothing scrolls sideways), and the first element that sticks out. */
const overflowX = (page: Page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    const out = [...document.body.querySelectorAll("*")].find((el) => el.getBoundingClientRect().right > root.clientWidth + 0.5);
    const name = out ? `${out.tagName.toLowerCase()}${out.className && typeof out.className === "string" ? `.${out.className.trim().replace(/\s+/g, ".")}` : ""}` : "none";
    return { over: root.scrollWidth - root.clientWidth, widest: name };
  });

interface Box { x: number; y: number; width: number; height: number }
/** The box of the one element the locator finds, in the viewport. */
async function boxOf(locator: Locator, what: string): Promise<Box> {
  await expect(locator, `${what} is on the page`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  return box!;
}

/** The card of a page with this h2 (the loaded page: a skeleton card has no words). */
const card = (page: Page, area: string, title: string) =>
  page.locator(`${area} .page-card`).filter({ has: heading2(page, title) });

/** `b` is level with `a` and to its right (same top, a different left). */
function expectSideBySide(a: Box, b: Box, what: string): void {
  expect(Math.abs(a.y - b.y), `${what}: the tops (${a.y} and ${b.y} px) are level`).toBeLessThanOrEqual(LEVEL);
  expect(b.x, `${what}: the second starts (${b.x} px) after the first ends (${a.x + a.width} px)`).toBeGreaterThanOrEqual(a.x + a.width - LEVEL);
}

/** `b` is under `a` at the same left. */
function expectStacked(a: Box, b: Box, what: string): void {
  expect(Math.abs(a.x - b.x), `${what}: the lefts (${a.x} and ${b.x} px) are level`).toBeLessThanOrEqual(LEVEL);
  expect(b.y, `${what}: the second starts (${b.y} px) below the first's end (${a.y + a.height} px)`).toBeGreaterThanOrEqual(a.y + a.height - LEVEL);
}

/** The starts of the rows that tops fall into: a top within `tolerance` of the start of the current row is on that row. */
function rowStarts(tops: number[], tolerance: number): number[] {
  const rows: number[] = [];
  for (const top of [...tops].sort((a, b) => a - b)) {
    if (rows.length === 0 || top - rows[rows.length - 1] > tolerance) rows.push(top);
  }
  return rows;
}

// The five pages: where they are, their h1 and the h2 of their cards (the page is loaded when every one is there and no skeleton is left).
const PAGES = [
  { path: "/audit", title: "Audit log", ready: (page: Page) => page.locator(".audit-page .audit-table") },
  { path: "/storage", title: "Storage", ready: (page: Page) => heading2(page, "Retention and capacity") },
  { path: "/tariffs", title: "Tariffs", ready: (page: Page) => heading2(page, "Asset overrides") },
  { path: "/settings", title: "Settings", ready: (page: Page) => heading2(page, "Sign-in protection") },
  { path: "/diagnostics", title: "Diagnostics", ready: (page: Page) => heading2(page, "Connection check") },
];

/** Opens a page and waits until it is the loaded page: its h1, its last card and no skeleton region. */
async function openLoaded(page: Page, entry: (typeof PAGES)[number]): Promise<void> {
  await page.goto(entry.path);
  await expect(heading1(page, entry.title)).toBeVisible();
  await expect(entry.ready(page)).toBeVisible();
  await expect(page.locator(".sk-region"), `${entry.path}: no skeleton is left`).toHaveCount(0);
  await settled(page);
}

test.describe("W7j: pages that use their space", () => {
  for (const entry of PAGES) {
    test(`${entry.path} does not scroll sideways at 1920, 1440 and 1024 px`, async ({ page }) => {
      await signIn(page);
      for (const width of [1920, 1440, 1024]) {
        await test.step(`${width} px`, async () => {
          await setWidth(page, width);
          await openLoaded(page, entry);
          const { over, widest } = await overflowX(page);
          expect(over, `${entry.path} at ${width} px is ${over} px wider than the window (the first element past the edge: ${widest})`).toBeLessThanOrEqual(0);
        });
      }
    });
  }

  test("Settings: General and Sign-in protection are one height with their Save buttons level at 1440 px, and stack at 1024 px", async ({ page }) => {
    await signIn(page);
    const settings = PAGES.find((p) => p.path === "/settings")!;
    const cards = () => [card(page, ".settings-page", "General"), card(page, ".settings-page", "Sign-in protection")] as const;
    const saves = () => [
      card(page, ".settings-page", "General").getByRole("button", { name: "Save", exact: true }),
      card(page, ".settings-page", "Sign-in protection").getByRole("button", { name: "Save sign-in protection", exact: true }),
    ] as const;

    await test.step("1440 px: side by side, one height, Save buttons at one top", async () => {
      await setWidth(page, 1440);
      await openLoaded(page, settings);
      const [general, signInProtection] = [await boxOf(cards()[0], "the General card"), await boxOf(cards()[1], "the Sign-in protection card")];
      expectSideBySide(general, signInProtection, "General and Sign-in protection");
      expect(Math.abs(general.height - signInProtection.height), `the cards are ${general.height} and ${signInProtection.height} px tall`).toBeLessThanOrEqual(LEVEL);
      const [saveGeneral, saveSignIn] = [await boxOf(saves()[0], "General's Save"), await boxOf(saves()[1], "Sign-in protection's Save")];
      expect(Math.abs(saveGeneral.y - saveSignIn.y), `the Save buttons are at ${saveGeneral.y} and ${saveSignIn.y} px`).toBeLessThanOrEqual(LEVEL);
    });

    await test.step("1024 px: stacked", async () => {
      await setWidth(page, 1024);
      await openLoaded(page, settings);
      expectStacked(await boxOf(cards()[0], "the General card"), await boxOf(cards()[1], "the Sign-in protection card"), "General and Sign-in protection");
    });
  });

  test("Tariffs: Currency is a row of its own above the two rate cards, which sit side by side at 1440 px and stack at 1024 px; the description is wide", async ({ page }) => {
    await signIn(page);
    const tariffs = PAGES.find((p) => p.path === "/tariffs")!;
    const boxes = async () => ({
      currency: await boxOf(card(page, ".tariffs-page", "Currency"), "the Currency card"),
      site: await boxOf(card(page, ".tariffs-page", "Site default rate"), "the Site default rate card"),
      overrides: await boxOf(card(page, ".tariffs-page", "Asset overrides"), "the Asset overrides card"),
    });

    await test.step("1440 px", async () => {
      await setWidth(page, 1440);
      await openLoaded(page, tariffs);
      const { currency, site, overrides } = await boxes();
      expectSideBySide(site, overrides, "Site default rate and Asset overrides");
      expect(site.y, `Currency ends at ${currency.y + currency.height} px, the rate cards start at ${site.y} px`).toBeGreaterThanOrEqual(currency.y + currency.height - LEVEL);
      expect(currency.x, "the Currency card starts where the left card does").toBeLessThanOrEqual(site.x + LEVEL);
      expect(currency.x + currency.width, "the Currency card ends where the right card does").toBeGreaterThanOrEqual(overrides.x + overrides.width - LEVEL);
      const description = await boxOf(page.locator(".tariffs-page .page-head .sub"), "the page description");
      expect(description.width, "the description is not squeezed into a narrow column").toBeGreaterThan(800);
    });

    await test.step("1024 px", async () => {
      await setWidth(page, 1024);
      await openLoaded(page, tariffs);
      const { currency, site, overrides } = await boxes();
      expectStacked(currency, site, "Currency and Site default rate");
      expectStacked(site, overrides, "Site default rate and Asset overrides");
    });
  });

  test("Storage: Rows per day and Retention and capacity sit side by side at 1440 px and stack at 1024 px", async ({ page }) => {
    await signIn(page);
    const storage = PAGES.find((p) => p.path === "/storage")!;
    const boxes = async () => [
      await boxOf(card(page, ".storage-page", "Rows per day"), "the Rows per day card"),
      await boxOf(card(page, ".storage-page", "Retention and capacity"), "the Retention and capacity card"),
    ] as const;

    await test.step("1440 px", async () => {
      await setWidth(page, 1440);
      await openLoaded(page, storage);
      const [rows, retention] = await boxes();
      expectSideBySide(rows, retention, "Rows per day and Retention and capacity");
    });

    await test.step("1024 px", async () => {
      await setWidth(page, 1024);
      await openLoaded(page, storage);
      const [rows, retention] = await boxes();
      expectStacked(rows, retention, "Rows per day and Retention and capacity");
    });
  });

  test("Audit log at 1440 px: a toolbar of at most two rows, every control by its name, a table with a header row, and Details opens a detail row", async ({ page }) => {
    await signIn(page);
    await setWidth(page, 1440);
    await openLoaded(page, PAGES[0]);
    const bar = page.getByRole("search", { name: "Filter the audit log", exact: true });
    await expect(bar, "the toolbar is the search landmark").toBeVisible();

    await test.step("the controls sit on at most two rows", async () => {
      const tops = await bar.evaluate((el) =>
        [...el.querySelectorAll("input, select, button")]
          .map((control) => control.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) => rect.top),
      );
      expect(tops.length, "the toolbar has controls").toBeGreaterThan(5);
      const rows = rowStarts(tops, ROW_TOLERANCE);
      expect(rows.length, `the control tops ${tops.map((t) => Math.round(t)).join(", ")} fall on ${rows.length} rows`).toBeLessThanOrEqual(2);
    });

    await test.step("every control resolves by its accessible name", async () => {
      const named: [string, Locator][] = [
        ["Search", bar.getByRole("textbox", { name: "Search", exact: true })],
        ["User", bar.getByRole("combobox", { name: "User", exact: true })],
        ["Action", bar.getByRole("combobox", { name: "Action", exact: true })],
        ["From", bar.getByLabel("From", { exact: true })],
        ["To", bar.getByLabel("To", { exact: true })],
        ["Go to date", bar.getByLabel("Go to date", { exact: true })],
        ["Export CSV", bar.getByRole("button", { name: "Export CSV", exact: true })],
        ["Friendly", page.getByRole("button", { name: "Friendly", exact: true })],
        ["Raw", page.getByRole("button", { name: "Raw", exact: true })],
      ];
      for (const [name, locator] of named) await expect(locator, `"${name}" is found once`).toBeVisible();
      await expect(page.getByRole("button", { name: "Friendly", exact: true }), "the friendly view is the one shown").toHaveAttribute("aria-pressed", "true");
    });

    const table = page.locator(".audit-page").getByRole("table");
    await test.step("the friendly view is a table with a header row", async () => {
      await expect(table, "one table").toHaveCount(1);
      const headers = table.locator("thead tr").first().getByRole("columnheader");
      await expect(headers, "four column headers").toHaveCount(4);
      await expect(table.getByRole("columnheader", { name: "User", exact: true })).toHaveCount(1);
      await expect(table.getByRole("columnheader", { name: "What happened", exact: true })).toHaveCount(1);
      await expect(table.getByRole("columnheader", { name: "Details", exact: true }), "the first column (the Details buttons) is named for screen readers").toHaveCount(1);
    });

    await test.step("Details opens the detail row under the entry, and closes it again", async () => {
      const details = table.getByRole("button", { name: "Details" }).first();
      await expect(details).toHaveAttribute("aria-expanded", "false");
      await expect(table.locator(".detail-row"), "no detail row is drawn while closed").toHaveCount(0);
      await details.click();
      await expect(details).toHaveAttribute("aria-expanded", "true");
      const row = table.locator(".detail-row");
      await expect(row, "the detail row is drawn").toHaveCount(1);
      await expect(row).toBeVisible();
      expect(await details.getAttribute("aria-controls"), "the button points at the detail row").toBe(await row.getAttribute("id"));
      await details.click();
      await expect(details).toHaveAttribute("aria-expanded", "false");
      await expect(table.locator(".detail-row")).toHaveCount(0);
    });
  });

  test("Settings: the version line says what is known and never \"built unknown\"", async ({ page }) => {
    await signIn(page);
    await setWidth(page, 1440);
    await openLoaded(page, PAGES.find((p) => p.path === "/settings")!);
    await expect(page.locator(".settings-page .about-line").filter({ hasText: /^Version / }), "the About card has a version line").toBeVisible();
    await expect(page.locator("main")).not.toContainText("built unknown");
  });

  test("Tariffs, Audit and Storage hold their table where it lands: the first row of the skeleton and of the loaded page are within 2 px at 1024 px", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    await setWidth(page, 1024);

    // The first body row, and the box of its table, of the skeleton and of the real table; null where there is none.
    const measure = (skeletonRows: string, loadedRows: string, loaded: boolean) =>
      page.evaluate(([sk, ld, isLoaded]) => {
        const row = document.querySelector(isLoaded ? ld : sk);
        if (!row) return null;
        return { row: row.getBoundingClientRect().top, wrap: row.closest(".table-wrap")!.getBoundingClientRect().top };
      }, [skeletonRows, loadedRows, loaded] as const);

    const pages = [
      { name: "Tariffs", page: ".tariffs-page", path: "/tariffs", gate: "/api/tariffs", label: "Loading tariffs", skeletonRows: ".tariffs-page .sk-table tbody tr", loadedRows: '.tariffs-page table[aria-label="Site default rates"] tbody tr' },
      { name: "Audit", page: ".audit-page", path: "/audit", gate: "/api/audit", label: "Loading the audit log", skeletonRows: ".audit-page .sk-table tbody tr", loadedRows: ".audit-page .audit-table tbody tr" },
      { name: "Storage", page: ".storage-page", path: "/storage", gate: "/api/storage", label: "Loading storage", skeletonRows: ".rows-day .sk-table tbody tr", loadedRows: ".rows-day .table-wrap:not(.sk-table) tbody tr" },
    ];
    for (const { name, page: area, path, gate, label, skeletonRows, loadedRows } of pages) {
      await test.step(`${name}: the request for the table held, then answered`, async () => {
        const held = await hold(page, gate);
        try {
          await page.goto(path);
          await expect(skeleton(page, label)).toBeVisible();
          await expect(page.locator(".sk-region"), "the held region is the only one (another area's skeleton would move things)").toHaveCount(1);
          await settled(page);
          const asSkeleton = await measure(skeletonRows, loadedRows, false);
          expect(asSkeleton, `${name}: the skeleton has a first row`).not.toBeNull();

          held.release();
          await expect(skeleton(page, label)).toHaveCount(0);
          await expect(page.locator(".sk-region")).toHaveCount(0);
          await expect(page.locator(loadedRows).first(), `${name}: the loaded page has a first row`).toBeVisible();
          await settled(page);
          // a row the skeleton does not draw sits above the table in some states of the data, and then the numbers say nothing about the skeleton
          expect(await page.locator(`${area} .banner`).count(), `${name}: a banner (a missing currency, Storage's warning) is drawn above the table`).toBe(0);
          const loaded = await measure(skeletonRows, loadedRows, true);
          expectNear(asSkeleton!, loaded!, `the ${name} skeleton`);
        } finally {
          held.release();
        }
        await page.unrouteAll({ behavior: "ignoreErrors" });
      });
    }
  });

  test("Settings holds its two cards where they land: top and height of the skeleton and of the loaded cards are within 2 px at 1440 and 1024 px", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);

    // The first two cards of the grid (General and Sign-in protection when loaded), whether they are the skeleton's or the real ones.
    const cards = () =>
      page.evaluate(() => {
        const found = [...document.querySelectorAll(".settings-page .page-grid > .page-card")].slice(0, 2).map((el) => el.getBoundingClientRect());
        if (found.length < 2) throw new Error(`expected two cards, found ${found.length}`);
        return { firstTop: found[0].top, firstHeight: found[0].height, secondTop: found[1].top, secondHeight: found[1].height };
      });

    for (const width of [1440, 1024]) {
      await test.step(`${width} px: /api/settings/general held, then answered`, async () => {
        await setWidth(page, width);
        const held = await hold(page, "/api/settings/general");
        try {
          await page.goto("/settings");
          await expect(skeleton(page, "Loading settings")).toBeVisible();
          await expect(page.locator(".sk-region"), "the held region is the only one").toHaveCount(1);
          await settled(page);
          const asSkeleton = await cards();

          held.release();
          await expect(skeleton(page, "Loading settings")).toHaveCount(0);
          await expect(heading2(page, "General")).toBeVisible();
          await expect(heading2(page, "Sign-in protection")).toBeVisible();
          await expect(page.locator(".sk-region"), "the sign-in policy has arrived as well").toHaveCount(0);
          await settled(page);
          // the sign-in card grows by a warning banner when protection is switched off, which the skeleton does not draw
          expect(await page.locator(".settings-page .banner").count(), "a banner (sign-in protection is off) makes a card taller than its skeleton").toBe(0);
          expectNear(asSkeleton, await cards(), `the Settings skeleton at ${width} px`);
        } finally {
          held.release();
        }
        await page.unrouteAll({ behavior: "ignoreErrors" });
      });
    }
  });
});
