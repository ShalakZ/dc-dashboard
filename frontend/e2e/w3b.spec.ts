import { expect, test, type Locator, type Page } from "@playwright/test";

// W3b (dashboards close up vertically, a parent's live power, the Trend says when it was updated, long names in charts) on the state
// the earlier projects leave behind: admin `admin` / `correct-horse`; the manual source `sim` (60 simulator points, LVP01..LVP10 with
// kW, kWh, V, A, PF, Hz each; only LVP01_kW and LVP01_kWh are mapped, both to the asset MV2); the root asset `Site`. The spec
// builds on that through the JSON API and leaves its own assets, mappings and dashboards behind.
//
// Locators: widgets are `region`s named by their title (the titles below are not prefixes of each other); buttons that share words
// with others (Edit and "Edit <title>", Save, Delete) are matched with `exact: true`.

const ADMIN = { username: "admin", password: "correct-horse" };

const ROW_HEIGHT = 80; // frontend/src/lib/gridMetrics.ts: 80 px rows with 10 px gaps, in the viewer and in the editor alike
const GRID_GAP = 10;
const ROW = ROW_HEIGHT + GRID_GAP;

const FIRST = "W3b first";
const SECOND = "W3b second";
const BAR = "W3b bar";
const SERIES = "W3b series";
// A run suffix, so the spec can run again on a stack an earlier run left its dashboards and assets on: dashboard names are unique
// everywhere, asset names among siblings (the room sits under the shared root, the rest under the room).
const RUN = Date.now().toString(36);
// Exactly 45 characters on purpose; it is created under this run's own room, so it needs no suffix.
const LONG_NAME = "W3b-Main-Switchgear-Feeder-Room-East-Panel-07";

interface ApiAsset { id: number; parent_id: number | null; name: string; kind: string }
interface ApiSource { id: number; name: string }
interface ApiPoint { id: number; address: string; unit_hint: string | null; mapping: { id: number; asset_id: number; metric: string } | null }
interface ApiWidget { type: string; title: string; config: Record<string, unknown>; x: number; y: number; w: number; h: number }
interface ApiDashboard { id: number; name: string; range: string; updated_at: string; widgets: ApiWidget[] }
interface ApiSummary {
  metrics: { metric: string; value: number | null }[];
  power_rollup?: { sources: { name: string; value: number | null; stale: boolean }[] } | null;
}
interface Box { x: number; y: number; width: number; height: number }

async function getJson<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.ok(), path).toBe(true);
  return (await response.json()) as T;
}

