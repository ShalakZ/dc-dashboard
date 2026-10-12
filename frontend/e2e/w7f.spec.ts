import { expect, test, type Browser, type Page, type Route } from "@playwright/test";
import { treeLink } from "./shell";

// W7f (loading skeletons) on the state the earlier projects leave behind: admin `admin` / `correct-horse`, the assets `Site` > `Panel 01` ...,
// the simulator source `sim`, a dashboard. Nothing is created; the one thing the spec changes is the admin's look (Light and Navy and gold is
// put back in afterAll, which is what a re-run and the later gallery expect). The admin signs in through the API: the sign-in page is not
// what is tested here.
//
// A skeleton is looked at by holding the request it waits for with `page.route` (`hold`) and answering it when the test says so. What it
// pins: a skeleton is ONE `role="status"` region per area (found by its label, matched exactly: "Loading the asset" is also the start of
// "Loading the asset tree"), the real content is absent while it shows and the region is gone once the data is in; it sits where the content
// will land (getBoundingClientRect, 2 px); it never flashes (a recorder inside the page, as in w7e, because a flash of 100 ms is missed
// by polling); polling never brings it back; an error replaces it; reduced motion drops the sweep but keeps the fade-in delay; dark mode
// takes the dark token. Pixel numbers are NOT pinned, only skeleton against content: a retuned layout needs no edit here.
//
// Skeleton markup is `aria-hidden`, so role queries (`getByRole("row")`, `getByRole("table")`) never see it; a CSS locator (`tbody tr`,
// `.tile`) does, and the other specs were checked for that (w3c's audit rows, w7b's rows-per-day table, headers.spec's settled()).

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse" };
interface Look { mode: "light" | "dark"; theme: string }
const DEFAULT_LOOK: Look = { mode: "light", theme: "navy-gold" };
const DARK_LOOK: Look = { mode: "dark", theme: "navy-gold" };

