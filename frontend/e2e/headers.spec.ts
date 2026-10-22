import { expect, test } from "@playwright/test";
import { roleLabel } from "./roles";
import { markGuideSeen, userBlock } from "./shell";

test.beforeEach(({ page }) => markGuideSeen(page)); // w27: the dashboard guide is not what this spec looks at

// Security headers (deploy/security-headers.caddy) on the state the journey, discovery and phase3 projects leave behind: admin
// `admin` / `correct-horse`, assets Site > Panel 01 ..., a source `sim`, the dashboard "Phase 3 overview", and a collector that has
// been polling for some minutes. The Content-Security-Policy is Report-Only, so a violation never breaks the page: it only shows up
// as a console message and a `securitypolicyviolation` event. This spec walks every page an admin can open and fails on either.

const ADMIN = { username: "admin", password: "correct-horse" };
const POLICY = /Content Security Policy|\[Report Only\]/;

interface Probe {
  __sse: { opened: number; messages: number };
  reportCspViolation: (text: string) => void;
}

test("the page and the API carry the security headers and no Server header", async ({ request }) => {
  for (const path of ["/", "/api/health"]) {
    const response = await request.get(path);
    expect(response.ok(), path).toBe(true);
    const headers = response.headers(); // names are lower case
    expect(headers["x-content-type-options"], `${path} x-content-type-options`).toBe("nosniff");
    expect(headers["x-frame-options"], `${path} x-frame-options`).toBe("DENY");
    expect(headers["referrer-policy"], `${path} referrer-policy`).toBe("same-origin");
    expect(headers["content-security-policy-report-only"], `${path} content-security-policy-report-only`).toContain("script-src 'self'");
    expect(headers, `${path}: Caddy's (or uvicorn's) Server header is removed`).not.toHaveProperty("server");
  }
});

// Static files (deploy/Caddyfile, W7i): the shell revalidates, a hashed file is compressed and cached for a year, a hashed file that is
// gone is a 404 (never the shell, never `immutable`), the SPA routes under /assets still get the shell, and an ETag earns a 304.
test("the shell revalidates, hashed files are compressed and immutable, and a missing hashed file is an uncached 404", async ({ request }) => {
  const gzip = { "Accept-Encoding": "gzip" };

  const shell = await request.get("/", { headers: gzip });
  expect(shell.status(), "/").toBe(200);
  expect(shell.headers()["cache-control"], "/ cache-control").toBe("no-cache");
  const html = await shell.text();
  const entry = /src="(\/assets\/index-[^"]+\.js)"/.exec(html)?.[1];
  expect(entry, "the entry script named in the page").toBeTruthy();

  const script = await request.get(entry!, { headers: gzip });
  expect(script.status(), entry).toBe(200);
  expect(script.headers()["cache-control"], `${entry} cache-control`).toContain("immutable");
  expect(["gzip", "zstd"], `${entry} content-encoding`).toContain(script.headers()["content-encoding"]);

  const missing = await request.get("/assets/nope.js", { headers: gzip });
  expect(missing.status(), "/assets/nope.js").toBe(404);
  expect(missing.headers()["cache-control"] ?? "", "/assets/nope.js cache-control").not.toContain("immutable");

  for (const route of ["/assets", "/assets/4"]) {
    const spa = await request.get(route, { headers: gzip }); // the Assets Tree page and an asset's page share the prefix of the hashed files
    expect(spa.status(), route).toBe(200);
    expect(spa.headers()["cache-control"], `${route} cache-control`).toBe("no-cache");
    expect(await spa.text(), `${route} is the shell`).toContain('<div id="root">');
  }

  for (const [path, answer] of [["/", shell], [entry!, script]] as const) {
    const etag = answer.headers()["etag"];
    expect(etag, `${path} etag`).toBeTruthy();
    const again = await request.get(path, { headers: { ...gzip, "If-None-Match": etag } });
    expect(again.status(), `${path} with If-None-Match`).toBe(304);
  }
});

