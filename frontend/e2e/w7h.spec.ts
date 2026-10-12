import { expect, test, type Browser, type Page, type Route } from "@playwright/test";
import { userBlock } from "./shell";

// W7h (a real first-load screen) on the state the earlier projects leave behind: admin `admin` / `correct-horse`. Nothing is created; the one
// thing the spec changes is the admin's look (Light and Navy and gold is put back in afterAll, which is what a re-run and the later gallery
// expect). The admin signs in through the API: the sign-in page is what is tested only in the deep-link test.
//
// Two copies of the shell stand in for the real one while the page starts, and they are told apart by the `hidden` attribute that only the
// copy in index.html carries: `.sk-shell[hidden]` is the static copy (painted before any script runs), `.sk-shell:not([hidden])` is React's
// skeleton (while the two auth requests are out), `.shell:not(.sk-shell)` is the real shell. A test that means one of them says which.
//
// The static copy is looked at by holding the app's script (`**/assets/index-*.js`, which is every file whose name starts with `index-`) with
// `page.route` and going to the page with `waitUntil: "commit"` (DOMContentLoaded would wait for the held module). The skeleton is looked at by
// holding `/api/me`. Geometry is compared copy against real shell to 0.5 px: the bar height, the sidebar width and the top-left corner of
// `main`; the colours are compared with the look's own tokens (read through a probe on <html>), so the spec pins the wiring and not the palette.
//
// What the recorder inside the page keeps (as in w7e and w7f, because a flash of one frame is missed by polling): the order of the shell states
// (static, skeleton, real, none), how many frames showed a bar in each, how many frames had none after the first, and the loading bar (how many
// `.top-progress` elements there were, its phases, and its width while it ran).
//
// The security policy is Report-Only: a violation is a console message and a `securitypolicyviolation` event, and every page of this spec is
// listened to (`watchPolicy`); the listener is proved to see a deliberate violation in the last test.

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse" };
interface Look { mode: "light" | "dark"; theme: string }
const DEFAULT_LOOK: Look = { mode: "light", theme: "navy-gold" };
const NEAR = 0.5; // px: how far the copy may sit from the real shell
const APP_SCRIPT = "**/assets/index-*.js";
const MIRROR_KEY = "dcdash.appearance"; // the browser-side copy of the look, read by theme-init.js before the first paint
const SIDEBAR_KEY = "dcdash.sidebar";
const POLICY = /Content Security Policy|\[Report Only\]/;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Setup {
  width?: number;
  /** false: a visitor with no session (the default is the signed-in admin). */
  signedIn?: boolean;
  /** Stored on the account AND mirrored in localStorage, the two places the first paint and the real shell read the look from. */
  look?: Look;
  /** The remembered sidebar state in localStorage. */
  sidebar?: "minimized";
  reducedMotion?: boolean;
}

/** Everything the spec learns about the CSP while a page runs: a deliberate violation is the one thing that may be in it. */
async function watchPolicy(page: Page): Promise<string[]> {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (POLICY.test(message.text())) violations.push(`console ${message.type()}: ${message.text()}`);
  });
  // A binding survives navigations (window state does not), as in headers.spec.
  await page.exposeFunction("reportCspViolation", (text: string) => {
    violations.push(`securitypolicyviolation: ${text}`);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { reportCspViolation: (text: string) => void }).reportCspViolation(
        `${event.disposition} ${event.violatedDirective} blocked=${event.blockedURI || "inline"} on ${event.documentURI}`,
      );
    });
  });
  return violations;
}

