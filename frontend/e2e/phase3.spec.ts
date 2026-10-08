import { readFile } from "node:fs/promises";
import { expect, test, type Download, type Locator, type Page } from "@playwright/test";

// Phase 3 on the state the journey and discovery projects leave behind: admin `admin` / `correct-horse`; assets Site
// (root) > Panel 01, LVP02 ... LVP10, plus MV2; the collector has been polling for some minutes. The database is young,
// so every assertion is about structure and "not a dash", never an exact kWh or cost.

const ADMIN = { username: "admin", password: "correct-horse", role: "admin" };
const OPERATOR = { username: "operator1", password: "operator-pass-1", role: "operator" };
const VIEWER = { username: "viewer1", password: "viewer-pass-1", role: "viewer" };
type Account = typeof ADMIN;

const DASHBOARD = "Phase 3 overview";
const STAT = "Panel 01 power";
const BAR = "Energy by panel";
const BAR_ASSETS = ["Panel 01", "LVP02", "LVP03"];
const BOM = [0xef, 0xbb, 0xbf];
const ROW_HEIGHT = 80; // frontend/src/lib/gridMetrics.ts: the read-only dashboard is a CSS grid of 80 px rows with 10 px gaps
const GRID_GAP = 10;

interface ApiWidget {
  type: string; title: string; x: number; y: number; w: number; h: number;
  config: { assets: number[]; source: string; metric: string | null; aggregation: string; range: string | null; bars: string };
}
interface ApiDashboard { id: number; name: string; range: string; updated_at: string; widgets: ApiWidget[] }
interface ApiWidgetData {
  mode: string; source: string; metric: string | null; unit: string | null; missing: number[];
  values: { asset_id: number; name: string; value: number | null; point_id: number | null }[];
}

// ---- locators the UI does not label (Tasks 8-10 define these classes and elements; change them here only) ----
const navLink = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true });
const region = (page: Page, title: string) => page.getByRole("region", { name: title, exact: true });
const statFigure = (page: Page, title: string) => region(page, title).locator(".big");
const barChart = (page: Page, title: string) => region(page, title).locator("canvas").first();
const costTileFigure = (page: Page) => page.locator(".tile").filter({ hasText: "Cost today" }).locator(".big");
const billingRow = (page: Page, asset: string) =>
  page.getByRole("table").getByRole("row").filter({ has: page.getByRole("rowheader", { name: asset, exact: true }) });
// A Billing figure cell has two lines: kWh above, cost below. Cells of a row: 0 rate, 1 month total, 2.. one per day.
// What a cell can say (Task 8, amendment F6): a dash is only ever a cost with no rate; an empty (muted) cell is an asset
// without a meter or a day not reached yet; a muted 0.0 / 0.00 is a day with no data. These assertions only look at cells
// that must hold a real, priced figure, so "not a dash" below means "a rate was found", never "no consumption".
const kwhLine = (cell: Locator) => cell.locator("div").first();
const costLine = (cell: Locator) => cell.locator("div").last();
// ---------------------------------------------------------------------------------------------------------------

async function signIn(page: Page, who: Account) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(who.username);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Where you land depends on where the previous sign-out happened, so callers navigate explicitly.
  await expect(page.getByRole("navigation")).toContainText(`${who.username} (${who.role})`);
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
}

async function createUser(page: Page, who: Account) {
  await navLink(page, "Users").click();
  await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Create user" }) });
  await form.getByLabel("Username").fill(who.username);
  await form.getByLabel("Password").fill(who.password);
  await form.getByLabel("Role").selectOption({ value: who.role });
  await form.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByRole("cell", { name: who.username, exact: true })).toBeVisible();
}

/** Asserts the byte-order mark and the .csv name; returns the lines without the mark. */
async function readCsv(download: Download): Promise<string[]> {
  expect(download.suggestedFilename()).toMatch(/\.csv$/i);
  const bytes = await readFile((await download.path())!);
  expect([...bytes.subarray(0, 3)]).toEqual(BOM);
  return bytes.toString("utf8").replace(/^﻿/, "").split("\r\n").filter((line) => line !== "");
}