async function sendJson<T>(page: Page, method: "post" | "put", path: string, data: unknown): Promise<T> {
  const response = await page.request[method](path, { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/** A dashboard with these widgets, made through the API (a create, then a save of the whole thing). */
async function createDashboard(page: Page, name: string, range: string, widgets: ApiWidget[]): Promise<ApiDashboard> {
  const created = await sendJson<ApiDashboard>(page, "post", "/api/dashboards", { name, range });
  return sendJson<ApiDashboard>(page, "put", `/api/dashboards/${created.id}`, { name, range, updated_at: created.updated_at, widgets });
}

const region = (scope: Page | Locator, title: string) => scope.getByRole("region", { name: title, exact: true });

/** The boxes of the named widgets, relative to the top left corner of `grid`, so the two screens can be compared. */
async function boxesIn(grid: Locator, titles: string[]): Promise<Box[]> {
  const origin = await grid.boundingBox();
  expect(origin, "the grid is on screen").not.toBeNull();
  const boxes: Box[] = [];
  for (const title of titles) {
    const box = await region(grid, title).boundingBox();
    expect(box, `the widget ${title} is on screen`).not.toBeNull();
    boxes.push({ x: box!.x - origin!.x, y: box!.y - origin!.y, width: box!.width, height: box!.height });
  }
  return boxes;
}

/** The largest difference in left, top, width or height between two lists of boxes. */
function farthest(a: Box[], b: Box[]): number {
  return Math.max(...a.flatMap((box, i) => [Math.abs(box.x - b[i].x), Math.abs(box.y - b[i].y), Math.abs(box.width - b[i].width), Math.abs(box.height - b[i].height)]));
}

// The mappings the test makes, removed again afterwards so the unmapped kW points of sim are free for the next run.
const ownMappings: number[] = [];
test.afterEach(async ({ page }) => {
  for (const id of ownMappings.splice(0)) await page.request.delete(`/api/mappings/${id}`).catch(() => undefined);
});

test("W3b: dashboards close up, a parent's live power, the Trend's updated time, long names in charts", async ({ page }) => {
  test.setTimeout(360_000);

  await test.step("the admin signs in", async () => {
    await page.goto("/login");
    await page.getByLabel("Username").fill(ADMIN.username);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("navigation")).toContainText(`${ADMIN.username} (admin)`);
  });

  const assets = await getJson<ApiAsset[]>(page, "/api/assets");
  const mv2 = assets.find((a) => a.name === "MV2");
  expect(mv2, "the asset MV2 from the journey").toBeTruthy();
  const root = assets.find((a) => a.name === "Site" && a.parent_id === null);

  const createAsset = (name: string, parent: number | null, kind: string) =>
    sendJson<ApiAsset>(page, "post", "/api/assets", { name, parent_id: parent, kind, sort_order: 0 });
  const mapPower = async (point: ApiPoint, asset: ApiAsset) => {
    const mapping = await sendJson<{ id: number }>(page, "post", "/api/mappings", { point_id: point.id, asset_id: asset.id, metric: "active_power_kw", scale: 1 });
    ownMappings.push(mapping.id);
    return mapping;
  };

  await test.step("compaction: the view and the editor show the same closed-up layout, and only a change stores it", async () => {
    const stat = (title: string, y: number): ApiWidget => ({
      type: "stat", title, x: 0, y, w: 4, h: 2,
      config: { assets: [mv2!.id], source: "metric", metric: "active_power_kw", aggregation: "last", range: null },
    });
    // A dashboard as the old editor could leave it: a gap of four rows between the two widgets.
    const made = await createDashboard(page, `W3b compaction ${RUN}`, "24h", [stat(FIRST, 0), stat(SECOND, 6)]);
    const stored = await getJson<ApiDashboard>(page, `/api/dashboards/${made.id}`);
    expect(stored.widgets.map((w) => w.y)).toEqual([0, 6]);

    const writes: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() !== "GET" && path.startsWith("/api/dashboards")) writes.push(`${request.method()} ${path}`);
    });

    // The view: the second widget sits directly under the first, one grid gap away.
    await page.goto(`/dashboards/${made.id}`);
    const viewGrid = page.locator(".dash-grid");
    await expect(region(viewGrid, FIRST)).toBeVisible();
    await expect(region(viewGrid, SECOND)).toBeVisible();
    const viewBoxes = await boxesIn(viewGrid, [FIRST, SECOND]);
    const [first, second] = viewBoxes;
    expect(first.y, "the first widget is at the top edge of the grid").toBeLessThanOrEqual(1);
    expect(Math.abs(first.height - (2 * ROW_HEIGHT + GRID_GAP)), "the first widget is two rows high").toBeLessThanOrEqual(2);
    expect(Math.abs(second.y - (first.y + first.height) - GRID_GAP), "the gap between the two is the grid gap").toBeLessThanOrEqual(2);
    expect(Math.abs(second.y - 2 * ROW), "the second widget starts at row 3, not row 7").toBeLessThanOrEqual(2);

    // The editor opens on the closed-up layout, which is not a change: Save stays off, nothing says "Not saved yet".
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editGrid = page.locator(".dash-grid-edit");
    await expect(region(editGrid, FIRST)).toBeVisible();
    await expect(region(editGrid, SECOND)).toBeVisible();
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeDisabled();
    await expect(page.getByText("Not saved yet", { exact: true })).toHaveCount(0);

    // The same boxes as in the view (the editor's grid animates its items for about 200 ms, so look until they settle).
    await expect(async () => {
      expect(farthest(await boxesIn(editGrid, [FIRST, SECOND]), viewBoxes), "editor boxes against view boxes (px)").toBeLessThanOrEqual(1);
    }).toPass({ timeout: 10_000 });
    await expect(save).toBeDisabled();
    await expect(page.getByText("Not saved yet", { exact: true })).toHaveCount(0);

    // Looking and opening the editor stored nothing.
    expect(writes, "no write on a view-only visit or on opening the editor").toEqual([]);
    const untouched = await getJson<ApiDashboard>(page, `/api/dashboards/${made.id}`);
    expect(untouched.updated_at).toBe(stored.updated_at);
    expect(untouched.widgets.map((w) => w.y)).toEqual([0, 6]);

    // A real change: delete the first widget; the second moves to the top and Save stores that.
    await page.getByRole("button", { name: `Delete ${FIRST}`, exact: true }).click();
    await expect(region(page, FIRST)).toHaveCount(0);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible(); // back in the view
    await expect(region(viewGrid, SECOND)).toBeVisible();
    await expect(region(page, FIRST)).toHaveCount(0);
    const [after] = await boxesIn(viewGrid, [SECOND]);
    expect(after.y, "the remaining widget starts at the grid's top edge").toBeLessThanOrEqual(1);

    const saved = await getJson<ApiDashboard>(page, `/api/dashboards/${made.id}`);
    expect(saved.widgets).toHaveLength(1);
    expect(saved.widgets[0]).toMatchObject({ title: SECOND, x: 0, y: 0 });
    expect(writes, "one save, nothing else").toEqual([`PUT /api/dashboards/${made.id}`]);
  });

  // sim has nine unmapped kW points (LVP02_kW ... LVP10_kW) on a fresh journey; the next two steps map three of them and the
  // afterEach above frees them again, so a rerun finds them. (Not rerunnable after a run that was killed before its afterEach.)
  const sim = (await getJson<ApiSource[]>(page, "/api/sources")).find((s) => s.name === "sim");
  expect(sim, "the source sim from the journey").toBeTruthy();
  const points = await getJson<ApiPoint[]>(page, `/api/sources/${sim!.id}/points`);
  const free = points.filter((p) => p.mapping === null && p.unit_hint === "kW");
  expect(free.length, "unmapped kW points of sim").toBeGreaterThanOrEqual(3);
  const [pointA, pointB, pointC] = free;

  const room = await createAsset(`W3b-Room-${RUN}`, root?.id ?? null, "Room");
  const meterA = await createAsset(`W3b-Meter-A-${RUN}`, room.id, "generic");
  const meterB = await createAsset(`W3b-Meter-B-${RUN}`, room.id, "generic");

  await test.step("roll-up: a room without a power meter shows the sum of its sub-assets' meters", async () => {
    await mapPower(pointA, meterA);
    await mapPower(pointB, meterB);
    // The collector picks the new mappings up within seconds; wait until both meters have a fresh reading, then look at the page.
    await expect.poll(async () => {
      const sources = (await getJson<ApiSummary>(page, `/api/assets/${room.id}/summary`)).power_rollup?.sources ?? [];
      return sources.length === 2 && sources.every((s) => s.value !== null && !s.stale);
    }, { timeout: 90_000, intervals: [2000], message: "both meters below the room report" }).toBe(true);

    await page.goto(`/assets/${room.id}`);
    await expect(page.getByRole("heading", { name: room.name, exact: true })).toBeVisible();
    const livePower = page.locator(".tile").filter({ hasText: "Live power" }).locator(".big");
    await expect(livePower).toHaveText(/^-?\d+\.\d{2} kW$/);
    const note = page.getByText("Sum of the live power of 2 meters below", { exact: true });
    await expect(note).toBeVisible({ timeout: 30_000 });
    await expect(note).toHaveAttribute("title", /^This asset has no power meter of its own/);
  });

  await test.step("trend: the chart says when it was updated, the text moves, and a mouse resting on it pauses it", async () => {
    await page.goto(`/assets/${mv2!.id}`);
    await page.mouse.move(0, 0); // a cursor resting on the chart pauses the refetch
    const updated = page.getByText(/^updated \d{2}:\d{2}:\d{2}/);
    await expect(updated).toBeVisible({ timeout: 30_000 });
    await expect(updated).toHaveText(/^updated \d{2}:\d{2}:\d{2}$/);
    const before = (await updated.textContent())!;
    // The 1h range refetches every 10 s, so the time changes.
    await expect(updated).not.toHaveText(before, { timeout: 30_000 });

    // A real mouse over the chart says it is paused; moving away resumes.
    const trend = page.getByRole("region", { name: "Trend", exact: true });
    await trend.hover();
    await expect(updated).toContainText("(paused while you point at the chart)");
    await page.mouse.move(0, 0);
    await expect(updated).toHaveText(/^updated \d{2}:\d{2}:\d{2}$/);
    await trend.screenshot({ path: "test-results/w3b-trend.png" });
  });

  await test.step("long names: a bar chart and a time series on assets with a 45-character name", async () => {
    expect(LONG_NAME).toHaveLength(45);
    const longAsset = await createAsset(LONG_NAME, room.id, "generic");
    await mapPower(pointC, longAsset);
    await expect.poll(async () => {
      const metrics = (await getJson<ApiSummary>(page, `/api/assets/${longAsset.id}/summary`)).metrics;
      return metrics.find((m) => m.metric === "active_power_kw")?.value ?? null;
    }, { timeout: 90_000, intervals: [2000], message: "the long-named asset has a reading" }).not.toBeNull();

    const config = { assets: [meterA.id, meterB.id, longAsset.id], source: "metric", metric: "active_power_kw", aggregation: "avg", range: null };
    const made = await createDashboard(page, `W3b long names ${RUN}`, "1h", [
      { type: "bar", title: BAR, config, x: 0, y: 0, w: 6, h: 5 },
      { type: "timeseries", title: SERIES, config, x: 6, y: 0, w: 6, h: 5 },
    ]);
    await page.goto(`/dashboards/${made.id}`);
    for (const title of [BAR, SERIES]) {
      await expect(region(page, title)).toBeVisible();
      await expect(region(page, title).getByText("loading…", { exact: true })).toHaveCount(0);
      await expect(region(page, title).getByRole("alert")).toHaveCount(0);
    }
    await expect(page.getByRole("alert")).toHaveCount(0);
    // A chart is drawn on a canvas: look at the picture only once both have one.
    for (const title of [BAR, SERIES]) await expect(region(page, title).locator("canvas")).toBeVisible();
    // The charts draw to canvas: the controller looks at the picture (the shortening itself is covered by the option-level tests).
    await page.mouse.move(0, 0);
    await page.screenshot({ path: "test-results/w3b-longnames.png", fullPage: true });
  });
});