/** Runs `use` on a page of a fresh browser context (so a hold, a recorder or a remembered state never leaks), and fails if the page broke the policy. */
async function withPage<T>(browser: Browser, setup: Setup, use: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: setup.width ?? 1440, height: 900 },
    reducedMotion: setup.reducedMotion ? "reduce" : "no-preference",
  });
  try {
    const page = await context.newPage();
    const violations = await watchPolicy(page);
    if (setup.signedIn !== false) {
      const login = await page.request.post("/api/login", { data: ADMIN });
      expect(login.ok(), `signing in: ${login.status()}`).toBe(true);
    }
    if (setup.look) {
      const saved = await page.request.put("/api/me/preferences", { data: setup.look });
      expect(saved.ok(), `storing ${JSON.stringify(setup.look)}: ${saved.status()} ${await saved.text()}`).toBe(true);
      await page.addInitScript(([key, value]: string[]) => { try { localStorage.setItem(key, value); } catch { /* blocked storage */ } }, [MIRROR_KEY, JSON.stringify(setup.look)]);
    }
    if (setup.sidebar) {
      await page.addInitScript(([key, value]: string[]) => { try { localStorage.setItem(key, value); } catch { /* blocked storage */ } }, [SIDEBAR_KEY, setup.sidebar]);
    }
    const result = await use(page);
    expect(violations, "no Content-Security-Policy violation on this page").toEqual([]);
    return result;
  } finally {
    await context.close();
  }
}

/**
 * Keeps the answer to every request for `path` back until `release()`, then answers it (and every later request for the path) with the real
 * one. The routes wait on one gate, so there is nothing to unroute.
 */
async function hold(page: Page, path: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url: URL) => url.pathname === path, async (route: Route) => {
    await gate;
    await route.continue().catch(() => undefined); // the page may be gone by now
  });
  return { release };
}

/** Keeps the app's script back until `release()` (the static copy is then the only thing on the page) or, with `forMs`, for that long. */
async function holdScript(page: Page, forMs?: number) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(APP_SCRIPT, async (route: Route) => {
    await (forMs === undefined ? gate : sleep(forMs));
    await route.continue().catch(() => undefined);
  });
  return { release };
}

/** The first stylesheet has been applied: before that the UA's `[hidden]` alone hides the static copy, which would make a "hidden" check mean nothing. */
const sheetLoaded = (page: Page) =>
  page.waitForFunction(() => !!document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')?.sheet);

const html = (page: Page) => page.locator("html");
const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const loadingStatus = (page: Page) => page.getByRole("status").filter({ hasText: /^Loading$/ });
/** The static copy, which has the `hidden` attribute (and is shown by the stylesheet anyway), and React's skeleton, which has none. */
const staticCopy = (page: Page) => page.locator(".sk-shell[hidden]");
const skeletonShell = (page: Page) => page.locator(".sk-shell:not([hidden])");

/** Two animation frames: whatever the page does about a changed layout has happened by then. */
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** The colour a token has in the page's current look, as the browser prints a computed colour (rgb(...)). */
function tokenColour(page: Page, token: string): Promise<string> {
  return page.evaluate((name: string) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.documentElement.appendChild(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);
}

/** A length token of <html> in pixels. */
function tokenPx(page: Page, token: string): Promise<number> {
  return page.evaluate((name: string) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)), token);
}

interface Frame { barHeight: number; sideWidth: number; mainX: number; mainY: number; barBg: string; sideBg: string }

/** The three numbers the hand-over must not change, and the two grounds. */
function frameOf(page: Page): Promise<Frame> {
  return page.evaluate(() => {
    const pick = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`nothing matches ${selector}`);
      return el;
    };
    const bar = pick(".navbar");
    const side = pick(".frame > .side");
    const main = pick(".frame > main").getBoundingClientRect();
    return {
      barHeight: bar.getBoundingClientRect().height,
      sideWidth: side.getBoundingClientRect().width,
      mainX: main.left,
      mainY: main.top,
      barBg: getComputedStyle(bar).backgroundColor,
      sideBg: getComputedStyle(side).backgroundColor,
    };
  });
}

function expectSameFrame(copy: Frame, real: Frame, what: string): void {
  for (const key of ["barHeight", "sideWidth", "mainX", "mainY"] as const) {
    expect(Math.abs(copy[key] - real[key]), `${what}: ${key} ${copy[key]} against ${real[key]}`).toBeLessThanOrEqual(NEAR);
  }
  expect(copy.barBg, `${what}: the top bar's ground`).toBe(real.barBg);
  expect(copy.sideBg, `${what}: the sidebar's ground`).toBe(real.sideBg);
}