const NEAR = 2; // px: how far a skeleton may sit from the content that replaces it
const FADE_DELAY_MS = 150; // the region's fade-in delay (app.css): an answer faster than this shows nothing

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Signs the admin in through the API: the session cookie belongs to the page's browser context. */
async function signIn(page: Page): Promise<void> {
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in: ${login.status()}`).toBe(true);
}

/** Runs `use` on a page of a fresh browser context in which the admin is signed in. */
async function asAdmin<T>(browser: Browser, use: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    const page = await context.newPage();
    await signIn(page);
    return await use(page);
  } finally {
    await context.close();
  }
}

async function storeLook(page: Page, look: Look): Promise<void> {
  const saved = await page.request.put("/api/me/preferences", { data: look });
  expect(saved.ok(), `storing ${JSON.stringify(look)}: ${saved.status()} ${await saved.text()}`).toBe(true);
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
/** The admin's own row on the Users page (the role select's cell is named "admin" too, hence the first). */
const adminCell = (page: Page) => page.getByRole("cell", { name: ADMIN.username, exact: true }).first();
const tree = (page: Page) => page.getByRole("region", { name: "Asset tree" });
const html = (page: Page) => page.locator("html");

/** Two animation frames: whatever the page does about a changed layout has happened by then. */
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

async function setWidth(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
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

// The regions, recorded from inside the page: `added` counts every `.sk-region` that is added to the document, `maxOpacity` is the highest
// computed opacity any of them had (sampled every frame and at every insertion), `firstOpacity` the opacity at the moment each was added,
// `instant` how many were added with `data-instant` (a region that follows another skips the fade-in delay), `lifetimeMs` how long each
// lived, and `found` which of the `watch` texts main ever showed.
interface RegionRecord { added: number; maxOpacity: number; firstOpacity: number[]; instant: number; lifetimeMs: number[]; found: string[] }
type WithRecord = Window & { __w7fRegions: RegionRecord };

/** Starts recording in the document it runs in. For `addInitScript` (every document from now on) or `evaluate` (this one). */
function recordRegions(watch: string[]): void {
  const record: RegionRecord = { added: 0, maxOpacity: 0, firstOpacity: [], instant: 0, lifetimeMs: [], found: [] };
  (window as unknown as WithRecord).__w7fRegions = record;
  const started = new Map<Element, number>();
  const opacity = (el: Element) => Number(getComputedStyle(el).opacity);
  const regionsIn = (node: Node): Element[] =>
    node instanceof Element ? [...(node.matches(".sk-region") ? [node] : []), ...node.querySelectorAll(".sk-region")] : [];
  const sample = () => {
    for (const el of document.querySelectorAll(".sk-region")) record.maxOpacity = Math.max(record.maxOpacity, opacity(el));
    const text = document.querySelector("main")?.textContent ?? "";
    for (const wanted of watch) if (text.includes(wanted) && !record.found.includes(wanted)) record.found.push(wanted);
  };
  new MutationObserver((changes) => {
    const now = performance.now();
    for (const change of changes) {
      for (const node of change.addedNodes) {
        for (const el of regionsIn(node)) {
          if (started.has(el)) continue;
          started.set(el, now);
          record.added += 1;
          if (el.hasAttribute("data-instant")) record.instant += 1;
          const first = opacity(el);
          record.firstOpacity.push(first);
          record.maxOpacity = Math.max(record.maxOpacity, first);
        }
      }
      for (const node of change.removedNodes) {
        if (!(node instanceof Element)) continue;
        for (const [el, at] of started) if (node === el || node.contains(el)) { record.lifetimeMs.push(Math.round(now - at)); started.delete(el); }
      }
    }
    sample();
  }).observe(document, { childList: true, subtree: true });
  const tick = () => { sample(); requestAnimationFrame(tick); };
  tick();
}

const regionRecord = (page: Page) => page.evaluate(() => (window as unknown as WithRecord).__w7fRegions);

interface AssetBox { tileTop: number; trendTop: number; trendHeight: number }
/** Where the asset page's first tile and its trend frame are, whether they are the skeleton's or the real ones. */
const assetBox = (page: Page): Promise<AssetBox> =>
  page.evaluate(() => {
    const rect = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`nothing matches ${selector}`);
      return el.getBoundingClientRect();
    };
    return { tileTop: rect(".asset-page .tile").top, trendTop: rect(".asset-page .trend-frame").top, trendHeight: rect(".asset-page .trend-frame").height };
  });

interface SummaryBox { tileTop: number; byKindTop: number }
/** The fleet summary's first tile and its "By kind" heading (the h2 straight after the tiles; the skeleton's holds no words). */
const summaryBox = (page: Page): Promise<SummaryBox> =>
  page.evaluate(() => {
    const rect = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`nothing matches ${selector}`);
      return el.getBoundingClientRect();
    };
    return { tileTop: rect(".fleet-tiles .tile").top, byKindTop: rect(".fleet-tiles + h2").top };
  });

/** Every number of `got` within NEAR px of `want`. */
function expectNear(got: object, want: object, what: string): void {
  for (const [key, expected] of Object.entries(want) as [string, number][]) {
    const actual = (got as Record<string, number>)[key];
    expect(Math.abs(actual - expected), `${what}: ${key} is ${actual} px, the content's is ${expected} px`).toBeLessThanOrEqual(NEAR);
  }
}