test("every page an admin can open runs under the policy without one violation, and the live stream still delivers", async ({ page }) => {
  test.setTimeout(240_000);
  const violations: string[] = [];
  const visited: string[] = [];

  // Channel 1: the browser's console (what a person would see). Channel 2: the event, reported from inside the page by a binding
  // that survives navigations (window state does not, so the page cannot keep the list itself).
  // Any message type: Chromium logs a Report-Only violation as `info` (RUN against the real header: "Executing inline script violates the
  // following Content Security Policy directive ... The policy is report-only"), an enforced one as `error`.
  page.on("console", (message) => {
    if (POLICY.test(message.text())) {
      violations.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  await page.exposeFunction("reportCspViolation", (text: string) => {
    violations.push(`securitypolicyviolation: ${text}`);
  });
  await page.addInitScript(() => {
    const probe = window as unknown as Probe & { EventSource: typeof EventSource };
    document.addEventListener("securitypolicyviolation", (event) => {
      probe.reportCspViolation(
        `${event.disposition} ${event.violatedDirective} (${event.effectiveDirective}) blocked=${event.blockedURI || "inline"} ` +
          `at ${event.sourceFile || event.documentURI}:${event.lineNumber} on ${event.documentURI}`,
      );
    });
    // Counts what the live stream delivers: how many EventSources the page opened and how many messages they received.
    probe.__sse = { opened: 0, messages: 0 };
    const Native = window.EventSource;
    probe.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        probe.__sse.opened += 1;
        this.addEventListener("message", () => {
          probe.__sse.messages += 1;
        });
      }
    };
  });

  const settled = async (path: string, heading?: string) => {
    await page.goto(path);
    await expect(heading ? page.getByRole("heading", { name: heading, exact: true }) : page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForLoadState("load");
    await expect(page.locator(".sk-region")).toHaveCount(0); // a loading skeleton shows the heading too (W7f): wait for the data
    await page.waitForTimeout(500); // late work: data-driven rendering, charts, fonts
    visited.push(path);
  };

  await test.step("the listeners see a deliberate violation (so that a silent walk below means something)", async () => {
    await settled("/login", "Sign in");
    await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.__probe = 1"; // an inline script: script-src 'self' forbids it
      document.head.append(script);
    });
    await expect.poll(() => violations.some((v) => v.startsWith("securitypolicyviolation:")), { message: "the event listener" }).toBe(true);
    await expect.poll(() => violations.some((v) => v.startsWith("console ")), { message: "the console listener" }).toBe(true);
    violations.length = 0;
    visited.length = 0;
  });

  await test.step("the admin signs in", async () => {
    await page.getByLabel("Username").fill(ADMIN.username);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(userBlock(page)).toContainText(ADMIN.username);
    await expect(userBlock(page)).toContainText(roleLabel("admin"));
  });

  const getJson = async <T>(path: string) => (await (await page.request.get(path)).json()) as T;
  const assets = await getJson<{ id: number; name: string }[]>("/api/assets");
  const sources = await getJson<{ id: number; name: string }[]>("/api/sources");
  expect(assets.length, "assets").toBeGreaterThan(0);
  expect(sources.length, "sources").toBeGreaterThan(0);
  const asset = assets.find((a) => a.name === "Panel 01") ?? assets[0]; // Panel 01 has mapped points: its page opens a stream

  await test.step("assets, an asset page", async () => {
    await settled("/assets", "Assets Tree");
    await settled(`/assets/${asset.id}`);
    await expect(page.getByRole("heading", { name: "Metrics" })).toBeVisible();
  });

  await test.step("dashboards, a dashboard page, and its live stream still delivers", async () => {
    await settled("/dashboards", "Dashboards");
    await page.getByRole("table").getByRole("link").first().click();
    await expect(page).toHaveURL(/\/dashboards\/\d+$/);
    await expect(page.getByRole("region").first()).toBeVisible();
    visited.push(new URL(page.url()).pathname);
    // EventSource is not subject to script-src; connect-src 'self' covers /api/stream. Messages mean the policy did not get in the way.
    await expect.poll(() => page.evaluate(() => (window as unknown as Probe).__sse.opened), { message: "streams opened" }).toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Probe).__sse.messages), { timeout: 45_000, message: "stream messages received" })
      .toBeGreaterThan(0);
  });

  await test.step("the other pages", async () => {
    await settled("/billing", "Billing");
    await settled("/sources", "Sources");
    await settled(`/sources/${sources[0].id}/points`, "Points");
    await settled("/scans", "Scans");
    await settled("/discovery", "Discovery");
    await settled("/users", "Users & Roles");
    await settled("/settings", "Settings");
    await settled("/tariffs", "Tariffs");
    await settled("/storage", "Storage");
    await settled("/audit", "Audit log");
    await settled("/events", "System events"); // w32
    await settled("/password", "Change password");
    await settled("/no-such-page", "Page not found");
  });

  await test.step("no console message and no event named a policy", async () => {
    await test.info().attach("visited-routes", { body: visited.join("\n"), contentType: "text/plain" }); // what "zero" covered
    expect(visited.length, "routes visited").toBe(17);
    expect(violations, `violations while visiting ${visited.join(", ")}`).toEqual([]);
  });
});