/** The bar and the sidebar are the look's own navy (token colours), the right height and width. */
async function expectFrame(page: Page, frame: Frame, sidebar: "expanded" | "minimized", what: string): Promise<void> {
  expect(frame.barBg, `${what}: the top bar is --top-bg`).toBe(await tokenColour(page, "--top-bg"));
  expect(frame.sideBg, `${what}: the sidebar is --side-bg`).toBe(await tokenColour(page, "--side-bg"));
  expect(Math.abs(frame.barHeight - (await tokenPx(page, "--bar-h"))), `${what}: bar height`).toBeLessThanOrEqual(NEAR);
  const width = await tokenPx(page, sidebar === "expanded" ? "--side-w-open" : "--side-w-closed");
  expect(Math.abs(frame.sideWidth - width), `${what}: sidebar width ${frame.sideWidth} against ${width}`).toBeLessThanOrEqual(NEAR);
  expect(Math.abs(frame.mainX - frame.sideWidth), `${what}: main starts where the sidebar ends`).toBeLessThanOrEqual(NEAR);
  expect(Math.abs(frame.mainY - frame.barHeight), `${what}: main starts under the bar`).toBeLessThanOrEqual(NEAR);
}

/** Whether the navy placeholders could shine: a running animation inside a shell copy, or an `::after` (the sweep) that is not switched off. */
function shining(page: Page): Promise<{ animations: number; sweeps: number }> {
  return page.evaluate(() => {
    const shell = document.querySelector(".sk-shell");
    const animations = document.getAnimations().filter((a) => {
      const target = (a.effect as KeyframeEffect | null)?.target;
      return !!shell && !!target && shell.contains(target);
    }).length;
    const sweeps = [...document.querySelectorAll(".sk-shell .sk")].filter((el) => getComputedStyle(el, "::after").display !== "none").length;
    return { animations, sweeps };
  });
}

// The recorder. `states` is the order in which `#root` held a static copy, React's skeleton, the real shell, or no shell at all (only noted
// once a shell has been there); `frames` counts the animation frames that had a visible top bar, by state; `blank` the frames after the first
// of those that had none; `bar` the loading bar (`nodes` distinct `.top-progress` elements, `phases` in order, `runs` its width and opacity
// in every frame of its `run` phase).
interface ShellRecord {
  states: string[];
  frames: Record<string, number>;
  blank: number;
  bar: { nodes: number; phases: string[]; runs: { width: number; opacity: number }[] };
}
type WithShell = Window & { __w7h: ShellRecord; __w7hBar?: Element };