test.describe("W7f: loading skeletons", () => {
  let asset = { id: 0, name: "" };

  test.beforeAll(async ({ browser }) => {
    asset = await asAdmin(browser, async (page) => {
      await storeLook(page, DEFAULT_LOOK);
      const assets = (await (await page.request.get("/api/assets")).json()) as { id: number; name: string }[];
      // An asset whose tiles carry no note line (the skeleton's tiles have none: a `.tile > small` would make the real row taller) and whose
      // Trend draws a chart (an empty range has no chart box). `.tile .big small` is the cost tile's unit, not a note.
      for (const name of ["Panel 01", "MV2", "LVP02", "LVP03"]) {
        const found = assets.find((a) => a.name === name);
        if (!found) continue;
        await page.goto(`/assets/${found.id}`);
        await expect(heading1(page, name)).toBeVisible();
        const chart = await page.locator('section[aria-label="Trend"] canvas').waitFor({ timeout: 15_000 }).then(() => true, () => false);
        const notes = await page.locator(".asset-page .tiles > .tile > small").count();
        if (chart && notes === 0) return found;
      }
      throw new Error("no asset (Panel 01, MV2, LVP02, LVP03) has a drawn Trend and tiles without a note line");
    });
  });

  test.afterAll(async ({ browser }) => {
    await asAdmin(browser, (page) => storeLook(page, DEFAULT_LOOK));
  });

  test("with the data request held, an asset page, the summary, the Dashboards list and Users show one status region and none of the content; the data replaces it", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);

    await test.step("an asset page", async () => {
      const summary = await hold(page, `/api/assets/${asset.id}/summary`);
      await page.goto(`/assets/${asset.id}`);
      await expect(skeleton(page, "Loading the asset")).toBeVisible();
      await expect(page.locator(".tile").filter({ hasText: "Live power" })).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
      summary.release();
      await expect(heading1(page, asset.name)).toBeVisible();
      await expect(page.locator(".tile").filter({ hasText: "Live power" })).toBeVisible();
      await expect(skeleton(page, "Loading the asset")).toHaveCount(0); // the chart's own region may follow, so not "no region at all"
    });

    await test.step("the summary page", async () => {
      const fleet = await hold(page, "/api/fleet/summary");
      await page.goto("/assets");
      await expect(heading1(page, "Assets")).toBeVisible(); // the header does not wait
      await expect(skeleton(page, "Loading the fleet summary")).toBeVisible();
      await expect(page.locator(".tile").filter({ hasText: "Live power" })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Needs attention" })).toHaveCount(0);
      fleet.release();
      await expect(page.locator(".tile").filter({ hasText: "Live power" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();
      await expect(skeleton(page, "Loading the fleet summary")).toHaveCount(0);
    });

    await test.step("the Dashboards list", async () => {
      const list = await hold(page, "/api/dashboards");
      await page.goto("/dashboards");
      await expect(heading1(page, "Dashboards")).toBeVisible();
      await expect(skeleton(page, "Loading dashboards")).toBeVisible();
      await expect(page.getByRole("table")).toHaveCount(0);
      list.release();
      await expect(page.getByRole("table").or(page.getByText("No dashboards yet."))).toBeVisible();
      await expect(skeleton(page, "Loading dashboards")).toHaveCount(0);
    });

    await test.step("Users", async () => {
      const users = await hold(page, "/api/users");
      await page.goto("/users");
      await expect(heading1(page, "Users")).toBeVisible();
      await expect(skeleton(page, "Loading users")).toBeVisible();
      await expect(page.getByRole("table")).toHaveCount(0);
      await expect(page.getByRole("row")).toHaveCount(0);
      users.release();
      await expect(adminCell(page)).toBeVisible();
      await expect(skeleton(page, "Loading users")).toHaveCount(0);
    });
  });

  test("the skeleton sits where the content will land: the asset page at 1440 px and the summary at 1440 and 1024 px, within 2 px", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);

    await test.step("the asset page: first tile, Trend frame (top and height), with the chart block in between", async () => {
      test.info().annotations.push({ type: "asset", description: `${asset.name} (#${asset.id})` }); // which asset was measured
      await setWidth(page, 1440);
      const summary = await hold(page, `/api/assets/${asset.id}/summary`);
      const series = await hold(page, `/api/assets/${asset.id}/series`);
      await page.goto(`/assets/${asset.id}`);
      await expect(skeleton(page, "Loading the asset")).toBeVisible();
      await settled(page);
      const asSkeleton = await assetBox(page);

      summary.release();
      await expect(page.getByRole("region", { name: "Trend", exact: true })).toBeVisible();
      await expect(skeleton(page, "Loading the chart")).toBeVisible(); // the series is still held: the real frame holds the chart block
      await settled(page);
      const withBlock = await assetBox(page);

      series.release();
      await expect(page.locator('section[aria-label="Trend"] canvas')).toBeVisible();
      await expect(skeleton(page, "Loading the chart")).toHaveCount(0);
      await settled(page);
      const loaded = await assetBox(page);

      const notes = await page.locator(".asset-page .tiles > .tile > small").count();
      expect(notes, `${asset.name}: its tiles have a note line, which the skeleton's do not have`).toBe(0);
      expectNear(asSkeleton, loaded, "the asset skeleton");
      expectNear(withBlock, loaded, "the chart block");
    });

    for (const width of [1440, 1024]) {
      await test.step(`the summary page at ${width} px: first tile and "By kind"`, async () => {
        await setWidth(page, width);
        const fleet = await hold(page, "/api/fleet/summary");
        await page.goto("/assets");
        await expect(skeleton(page, "Loading the fleet summary")).toBeVisible();
        await settled(page);
        const asSkeleton = await summaryBox(page);

        fleet.release();
        await expect(page.locator(".tile").filter({ hasText: "Live power" })).toBeVisible();
        await expect(page.locator(".fleet-tiles + h2")).toHaveText("By kind");
        await expect(skeleton(page, "Loading the fleet summary")).toHaveCount(0);
        await settled(page);
        expectNear(asSkeleton, await summaryBox(page), `the summary skeleton at ${width} px`);
      });
    }
  });

  test("the tree keeps the width the user chose while the asset list loads, and the pane beside it does not move", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.addInitScript(() => window.localStorage.setItem("dcdash.assetTreeWidth", "340"));
    const assets = await hold(page, "/api/assets");
    await page.goto("/assets");
    await expect(skeleton(page, "Loading the asset tree")).toBeVisible();
    await expect(tree(page)).toBeVisible();
    await tree(page).evaluate((el) => el.setAttribute("data-w7f", "kept")); // the same column carries on into the loaded tree
    await settled(page);
    const columns = () =>
      page.evaluate(() => ({
        tree: document.querySelector('section[aria-label="Asset tree"]')!.getBoundingClientRect().width,
        paneLeft: document.querySelector(".assets-detail")!.getBoundingClientRect().left,
      }));
    const asSkeleton = await columns();
    expect(asSkeleton.tree, "the stored width, on the skeleton column").toBeCloseTo(340, 0);

    assets.release();
    await expect(treeLink(page, "Site")).toBeVisible();
    await expect(skeleton(page, "Loading the asset tree")).toHaveCount(0);
    await expect(tree(page)).toHaveAttribute("data-w7f", "kept");
    await settled(page);
    const loaded = await columns();
    expect(loaded.tree, "the same width after the release").toBeCloseTo(asSkeleton.tree, 0);
    expect(loaded.paneLeft, "the pane has not moved").toBeCloseTo(asSkeleton.paneLeft, 0);
  });

  test("no flash: an answer within 40 ms never shows the skeleton, one that takes 600 ms shows it fading in from nothing", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const stored = await (await page.request.get("/api/users")).body(); // so the quick answer does not depend on the server's speed
    let quickAnswer = true;
    await page.route((url) => url.pathname === "/api/users", async (route) => {
      if (quickAnswer) {
        await sleep(FADE_DELAY_MS / 4);
        await route.fulfill({ status: 200, contentType: "application/json", body: stored }).catch(() => undefined);
      } else {
        await sleep(600);
        await route.continue().catch(() => undefined);
      }
    });
    await page.addInitScript(recordRegions, []);
    const admin = adminCell(page);

    await page.goto("/users"); // a fresh load of a page with one region: no earlier region makes this one instant
    await expect(admin).toBeVisible();
    const quick = await regionRecord(page);
    expect(quick.added, "the skeleton was mounted for a moment (or this proves nothing)").toBeGreaterThan(0);
    expect(quick.maxOpacity, `the skeleton stayed invisible (lived ${quick.lifetimeMs} ms)`).toBeLessThanOrEqual(0.05);

    quickAnswer = false;
    await page.reload();
    await expect(admin).toBeVisible();
    const slow = await regionRecord(page);
    expect(slow.added).toBeGreaterThan(0);
    expect(slow.instant, "a lone region waits out its delay").toBe(0);
    expect(slow.firstOpacity[0], "it came in at nothing").toBe(0);
    expect(slow.maxOpacity, `it faded all the way in (lived ${slow.lifetimeMs} ms)`).toBeGreaterThanOrEqual(0.99);
  });

  test("polling never brings the skeleton back", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    await page.goto("/assets");
    const livePower = page.locator(".fleet-tiles .tile").filter({ hasText: "Live power" });
    await expect(livePower).toBeVisible();
    await expect(skeleton(page, "Loading the fleet summary")).toHaveCount(0);

    // From here every answer to the fleet summary (refetched every 15 s) takes a second, so a refetch is under way for a good while.
    let polled = 0;
    await page.route((url) => url.pathname === "/api/fleet/summary", async (route) => {
      polled += 1;
      await sleep(1_000);
      await route.continue().catch(() => undefined);
    });
    await page.evaluate(recordRegions, []);
    await expect.poll(() => polled, { message: "the page polled the fleet summary", timeout: 25_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(2_500); // its answer arrives, and the page has had time to react
    expect((await regionRecord(page)).added, "no skeleton region was ever added during the poll").toBe(0);
    await expect(livePower).toBeVisible();
  });

  test("a failed load ends with the error, not a skeleton; a polled load that keeps failing never brings the skeleton back", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const refuse = (message: string) => (route: Route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: message }) });

    await test.step("Users: held, then answered 500 (and 500 again for the retry): the error alert replaces the region", async () => {
      const users = await hold(page, "/api/users", refuse("W7f users refused"));
      await page.goto("/users");
      await expect(skeleton(page, "Loading users")).toBeVisible();
      users.release();
      // the first load is retried once after a second; the region stays until that has failed too, so only the final state is asserted
      await expect(page.getByRole("alert").filter({ hasText: "W7f users refused" })).toBeVisible({ timeout: 5_000 });
      await expect(page.locator(".sk-region")).toHaveCount(0);
    });

    await test.step("Sources (polled every 10 s): after the first error, a whole poll adds no region and never shows the empty state", async () => {
      let requests = 0;
      await page.route((url) => url.pathname === "/api/sources", (route) => {
        requests += 1;
        return refuse("W7f sources refused")(route);
      });
      await page.goto("/sources");
      const alert = page.getByRole("alert").filter({ hasText: "W7f sources refused" });
      await expect(alert).toBeVisible({ timeout: 15_000 });
      const before = requests;
      await page.evaluate(recordRegions, ["No sources yet"]);
      // a poll is two requests: the refetch and its retry a second later; the line that says "loading…" in between is today's, not a skeleton
      await expect.poll(() => requests, { message: "the page polled the sources", timeout: 25_000 }).toBeGreaterThanOrEqual(before + 2);
      await expect(alert).toBeVisible();
      await page.waitForTimeout(500);
      const record = await regionRecord(page);
      expect(record.added, "no skeleton region after the first error").toBe(0);
      expect(record.found, "and no empty state while the list is unknown").toEqual([]);
    });
  });

  test("reduced motion: no sweep, but the fade-in delay stays (so the flash does not come back)", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    const users = await hold(page, "/api/users");
    try {
      await page.goto("/users");
      await expect(skeleton(page, "Loading users")).toBeVisible();
      const animations = () =>
        page.evaluate(() => {
          const region = document.querySelector(".sk-region")!;
          const block = region.querySelector(".sk")!;
          return {
            region: getComputedStyle(region).animationName,
            delay: getComputedStyle(region).animationDelay,
            sweep: getComputedStyle(block, "::after").animationName,
          };
        });

      await page.emulateMedia({ reducedMotion: "no-preference" });
      await expect.poll(animations, { message: "with motion: the sweep runs" }).toEqual({ region: "sk-in", delay: "0.15s", sweep: "sk-sweep" });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect.poll(animations, { message: "reduced: no sweep, the delayed fade stays" }).toEqual({ region: "sk-in", delay: "0.15s", sweep: "none" });
    } finally {
      users.release();
    }
  });

  test("dark mode: the skeleton takes the dark token", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    const users = await hold(page, "/api/users");
    const block = () => page.locator(".sk-region .sk").first();
    const background = () => block().evaluate((el) => getComputedStyle(el).backgroundColor);
    try {
      await storeLook(page, DEFAULT_LOOK);
      await page.goto("/users");
      await expect(html(page)).toHaveAttribute("data-mode", "light");
      await expect(skeleton(page, "Loading users")).toBeVisible();
      const light = { token: await tokenText(page, "--skeleton"), colour: await tokenColour(page, "--skeleton"), background: await background() };
      expect(light.background, "light: the block is the token").toBe(light.colour);

      await storeLook(page, DARK_LOOK);
      await page.reload();
      await expect(html(page)).toHaveAttribute("data-mode", "dark"); // the first paint uses the browser's remembered look until /api/me answers
      await expect(skeleton(page, "Loading users")).toBeVisible();
      const dark = { token: await tokenText(page, "--skeleton"), colour: await tokenColour(page, "--skeleton"), background: await background() };
      expect(dark.background, "dark: the block is the token").toBe(dark.colour);
      expect(dark.token, "the dark token is not the light one").not.toBe(light.token);
      expect(dark.background, "so the block looks different").not.toBe(light.background);
    } finally {
      users.release();
      await storeLook(page, DEFAULT_LOOK);
    }
  });
});