/** Every POST /api/widget-data the page sends from now on (the dashboard refetches a widget when its range changes). */
function recordWidgetData(page: Page): { type: string; range: string }[] {
  const seen: { type: string; range: string }[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/widget-data") return;
    try {
      seen.push(JSON.parse(request.postData() ?? "") as { type: string; range: string });
    } catch {
      // not JSON: not ours
    }
  });
  return seen;
}

const pixels = (rows: number) => rows * ROW_HEIGHT + (rows - 1) * GRID_GAP;

/** The widgets' boxes on screen must match the stored x/y/w/h (heights, and the distance between their tops). */
async function expectLayout(page: Page, stat: ApiWidget, bar: ApiWidget) {
  const a = (await region(page, STAT).boundingBox())!;
  const b = (await region(page, BAR).boundingBox())!;
  expect(Math.abs(a.height - pixels(stat.h)), "stat height").toBeLessThanOrEqual(2);
  expect(Math.abs(b.height - pixels(bar.h)), "bar height").toBeLessThanOrEqual(2);
  expect(Math.abs(b.y - a.y - (bar.y - stat.y) * (ROW_HEIGHT + GRID_GAP)), "distance between the tops").toBeLessThanOrEqual(2);
}

test("phase 3 journey: currency and tariff, billing, cost tile, an operator's dashboard, a read-only viewer", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const shot = async (name: string) =>
    testInfo.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  const getJson = async <T>(path: string) => (await (await page.request.get(path)).json()) as T;

  await test.step("admin sets the site currency", async () => {
    await signIn(page, ADMIN);
    await navLink(page, "Tariffs").click();
    await expect(page.getByRole("heading", { name: "Tariffs", exact: true })).toBeVisible();
    await expect(page.getByText(/No currency is set/)).toBeVisible();
    const currency = page.getByRole("form", { name: "Site currency" });
    await currency.getByLabel("Currency", { exact: true }).fill("USD");
    // Setting the currency from unset asks nothing. (Changing or clearing an existing one, or deleting a tariff, calls
    // window.confirm, which Playwright dismisses unless a handler accepts it; this journey does neither.)
    await currency.getByRole("button", { name: "Save" }).click();
    await expect(currency.getByText("saved", { exact: true })).toBeVisible();
    await expect(page.getByText(/No currency is set/)).toHaveCount(0);
    expect((await getJson<{ currency: string | null }>("/api/site")).currency).toBe("USD");
  });

  const assets = await getJson<{ id: number; name: string }[]>("/api/assets");
  const idOf = (name: string) => {
    const found = assets.filter((a) => a.name === name);
    expect(found, `asset ${name}`).toHaveLength(1);
    return found[0].id;
  };
  const panel = idOf("Panel 01");

  await test.step("Review Focus 3, end to end: with no rate yet, Billing shows a dash for cost, never zero", async () => {
    // A mapped meter with no readings already reports 0 kWh, so wait for real consumption: the dash below must mean
    // "no rate", not "nothing was consumed".
    await expect.poll(
      async () => (await getJson<{ energy_today: { kwh: number } | null }>(`/api/assets/${panel}/summary`)).energy_today?.kwh ?? 0,
      { timeout: 120_000, message: "Panel 01 has no consumption yet: is the collector polling the OPC UA panels?" },
    ).toBeGreaterThan(0);
    await navLink(page, "Billing").click();
    await expect(page.getByRole("heading", { name: "Billing", exact: true })).toBeVisible();
    const total = billingRow(page, "Panel 01").getByRole("cell").nth(1);
    await expect(kwhLine(total)).toHaveText(/^~?\d+\.\d$/);
    await expect(costLine(total)).toHaveText("—");
  });

  await test.step("admin adds a site default rate effective 2020-01-01", async () => {
    await navLink(page, "Tariffs").click();
    const add = page.getByRole("form", { name: "Add site default rate" });
    await add.getByLabel("Effective from").fill("2020-01-01");
    await add.getByLabel("Rate per kWh").fill("0.12");
    await add.getByRole("button", { name: "Add rate" }).click();
    const defaults = page.getByRole("table", { name: "Site default rates" });
    await expect(defaults.getByRole("row").filter({ hasText: "2020-01-01" })).toContainText("0.12");
  });

  await test.step("Billing: the current month, priced rows, and the month CSV", async () => {
    const site = await getJson<{ timezone: string; currency: string | null }>("/api/site");
    const now = new Date();
    const inSite = (options: Intl.DateTimeFormatOptions, locale = "en-US") =>
      new Intl.DateTimeFormat(locale, { timeZone: site.timezone, ...options }).format(now);
    const dayOfMonth = Number(inSite({ day: "numeric" }));
    const today = inSite({ year: "numeric", month: "2-digit", day: "2-digit" }, "en-CA"); // YYYY-MM-DD

    await navLink(page, "Billing").click();
    await expect(page.getByText(inSite({ month: "long", year: "numeric" }), { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next month" })).toBeDisabled();
    await expect(page.getByText(/cost in USD below/)).toBeVisible();
    await expect(page.getByRole("table").locator("thead th").nth(1)).toHaveText("Rate (USD/kWh)");
    await expect(page.getByText("Some consumption has no rate")).toHaveCount(0);
    // Panel 01 has its own meter; Site has none, so its figures are its children's sum (Review Focus 3).
    for (const name of ["Panel 01", "Site"]) {
      const cells = billingRow(page, name).getByRole("cell");
      await expect(cells.nth(0), `${name} rate`).toHaveText("0.12");
      for (const [label, cell] of [["month total", cells.nth(1)], ["today", cells.nth(2 + dayOfMonth - 1)]] as const) {
        await expect(kwhLine(cell), `${name} ${label} kWh`).toHaveText(/^~?\d+\.\d$/);
        await expect(costLine(cell), `${name} ${label} cost`).toHaveText(/^~?\d+\.\d{2}\*?$/);
      }
    }
    await shot("billing-current-month");

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
    const lines = await readCsv(download);
    expect(lines[0]).toBe("asset,date,kwh,cost,currency,estimated,partial,no_data");
    const todays = lines.slice(1).map((line) => line.split(",")).filter((cells) => cells[0] === "Site / Panel 01" && cells[1] === today);
    expect(todays, "today's CSV row for Site / Panel 01").toHaveLength(1);
    expect(todays[0][3], "cost cell").not.toBe("");
    expect(todays[0][4]).toBe("USD");
    expect(todays[0][7], "no_data cell: today has readings").toBe("false");
  });

  await test.step("the asset page has a cost tile", async () => {
    await page.goto(`/assets/${panel}`);
    await expect(page.getByRole("heading", { name: "Panel 01" })).toBeVisible();
    await expect(costTileFigure(page)).toHaveText(/^~?\d+\.\d{2}\*?\s*USD$/);
  });

  await test.step("admin creates an operator and a viewer, then signs out", async () => {
    await createUser(page, OPERATOR);
    await createUser(page, VIEWER);
    await signOut(page);
  });

  let dashboardId = 0;
  let saved: ApiDashboard;
  await test.step("operator builds a dashboard: a stat and a bar widget, saved", async () => {
    await signIn(page, OPERATOR);
    await expect(navLink(page, "Tariffs")).toHaveCount(0);
    await navLink(page, "Dashboards").click();
    await expect(page.getByRole("heading", { name: "Dashboards", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New dashboard" }).click();
    const create = page.getByRole("dialog", { name: "New dashboard" });
    await create.getByLabel("Name", { exact: true }).fill(DASHBOARD);
    await create.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboards\/\d+$/);
    dashboardId = Number(new URL(page.url()).pathname.split("/").pop());

    // The new dashboard opens in edit mode.
    await expect(page.getByLabel("Dashboard name")).toHaveValue(DASHBOARD);
    const addWidget = page.getByRole("button", { name: "Add widget" });
    await expect(addWidget).toBeEnabled(); // enabled once the asset list has loaded
    const dialog = page.getByRole("dialog", { name: "Add widget" });

    await addWidget.click();
    await dialog.getByLabel("Type", { exact: true }).selectOption({ value: "stat" });
    await dialog.getByLabel("Title", { exact: true }).fill(STAT);
    await dialog.getByLabel("Metric", { exact: true }).selectOption({ value: "active_power_kw" });
    await dialog.getByLabel("Aggregation", { exact: true }).selectOption({ value: "last" });
    await dialog.getByRole("radio", { name: "Panel 01" }).check();
    await expect(dialog.locator(".widget-preview .big")).toHaveText(/\d+\.\d{2}/); // the preview fetches real data
    await dialog.getByRole("button", { name: "Save widget" }).click();
    await expect(dialog).toBeHidden();

    await addWidget.click();
    await dialog.getByLabel("Type", { exact: true }).selectOption({ value: "bar" });
    await dialog.getByLabel("Title", { exact: true }).fill(BAR);
    await dialog.getByLabel("Source", { exact: true }).selectOption({ value: "energy" });
    await dialog.getByLabel("Widget range", { exact: true }).selectOption({ value: "today" });
    for (const name of BAR_ASSETS) await dialog.getByRole("checkbox", { name }).check();
    await expect(dialog.getByText("3 of 20 selected")).toBeVisible();
    await expect(dialog.locator(".widget-preview canvas").first()).toBeVisible();
    await dialog.getByRole("button", { name: "Save widget" }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible(); // back in view mode

    // What was stored.
    saved = await getJson<ApiDashboard>(`/api/dashboards/${dashboardId}`);
    expect(saved.name).toBe(DASHBOARD);
    expect(saved.range).toBe("24h");
    expect(saved.widgets.map((w) => w.type)).toEqual(["stat", "bar"]); // the API orders widgets by y, x, id
    const [stat, bar] = saved.widgets;
    expect(stat).toMatchObject({
      title: STAT, x: 0, y: 0,
      config: { assets: [panel], source: "metric", metric: "active_power_kw", aggregation: "last", range: null },
    });
    expect(bar).toMatchObject({
      title: BAR, x: 0,
      config: { source: "energy", metric: null, aggregation: "sum", range: "today", bars: "asset" },
    });
    expect([...bar.config.assets].sort()).toEqual(BAR_ASSETS.map(idOf).sort());
    expect(bar.y).toBeGreaterThanOrEqual(stat.y + stat.h);

    // What the stored widgets return: the stat has a live point id, the bar has a number per asset.
    const post = async (w: ApiWidget, range: string) =>
      (await (await page.request.post("/api/widget-data", { data: { type: w.type, config: w.config, range } })).json()) as ApiWidgetData;
    const statData = await post(stat, "24h");
    expect(statData).toMatchObject({ mode: "values", source: "metric", metric: "active_power_kw", unit: "kW", missing: [] });
    expect(statData.values).toHaveLength(1);
    expect(statData.values[0].value).not.toBeNull();
    expect(statData.values[0].point_id).not.toBeNull();
    const barData = await post(bar, "today");
    expect(barData).toMatchObject({ mode: "values", source: "energy", unit: "kWh", missing: [] });
    expect(barData.values.map((v) => v.name).sort()).toEqual([...BAR_ASSETS].sort());
    for (const v of barData.values) expect(v.value, v.name).not.toBeNull();

    // What the view shows.
    await expect(statFigure(page, STAT)).toHaveText(/\d+\.\d{2}/);
    await expect(barChart(page, BAR)).toBeVisible();
    await expect(region(page, BAR).getByText("No data in this range.")).toHaveCount(0);
    await expectLayout(page, stat, bar);
  });

  await test.step("after a reload both widgets and their layout are still there", async () => {
    await page.reload();
    await expect(region(page, STAT)).toBeVisible();
    await expect(region(page, BAR)).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible(); // view mode, not the editor
    await expect(page.getByRole("button", { name: "Add widget" })).toHaveCount(0);
    await expect(statFigure(page, STAT)).toHaveText(/\d+\.\d{2}/);
    await expect(barChart(page, BAR)).toBeVisible();
    const [stat, bar] = saved.widgets;
    await expectLayout(page, stat, bar);
    await shot("dashboard-after-reload");
  });

  await test.step("changing the dashboard range refetches the widgets that inherit it", async () => {
    const requests = recordWidgetData(page);
    await page.getByLabel("Dashboard range").selectOption({ value: "7d" });
    await expect.poll(() => requests.filter((r) => r.type === "stat" && r.range === "7d").length).toBeGreaterThan(0);
    expect(requests.filter((r) => r.type === "bar" && r.range !== "today"), "the bar keeps its own range").toEqual([]);
    await expect(page.getByText(/for this visit only/)).toBeVisible();
    await expect(statFigure(page, STAT)).toHaveText(/\d+\.\d{2}/);
    const after = await getJson<ApiDashboard>(`/api/dashboards/${dashboardId}`); // viewing a range saves nothing
    expect(after.range).toBe("24h");
    expect(after.updated_at).toBe(saved.updated_at);
  });

  await test.step("a widget exports its data as CSV", async () => {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: `Download CSV for ${BAR}` }).click(),
    ]);
    const lines = await readCsv(download);
    expect(lines[0]).toBe("asset,source,unit,timestamp,value,estimated,partial,no_data");
    for (const name of BAR_ASSETS) {
      expect(lines.find((line) => line.startsWith(`Site / ${name},energy,kWh,`)), `a row for ${name}`).toBeDefined();
    }
  });

  await test.step("a viewer sees the dashboard but cannot change anything", async () => {
    await signOut(page);
    await signIn(page, VIEWER);
    await expect(navLink(page, "Dashboards")).toBeVisible();
    await expect(navLink(page, "Billing")).toBeVisible();
    await expect(navLink(page, "Tariffs")).toHaveCount(0);

    await navLink(page, "Dashboards").click();
    const link = page.getByRole("link", { name: DASHBOARD });
    await expect(link).toBeVisible();
    await expect(page.getByRole("button", { name: "New dashboard" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Delete/ })).toHaveCount(0);

    await link.click();
    await expect(region(page, STAT)).toBeVisible();
    await expect(region(page, BAR)).toBeVisible();
    await expect(statFigure(page, STAT)).toHaveText(/\d+\.\d{2}/);
    await expect(page.getByRole("button", { name: "Download CSV for " + STAT })).toBeVisible(); // exports are allowed
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add widget" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(Edit|Delete) / })).toHaveCount(0);
    await shot("dashboard-as-viewer");

    await navLink(page, "Billing").click();
    await expect(billingRow(page, "Panel 01")).toBeVisible();
    await expect(page.getByRole("button", { name: "Download CSV" })).toBeVisible();

    await page.goto("/tariffs");
    await expect(page.getByRole("heading", { name: "Admins only" })).toBeVisible();

    // The API refuses what the UI hides.
    expect((await page.request.get("/api/tariffs")).status()).toBe(403);
    const rate = { asset_id: null, rate_per_kwh: 9, effective_from: "2021-01-01" };
    expect((await page.request.post("/api/tariffs", { data: rate })).status()).toBe(403);
    const edit = { name: DASHBOARD, range: "24h", updated_at: saved.updated_at, widgets: [] };
    expect((await page.request.put(`/api/dashboards/${dashboardId}`, { data: edit })).status()).toBe(403);
    expect((await page.request.delete(`/api/dashboards/${dashboardId}`)).status()).toBe(403);
    expect((await getJson<ApiDashboard>(`/api/dashboards/${dashboardId}`)).widgets).toHaveLength(2);
  });

  await test.step("admin finds the audited actions", async () => {
    await signOut(page);
    await signIn(page, ADMIN);
    await navLink(page, "Audit").click();
    await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
    for (const action of ["tariff.created", "billing.currency_changed", "dashboard.created", "dashboard.updated"]) {
      await expect(page.getByRole("cell", { name: action, exact: true }), action).toHaveCount(1);
    }
  });
});