/** Starts recording in the document it runs in. For `addInitScript` (every document from now on). */
function recordShell(): void {
  const record: ShellRecord = { states: [], frames: {}, blank: 0, bar: { nodes: 0, phases: [], runs: [] } };
  (window as unknown as WithShell).__w7h = record;
  const stateOf = (): string => {
    const shell = document.querySelector("#root .shell");
    if (!shell) return "none";
    if (!shell.classList.contains("sk-shell")) return "real";
    return shell.hasAttribute("hidden") ? "static" : "skeleton";
  };
  const note = () => {
    const state = stateOf();
    if (state === "none" && record.states.length === 0) return; // the parser has not reached #root yet
    if (record.states[record.states.length - 1] !== state) record.states.push(state);
  };
  const seen = new WeakSet<Element>();
  const lookAtBar = () => {
    const el = document.querySelector(".top-progress");
    if (!el || seen.has(el)) return;
    seen.add(el);
    record.bar.nodes += 1;
    if (record.bar.nodes === 1) (window as unknown as WithShell).__w7hBar = el;
    const phase = () => {
      const now = el.getAttribute("data-phase") ?? "";
      if (record.bar.phases[record.bar.phases.length - 1] !== now) record.bar.phases.push(now);
    };
    phase();
    new MutationObserver(phase).observe(el, { attributes: true, attributeFilter: ["data-phase"] });
  };
  new MutationObserver(() => { note(); lookAtBar(); }).observe(document, { childList: true, subtree: true });
  let painted = false;
  const frame = () => {
    note();
    lookAtBar();
    const navbar = document.querySelector("#root .navbar");
    if (navbar && navbar.getBoundingClientRect().height > 0) {
      painted = true;
      const state = stateOf();
      record.frames[state] = (record.frames[state] ?? 0) + 1;
    } else if (painted) {
      record.blank += 1;
    }
    const bar = document.querySelector(".top-progress");
    const fill = bar?.firstElementChild;
    if (bar && fill && bar.getAttribute("data-phase") === "run" && record.bar.runs.length < 4000) {
      record.bar.runs.push({ width: fill.getBoundingClientRect().width, opacity: Number(getComputedStyle(fill).opacity) });
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const watchShell = (page: Page) => page.addInitScript(recordShell);
const shellRecord = (page: Page) => page.evaluate(() => (window as unknown as WithShell).__w7h);
/** The states so far; [] while a navigation has no document to ask (a poll must not throw). */
const statesOf = async (page: Page) => (await shellRecord(page).catch(() => undefined))?.states ?? [];
const barPhase = (page: Page) => page.evaluate(() => document.querySelector(".top-progress")?.getAttribute("data-phase") ?? "");
const framesPainted = (record: ShellRecord) => Object.values(record.frames).reduce((sum, n) => sum + n, 0);

/** Waits until the loading bar has run and is idle again (the page behind the shell has finished loading). */
async function expectBarIdle(page: Page): Promise<void> {
  await expect.poll(async () => (await shellRecord(page)).bar.phases.includes("run"), { message: "the bar ran", timeout: 15_000 }).toBe(true);
  await expect.poll(async () => (await shellRecord(page)).bar.phases.at(-1), { message: "the bar is idle again", timeout: 15_000 }).toBe("idle");
}

test.describe.serial("W7h: the first-load screen", () => {
  test.afterAll(async ({ browser }) => {
    await withPage(browser, { look: DEFAULT_LOOK }, async () => undefined); // Light and Navy and gold, which is what a re-run and the later gallery expect
  });

  test("(a) the HTML the server sends already holds the shell, and the response carries the security headers", async ({ request }) => {
    for (const path of ["/", "/assets/1", "/login"]) {
      const response = await request.get(path);
      expect(response.ok(), path).toBe(true);
      const body = await response.text();
      expect(body.split('class="shell sk-shell"').length - 1, `${path}: exactly one static shell`).toBe(1);
      expect(body, `${path}: the copy is hidden until the stylesheet shows it`).toMatch(/<div class="shell sk-shell"[^>]* hidden>/);
      expect(body, `${path}: classes only, no style attribute`).not.toContain(" style=");
      const at = (needle: string) => body.indexOf(needle);
      expect(at('<script src="/theme-init.js">'), `${path}: theme-init.js first`).toBeGreaterThan(-1);
      expect(at('<script src="/theme-init.js">'), `${path}: before the shell`).toBeLessThan(at('class="shell sk-shell"'));
      expect(body, `${path}: the app's script is a module (deferred), so the copy is parsed and painted before it runs`).toMatch(/<script type="module"[^>]*src="\/assets\/index-[^"]+\.js"/);
      expect(body, `${path}: a stylesheet in the head`).toMatch(/<link rel="stylesheet"[^>]*href="\/assets\/index-[^"]+\.css"/);
      const headers = response.headers(); // names are lower case
      expect(headers["content-security-policy-report-only"], `${path}: content-security-policy-report-only`).toContain("script-src 'self'");
      expect(headers["x-content-type-options"], `${path}: x-content-type-options`).toBe("nosniff");
    }
  });

  test("(b) with /api/me held the page shows the navy bar, the sidebar and one Loading status; the real shell takes over without moving anything", async ({ browser }) => {
    test.setTimeout(120_000);
    for (const width of [1440, 1024]) {
      await test.step(`${width} px`, async () => {
        await withPage(browser, { width }, async (page) => {
          await watchShell(page);
          const me = await hold(page, "/api/me");
          await page.goto("/assets");

          await expect(skeletonShell(page)).toHaveCount(1);
          await expect(skeletonShell(page)).toBeVisible();
          await expect(page.getByRole("status"), "the shell skeleton is the page's only status").toHaveCount(1);
          await expect(loadingStatus(page)).toHaveAttribute("aria-busy", "true");
          await expect(page.locator(".sk-region"), "the shell's status is not a W7f skeleton region (their clock must not see it)").toHaveCount(0);
          await expect(page.getByText("loading…"), "no bare loading line").toHaveCount(0);
          await expect(page.locator(".navbar")).toBeVisible();
          await expect(page.locator(".frame > .side")).toBeVisible();
          await page.waitForFunction(() => document.querySelector(".top-progress")?.getAttribute("data-phase") === "run", undefined, { polling: "raf", timeout: 10_000 });
          expect(await page.locator(".top-progress").count(), "one loading bar during the wait").toBe(1);
          expect(await shining(page), "the navy placeholders do not shine").toEqual({ animations: 0, sweeps: 0 });

          const waiting = await frameOf(page);
          await expectFrame(page, waiting, width < 1180 ? "minimized" : "expanded", `${width} px, waiting`);

          me.release();
          await expect(userBlock(page)).toContainText(ADMIN.username);
          await expect(page.locator(".sk-shell"), "the skeleton is gone").toHaveCount(0);
          await expect(loadingStatus(page), "so is its status").toHaveCount(0);
          await expect(page.locator(".frame > main")).toBeVisible();
          expectSameFrame(waiting, await frameOf(page), `${width} px, skeleton against the real shell`);

          await expectBarIdle(page);
          const record = await shellRecord(page);
          expect(record.states, "skeleton then real shell, never an empty #root").not.toContain("none");
          expect(record.states.at(-1)).toBe("real");
          expect(record.blank, "no frame without a top bar between the first paint and the end").toBe(0);
          expect(record.bar.nodes, "one loading bar for the whole run").toBe(1);
          expect(await page.evaluate(() => document.querySelector(".top-progress") === (window as unknown as WithShell).__w7hBar && document.querySelectorAll(".top-progress").length === 1), "and it is the same element").toBe(true);
          const first = record.bar.phases.indexOf("run");
          expect(first, "the bar ran").toBeGreaterThanOrEqual(0);
          expect(record.bar.phases.slice(first), "never back to reset after it first ran").not.toContain("reset");
          const widths = record.bar.runs.map((r) => r.width);
          expect(widths.length, "sampled while it ran").toBeGreaterThanOrEqual(3);
          widths.forEach((w, i) => { if (i > 0) expect(w, `the bar's width never drops (frame ${i})`).toBeGreaterThanOrEqual(widths[i - 1] - 1); });
        });
      });
    }
  });

  test("(c) the static copy alone, before any script runs: the same navy and widths as the real shell, in several looks, minimized and narrow", async ({ browser }) => {
    test.setTimeout(240_000);
    const cases: { name: string; setup: Setup; look: Look; sidebar: "expanded" | "minimized" }[] = [
      { name: "light, navy and gold, 1440", setup: {}, look: DEFAULT_LOOK, sidebar: "expanded" },
      { name: "dark, navy and gold, 1440", setup: {}, look: { mode: "dark", theme: "navy-gold" }, sidebar: "expanded" },
      { name: "light, maroon and gold, 1440", setup: {}, look: { mode: "light", theme: "maroon-gold" }, sidebar: "expanded" },
      { name: "dark, maroon and gold, 1440", setup: {}, look: { mode: "dark", theme: "maroon-gold" }, sidebar: "expanded" },
      { name: "minimized (remembered), 1440", setup: { sidebar: "minimized" }, look: DEFAULT_LOOK, sidebar: "minimized" },
      { name: "narrow, 1024", setup: { width: 1024 }, look: DEFAULT_LOOK, sidebar: "minimized" },
    ];
    for (const { name, setup, look, sidebar } of cases) {
      await test.step(name, async () => {
        await withPage(browser, { ...setup, look }, async (page) => {
          const script = await holdScript(page);
          await page.goto("/assets", { waitUntil: "commit" });
          await sheetLoaded(page);

          await expect(staticCopy(page), "the static copy shows although it has the hidden attribute").toBeVisible();
          await expect(skeletonShell(page), "React has not run").toHaveCount(0);
          await expect(html(page)).toHaveAttribute("data-shell", sidebar);
          await expect(html(page)).toHaveAttribute("data-mode", look.mode);
          await expect(html(page)).toHaveAttribute("data-theme", look.theme);
          expect(await shining(page), "no shine on the copy").toEqual({ animations: 0, sweeps: 0 });
          const painted = await frameOf(page);
          await expectFrame(page, painted, sidebar, `${name}, static copy`);

          script.release();
          await expect(userBlock(page)).toContainText(ADMIN.username);
          await expect(page.locator(".sk-shell")).toHaveCount(0);
          await expect(html(page)).toHaveAttribute("data-mode", look.mode); // the account's look is the mirrored one
          await expect(html(page)).toHaveAttribute("data-theme", look.theme);
          await settled(page);
          expectSameFrame(painted, await frameOf(page), `${name}, static copy against the real shell`);
        });
      });
    }
  });

  test("(d) the sign-in and setup pages show no shell, before or after the script", async ({ browser }) => {
    test.setTimeout(120_000);
    await withPage(browser, { signedIn: false }, async (page) => {
      const script = await holdScript(page);
      await test.step("control: a page with a shell shows the copy once the stylesheet is in", async () => {
        await page.goto("/assets", { waitUntil: "commit" });
        await sheetLoaded(page);
        await expect(html(page)).toHaveAttribute("data-shell", "expanded");
        await expect(staticCopy(page)).toBeVisible();
        expect(await staticCopy(page).evaluate((el) => getComputedStyle(el).display)).toBe("flex");
      });
      for (const path of ["/login", "/Login", "/login/", "/setup", "/Setup"]) {
        await test.step(`${path}, script held`, async () => {
          await page.goto(path, { waitUntil: "commit" });
          await sheetLoaded(page);
          expect(await html(page).getAttribute("data-shell"), "theme-init.js sets no data-shell here").toBeNull();
          expect(await staticCopy(page).evaluate((el) => getComputedStyle(el).display), "the copy is display: none").toBe("none");
          await expect(page.locator(".navbar")).not.toBeVisible();
        });
      }
      script.release();
    });

    await withPage(browser, { signedIn: false }, async (page) => {
      await watchShell(page);
      for (const path of ["/login", "/setup"]) {
        await test.step(`${path}, the app running: no frame ever showed a shell`, async () => {
          await page.goto(path);
          await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
          if (path === "/setup") await expect(heading1(page, "Sign in")).toBeVisible(); // setup is done, so it goes on to the sign-in page
          await settled(page);
          const record = await shellRecord(page);
          expect(framesPainted(record), `frames with a top bar on ${path}: ${JSON.stringify(record.frames)}`).toBe(0);
          expect(record.states, "the real shell never rendered").not.toContain("real");
        });
      }
    });
  });

  test("(e) a deep link while signed out goes to the sign-in page without a flash of the real shell, and signing in lands on that page", async ({ browser }) => {
    test.setTimeout(120_000);
    await withPage(browser, { signedIn: false }, async (page) => {
      await watchShell(page);
      await page.goto("/dashboards?w7h=1");
      await expect(page).toHaveURL(/\/login$/);
      await expect(heading1(page, "Sign in")).toBeVisible();
      await settled(page);
      const record = await shellRecord(page);
      expect(record.states, `signed out: static copy and skeleton at most, never the real shell (${record.states.join(" > ")})`).not.toContain("real");
      await expect(page.locator(".navbar"), "the sign-in page has no top bar").toHaveCount(0);

      await page.getByLabel("Username").fill(ADMIN.username);
      await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).toHaveURL(/\/dashboards\?w7h=1$/);
      await expect(heading1(page, "Dashboards")).toBeVisible();
      await expect(userBlock(page)).toContainText(ADMIN.username);
      await expect(page.locator(".sk-shell")).toHaveCount(0);
    });
  });

  test("(f) a slow start never shows an empty page: static copy, then the skeleton, then the real shell, with no frame without a top bar", async ({ browser }) => {
    test.setTimeout(120_000);
    await withPage(browser, { width: 1440 }, async (page) => {
      await watchShell(page);
      await page.goto("/assets");
      await expect(userBlock(page)).toContainText(ADMIN.username); // a first, normal load: warm caches, the stored look in place

      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await holdScript(page, 700); // the script is late, so the static copy is on screen for a while
      const me = await hold(page, "/api/me"); // and the auth check is slow, so the skeleton is too
      await page.reload({ waitUntil: "commit" });

      await expect.poll(() => statesOf(page), { message: "the static copy, then React's skeleton", timeout: 20_000 }).toEqual(["static", "skeleton"]);
      await sleep(600);
      me.release();
      await expect(userBlock(page)).toContainText(ADMIN.username);
      await expect(page.locator(".sk-shell")).toHaveCount(0);
      await settled(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

      const record = await shellRecord(page);
      expect(record.states, "in this order, and no empty #root in between").toEqual(["static", "skeleton", "real"]);
      expect(record.blank, "frames after the first paint that had no top bar").toBe(0);
      expect(record.frames.static ?? 0, "the static copy was painted").toBeGreaterThan(0);
      expect(record.frames.skeleton ?? 0, "so was the skeleton").toBeGreaterThan(0);
      expect(record.frames.real ?? 0, "and the real shell").toBeGreaterThan(0);
    });
  });

  test("(g) with reduced motion nothing sweeps, and the loading bar is a full line", async ({ browser }) => {
    test.setTimeout(120_000);
    await withPage(browser, { reducedMotion: true }, async (page) => {
      await watchShell(page);
      const me = await hold(page, "/api/me");
      await page.goto("/assets");
      await expect(skeletonShell(page)).toBeVisible();
      await page.waitForFunction(() => document.querySelector(".top-progress")?.getAttribute("data-phase") === "run", undefined, { polling: "raf", timeout: 10_000 });
      await sleep(300);
      expect(await shining(page), "no sweep on the skeleton").toEqual({ animations: 0, sweeps: 0 });
      expect(await barPhase(page)).toBe("run");
      me.release();
      await expect(userBlock(page)).toContainText(ADMIN.username);
      await expectBarIdle(page);

      const record = await shellRecord(page);
      const width = await page.evaluate(() => document.documentElement.clientWidth);
      expect(record.bar.runs.length, "sampled while it ran").toBeGreaterThanOrEqual(3);
      for (const sample of record.bar.runs) {
        expect(Math.abs(sample.width - width), "the line is the viewport wide").toBeLessThanOrEqual(1);
        expect(sample.opacity).toBe(1);
      }
      expect(record.blank).toBe(0);
    });
  });

  test("(h) the policy listener sees a deliberate violation (so that the silence in every other test means something)", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      const violations = await watchPolicy(page);
      await page.goto("/login");
      await expect(heading1(page, "Sign in")).toBeVisible();
      expect(violations, "a plain visit to the sign-in page breaks no policy").toEqual([]);
      await page.evaluate(() => {
        const script = document.createElement("script");
        script.textContent = "window.__probe = 1"; // an inline script: script-src 'self' forbids it
        document.head.append(script);
      });
      await expect.poll(() => violations.some((v) => v.startsWith("securitypolicyviolation:")), { message: "the event listener" }).toBe(true);
      await expect.poll(() => violations.some((v) => v.startsWith("console ")), { message: "the console listener" }).toBe(true);
    } finally {
      await context.close();
    }
  });
});
