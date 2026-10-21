import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { roleLabel } from "./roles";
import { mainNav, navLink, userBlock } from "./shell";

// W9a (roles and permissions, enforcement) on the state the earlier projects leave behind: admin `admin` / `correct-horse`. The spec
// makes its own accounts and roles through the admin API, every name starting with `w9a-`, and removes them again (users first: a role
// that an account holds cannot be deleted). beforeAll also removes what an earlier, interrupted run left behind.
//
// What it proves, in the owner's words "almost any action should be gated via a role guard": (1) each built-in role sees exactly its
// sidebar and gets `No access` on a page it lacks; (2) the API refuses what each role lacks, whatever the screen shows (the UI is never
// the only gate); (3) a custom role with one permission sees one page and lands on it; a role with no permission lands on a plain
// "no pages yet" screen; a permission taken away is noticed by an open page; (4) a role that may change users still cannot make or
// take over an Admin; (5) an Admin cannot demote, deactivate or delete itself (the self rules; the last-Admin count is covered by the backend tests),
// a role in use cannot be deleted and the built-in roles cannot be changed. The Roles tab has its own spec (w9b.spec.ts); here roles are made through the API.
//
// What a broken gate could do to the stack: the denial probes aim at id 999999 with an empty body, so a broken gate answers 404 or 422 and
// changes nothing; the escalation probes aim at a throwaway Admin (`w9a-admin2`), and the one probe at the real `admin` sends the password
// it already has; the built-in roles are only ever sent an empty PATCH (a rename would break every Viewer) and a DELETE that the foreign key
// would refuse anyway. The one place that deliberately hits the real thing is (f): the seeded Admin is asked to demote, deactivate and delete
// itself, and must answer 409 (the self rules).
//
// Locators: sidebar links go through `mainNav` / `navLink` (e2e/shell.ts, matched by whole name). The two denied/empty screens are
// matched by their level-1 heading with `exact: true`: "No access" and "Your role has no pages yet." do not contain each other, and
// no text on those screens is looked up without `exact`. The sign-in form's labels are the ones the other specs use.

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const PREFIX = "w9a-";
const GONE = 999999;
const REFUSED = "insufficient permission"; // the one text of every missing permission (backend api/deps.py)

const ADMIN = { username: "admin", password: "correct-horse", role: "admin" };
const VIEWER = { username: "w9a-viewer", password: "w9a-viewer-pass", role: "viewer" };
const OPERATOR = { username: "w9a-operator", password: "w9a-operator-pass", role: "operator" };
type Account = typeof ADMIN;

const ROLE_ASSETS = "w9a-assets-only"; // assets.view
const ROLE_LOOK = "w9a-look-only"; // assets.view + dashboards.view
const ROLE_NONE = "w9a-no-permissions"; // nothing at all
const ROLE_STAFF = "w9a-staff"; // every permission except roles.manage, which no custom role can hold
const ROLE_SPARE = "w9a-spare"; // made and removed inside one test

const ASSETS_USER: Account = { username: "w9a-assets", password: "w9a-assets-pass", role: ROLE_ASSETS };
const LOOK_USER: Account = { username: "w9a-looker", password: "w9a-looker-pass", role: ROLE_LOOK };
const NONE_USER: Account = { username: "w9a-empty", password: "w9a-empty-pass", role: ROLE_NONE };
const STAFF_USER: Account = { username: "w9a-staffer", password: "w9a-staffer-pass", role: ROLE_STAFF };

// The sidebar in the order it is drawn (components/navItems.ts): three groups.
const MONITOR = ["Assets Tree", "Dashboards", "Billing"];
const OPERATE = ["Sources", "Scans", "Discovery"];
const ADMINISTER = ["Users & Roles", "Settings", "Tariffs", "Storage", "Displays", "Audit", "Diagnostics"];
const EVERY_LINK = [...MONITOR, ...OPERATE, ...ADMINISTER];
const PAGE_OF: Record<string, string> = {
  Sources: "/sources", Scans: "/scans", Discovery: "/discovery",
  "Users & Roles": "/users", Settings: "/settings", Tariffs: "/tariffs", Storage: "/storage", Displays: "/displays", Audit: "/audit", Diagnostics: "/diagnostics",
};
// The one Administer page the built-in Operator opens since W9b (tariffs.view): read-only.
const OPERATOR_ADMINISTER = ["Tariffs"];

// What /api/me lists for the built-in roles (backend core/permissions.py BUILTIN), sorted.
const VIEWER_PERMISSIONS = ["assets.view", "billing.export", "billing.view", "dashboards.view"];
const OPERATOR_PERMISSIONS = [
  ...VIEWER_PERMISSIONS, "dashboards.edit", "diagnostics.run", "discovery.view", "sources.test", "sources.view", "tariffs.view",
].sort();

interface ApiUser { id: number; username: string; role: string; active: boolean }
interface ApiRole { id: number; name: string; builtin: boolean; user_count: number; assignable: boolean; permissions: string[] | null }
interface ApiPermission { id: string; area: string; kind: string; label: string; description: string }
interface ApiMe { username: string; role: string; permissions: string[] }

// ---------------------------------------------------------------------------------------------------------------------------------
// Requests

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
interface Probe { method: Method; path: string; data?: object }
const get = (path: string): Probe => ({ method: "GET", path });
const post = (path: string, data: object = {}): Probe => ({ method: "POST", path, data });
const put = (path: string, data: object = {}): Probe => ({ method: "PUT", path, data });
const patch = (path: string, data: object = {}): Probe => ({ method: "PATCH", path, data });
const del = (path: string): Probe => ({ method: "DELETE", path });

/** Needs a permission that only the built-in Admin role holds (every route a Viewer or an Operator is refused). */
const ADMIN_TIER: Probe[] = [
  post("/api/assets"), patch(`/api/assets/${GONE}`), del(`/api/assets/${GONE}`),
  post("/api/mappings"), patch(`/api/mappings/${GONE}`), del(`/api/mappings/${GONE}`),
  get(`/api/mappings/${GONE}`), // W12a: assets.edit, the read an unmap makes before it deletes; a gate that lets it through answers 404, never 403
  put("/api/dashboards/default", { dashboard_id: GONE }),
  post("/api/tariffs"), patch(`/api/tariffs/${GONE}`), del(`/api/tariffs/${GONE}`),
  put("/api/settings/billing"), // the GET moved to OPERATOR_TIER in W9b: the Tariffs page reads the currency with tariffs.view
  post("/api/sources"), patch(`/api/sources/${GONE}`), del(`/api/sources/${GONE}`), post(`/api/sources/${GONE}/browse`),
  get("/api/connectors"),
  get("/api/diagnostics/report?format=bogus"), // a gate that lets it through answers 422 and builds no report
  put("/api/discovery/layout"),
  del("/api/discovery/layout"), // W7t: Tidy layout; discovery.edit. The probe runs as a Viewer and an Operator: a gate that lets it through would wipe the shared stack's saved layout
  post("/api/scopes"), patch(`/api/scopes/${GONE}`), del(`/api/scopes/${GONE}`),
  get("/api/scopes/suggestions"), get(`/api/scopes/${GONE}/preview`), post(`/api/scopes/${GONE}/scan`), post("/api/discovery/accept"),
  post("/api/discovery/sources/remove"), // W7r: discovery.edit; an empty body from a role without it is a 403, a gate that lets it through answers 422 and removes nothing
  get("/api/storage"), get("/api/storage/rows-per-day"), get("/api/settings/storage"),
  put("/api/settings/storage"), put("/api/settings/storage/default"),
  get("/api/settings/general"), get("/api/settings/sign-in"), get("/api/tls/status"),
  put("/api/settings/general"), put("/api/settings/sign-in"),
  get("/api/audit"), get("/api/audit/options"), get("/api/audit/position"), get("/api/audit/1"), get("/api/audit.csv"),
  get("/api/users"), post("/api/users"), patch(`/api/users/${GONE}`), del(`/api/users/${GONE}`), post(`/api/users/${GONE}/unblock`),
  get("/api/roles"), get("/api/permissions"), post("/api/roles"), patch(`/api/roles/${GONE}`), del(`/api/roles/${GONE}`),
  post(`/api/roles/${GONE}/duplicate`),
  // W11: billing.close. A role without it is refused before the month is even looked at; nothing can ever be closed or reopened by accident (an Admin's call is not probed here).
  post("/api/billing/months/1900-01/close"), post("/api/billing/months/1900-01/reopen"),
];

/** Every route a Viewer is refused and an Operator may call. */
const OPERATOR_TIER: Probe[] = [
  post("/api/dashboards"), put(`/api/dashboards/${GONE}`), del(`/api/dashboards/${GONE}`),
  get("/api/tariffs"), get("/api/settings/billing"),
  get("/api/sources"), get(`/api/sources/${GONE}/points`), get("/api/collector/status"), get("/api/secret-key/status"),
  post("/api/sources/test-all"), post(`/api/sources/${GONE}/test`), post(`/api/sources/${GONE}/check`),
  get("/api/discovery/graph"), get("/api/scans"), get(`/api/scans/${GONE}`), get("/api/scopes"),
  get(`/api/jobs/${GONE}`),
];

/** What a Viewer may call, and so what an account with no permission at all is also refused. */
const VIEWER_TIER: Probe[] = [
  get("/api/assets"), get(`/api/assets/${GONE}/series`), get(`/api/assets/${GONE}/summary`), get("/api/fleet/summary"),
  get("/api/dashboards"), get("/api/dashboards/default"), get(`/api/dashboards/${GONE}`),
  post("/api/widget-data"), post("/api/widget-data/csv"),
];

const BILLING: Probe[] = [get("/api/billing/costs"), get("/api/billing/months"), get("/api/billing/costs.csv"), get("/api/billing/month-check")]; // w21: the month check is billing.view too

/** The routes that manage roles: no custom role can ever reach them. */
const ROLES_WRITE: Probe[] = [
  get("/api/permissions"), post("/api/roles"), patch(`/api/roles/${GONE}`), del(`/api/roles/${GONE}`), post(`/api/roles/${GONE}/duplicate`),
];

/** The routes any signed-in account may call, whatever its role holds. */
const SIGNED_IN = [get("/api/me"), get("/api/site"), get("/api/version"), get("/api/status")];

const send = (request: APIRequestContext, probe: Probe, timeout = 30_000) =>
  request.fetch(probe.path, { method: probe.method, data: probe.data, timeout });

/** The probes that were not answered 403 with the one refusal text, as readable lines (empty when every one was refused). */
async function notRefused(request: APIRequestContext, probes: readonly Probe[]): Promise<string[]> {
  const bad: string[] = [];
  for (const probe of probes) {
    const response = await send(request, probe);
    const body = await response.text();
    if (response.status() !== 403) bad.push(`${probe.method} ${probe.path} answered ${response.status()}`);
    else if (!body.includes(`"${REFUSED}"`)) bad.push(`${probe.method} ${probe.path} answered 403 with ${body}`);
  }
  return bad;
}

/** The probes that were answered 401 or 403 although the account may call them (empty when none was). */
async function wronglyRefused(request: APIRequestContext, probes: readonly Probe[]): Promise<string[]> {
  const bad: string[] = [];
  for (const probe of probes) {
    const status = (await send(request, probe)).status();
    if (status === 401 || status === 403) bad.push(`${probe.method} ${probe.path} answered ${status}`);
  }
  return bad;
}

/** The answer's `detail` text (FastAPI's error body), or the raw text when the body is not that. */
async function detail(response: { text(): Promise<string> }): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    return typeof parsed.detail === "string" ? parsed.detail : text;
  } catch {
    return text;
  }
}

async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/**
 * Runs `use` with the request context of a fresh browser context in which `who` is signed in (`null`: nobody). The cookie jar is the
 * account's own session, so every assertion made through it is about that account.
 */
async function as<T>(browser: Browser, who: Account | null, use: (request: APIRequestContext) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    if (who) {
      const login = await context.request.post("/api/login", { data: { username: who.username, password: who.password } });
      expect(login.ok(), `${who.username} signs in: ${login.status()} ${await login.text()}`).toBe(true);
    }
    return await use(context.request);
  } finally {
    await context.close();
  }
}

const asAdmin = <T>(browser: Browser, use: (request: APIRequestContext) => Promise<T>) => as(browser, ADMIN, use);

async function createRole(request: APIRequestContext, name: string, permissions: string[]): Promise<number> {
  const made = await request.post("/api/roles", { data: { name, description: "made by w9a.spec.ts", permissions } });
  expect(made.status(), `creating role ${name}: ${await made.text()}`).toBe(201);
  return ((await made.json()) as ApiRole).id;
}

async function createAccount(request: APIRequestContext, who: Account): Promise<number> {
  const made = await request.post("/api/users", { data: { username: who.username, password: who.password, role: who.role } });
  expect(made.status(), `creating ${who.username}: ${await made.text()}`).toBe(201);
  return ((await made.json()) as ApiUser).id;
}

/** Every account whose name starts with w9a-, then every custom role whose name does (a role an account holds cannot be deleted). */
async function removeMine(request: APIRequestContext): Promise<void> {
  for (const user of (await json<ApiUser[]>(request, "/api/users")).filter((u) => u.username.startsWith(PREFIX))) {
    const gone = await request.delete(`/api/users/${user.id}`);
    expect([204, 404], `deleting ${user.username}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
  for (const role of (await json<ApiRole[]>(request, "/api/roles")).filter((r) => !r.builtin && r.name.toLowerCase().startsWith(PREFIX))) {
    const gone = await request.delete(`/api/roles/${role.id}`);
    expect([204, 404], `deleting role ${role.name}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The browser

async function signIn(page: Page, who: Account) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(who.username);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(userBlock(page)).toContainText(who.username);
  await expect(userBlock(page)).toContainText(roleLabel(who.role));
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
const onPath = (path: string) => new RegExp(`${path.replace(/\//g, "\\/")}$`);

/** The sidebar holds exactly these links, in this order, and none of the others; its groups are the ones named. */
async function expectSidebar(page: Page, links: string[], groups: string[]) {
  await expect(mainNav(page).getByRole("link")).toHaveText(links);
  for (const name of EVERY_LINK.filter((label) => !links.includes(label))) await expect(navLink(page, name)).toHaveCount(0);
  await expect(mainNav(page).getByRole("group")).toHaveCount(groups.length);
  for (const name of ["Monitor", "Operate", "Administer"]) {
    await expect(mainNav(page).getByRole("group", { name, exact: true })).toHaveCount(groups.includes(name) ? 1 : 0);
  }
}

/** A direct visit to the page shows the denied screen and no page. */
async function expectDenied(page: Page, path: string) {
  await page.goto(path);
  await expect(heading1(page, "No access"), path).toBeVisible();
  await expect(page.getByText("Your role does not include this page.", { exact: true }), path).toBeVisible();
}

async function me(request: APIRequestContext): Promise<ApiMe> {
  const answer = await json<ApiMe>(request, "/api/me");
  return { ...answer, permissions: [...answer.permissions].sort() };
}

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W9a: roles and permissions", () => {
  let catalogue: ApiPermission[] = [];
  const roleIds: Record<string, number> = {};

  test.beforeAll(async ({ browser }) => {
    await asAdmin(browser, async (request) => {
      await removeMine(request);
      catalogue = await json<ApiPermission[]>(request, "/api/permissions");
      expect(catalogue, "the catalogue has the 33 permissions").toHaveLength(33);
      const mostOfThem = catalogue.map((p) => p.id).filter((id) => id !== "roles.manage");
      roleIds[ROLE_ASSETS] = await createRole(request, ROLE_ASSETS, ["assets.view"]);
      roleIds[ROLE_LOOK] = await createRole(request, ROLE_LOOK, ["assets.view", "dashboards.view"]);
      roleIds[ROLE_NONE] = await createRole(request, ROLE_NONE, []);
      roleIds[ROLE_STAFF] = await createRole(request, ROLE_STAFF, mostOfThem);
      for (const who of [VIEWER, OPERATOR, ASSETS_USER, LOOK_USER, NONE_USER, STAFF_USER]) await createAccount(request, who);
    });
  });

  test.afterAll(async ({ browser }) => {
    await asAdmin(browser, removeMine);
  });

  // (a) the screens -------------------------------------------------------------------------------------------------------------

  test("a viewer sees three pages in the sidebar and is turned away from every other page", async ({ browser }) => {
    test.setTimeout(180_000);
    await asUser(browser, VIEWER, async (page) => {
      await test.step("the sidebar holds Monitor and nothing else", async () => {
        await expectSidebar(page, MONITOR, ["Monitor"]);
      });
      await test.step("Billing opens; every Operate and Administer page says No access", async () => {
        await page.goto("/billing");
        await expect(heading1(page, "Billing")).toBeVisible();
        for (const name of [...OPERATE, ...ADMINISTER]) await expectDenied(page, PAGE_OF[name]);
      });
      await test.step("/api/me lists the Viewer's four permissions", async () => {
        const answer = await me(page.request);
        expect(answer.role).toBe("viewer");
        expect(answer.permissions).toEqual(VIEWER_PERMISSIONS);
      });
    });
  });

  test("an operator also sees Sources, Scans, Discovery and Tariffs (read-only), and is turned away from the other Administer pages", async ({ browser }) => {
    test.setTimeout(180_000);
    await asUser(browser, OPERATOR, async (page) => {
      await test.step("the sidebar holds Monitor, Operate and Tariffs alone in Administer", async () => {
        await expectSidebar(page, [...MONITOR, ...OPERATE, ...OPERATOR_ADMINISTER], ["Monitor", "Operate", "Administer"]);
      });
      await test.step("Sources opens; every other Administer page says No access, and so does a source's points page", async () => {
        await page.goto("/sources");
        await expect(heading1(page, "Sources")).toBeVisible();
        for (const name of ADMINISTER.filter((each) => !OPERATOR_ADMINISTER.includes(each))) await expectDenied(page, PAGE_OF[name]);
        await expectDenied(page, "/sources/1/points");
      });
      await test.step("Tariffs opens, and says the role can see it but not change it", async () => {
        await page.goto("/tariffs");
        await expect(heading1(page, "Tariffs")).toBeVisible();
        await expect(page.getByText("Your role can see this page but not change it.", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Add rate", exact: true })).toHaveCount(0);
      });
      await test.step("/api/me lists the Operator's ten permissions", async () => {
        const answer = await me(page.request);
        expect(answer.role).toBe("operator");
        expect(answer.permissions).toEqual(OPERATOR_PERMISSIONS);
      });
    });
  });

  test("an administrator sees every page and every permission", async ({ browser }) => {
    test.setTimeout(180_000);
    await asUser(browser, ADMIN, async (page) => {
      await test.step("the sidebar holds all twelve pages in three groups", async () => {
        await expectSidebar(page, EVERY_LINK, ["Monitor", "Operate", "Administer"]);
      });
      await test.step("the Users & Roles page and the Assets Tree open, with their buttons", async () => {
        await page.goto("/users");
        await expect(heading1(page, "Users & Roles")).toBeVisible();
        await expect(page.getByRole("button", { name: "Create user", exact: true })).toBeVisible();
        await page.goto("/assets");
        await expect(heading1(page, "Assets Tree")).toBeVisible();
        await expect(page.getByRole("button", { name: "Add asset", exact: true })).toBeVisible();
      });
      await test.step("/api/me lists the whole catalogue", async () => {
        const answer = await me(page.request);
        expect(answer.role).toBe("admin");
        expect(answer.permissions).toEqual(catalogue.map((p) => p.id).sort());
      });
    });
  });

  // (b) the API, with each role's own session -----------------------------------------------------------------------------------

  test("the API refuses a viewer every route above the Viewer's, and nothing it is allowed", async ({ browser }) => {
    test.setTimeout(180_000);
    await as(browser, VIEWER, async (api) => {
      expect(await notRefused(api, [...ADMIN_TIER, ...OPERATOR_TIER]), "routes a Viewer must be refused").toEqual([]);
      expect(await wronglyRefused(api, [get("/api/assets"), get("/api/dashboards"), get("/api/billing/months"), get("/api/billing/month-check"), ...SIGNED_IN]),
        "routes a Viewer may call").toEqual([]);
      // Setup is over: a signed-in account is told so as well (nothing is created).
      const again = await api.post("/api/setup", { data: { username: "w9a-setup", password: "w9a-setup-pass" } });
      expect(again.status()).toBe(409);
      expect(await detail(again)).toBe("setup has already been completed");
    });
  });

  test("the API refuses an operator every Administer route, the role routes and the permission list, and nothing it is allowed", async ({ browser }) => {
    test.setTimeout(180_000);
    await as(browser, OPERATOR, async (api) => {
      expect(await notRefused(api, ADMIN_TIER), "routes an Operator must be refused").toEqual([]);
      expect(await wronglyRefused(api, [get("/api/sources"), get("/api/tariffs"), get("/api/settings/billing"), get("/api/scans"), get("/api/scopes"), ...SIGNED_IN]),
        "routes an Operator may call").toEqual([]);
    });
  });

  test("an account whose role holds no permission is refused everything but the signed-in basics, the live stream included", async ({ browser }) => {
    test.setTimeout(180_000);
    await as(browser, NONE_USER, async (api) => {
      expect(await notRefused(api, [...ADMIN_TIER, ...OPERATOR_TIER, ...VIEWER_TIER, ...BILLING]), "routes it must be refused").toEqual([]);
      // The stream of a role that may see assets or dashboards never ends, so it is only ever requested here, where it is refused.
      const stream = await api.get("/api/stream", { timeout: 15_000 });
      expect(stream.status()).toBe(403);
      expect(await detail(stream)).toBe(REFUSED);
      expect(await wronglyRefused(api, SIGNED_IN), "routes every signed-in account may call").toEqual([]);
      const answer = await me(api);
      expect(answer.role).toBe(ROLE_NONE);
      expect(answer.permissions).toEqual([]);
    });
  });

  test("nobody signed in is refused with 401 on the account routes and setup stays closed", async ({ browser }) => {
    await as(browser, null, async (api) => {
      for (const path of ["/api/users", "/api/roles", "/api/permissions", "/api/audit.csv", "/api/me"]) {
        expect((await api.get(path)).status(), path).toBe(401);
      }
      expect((await api.get("/api/stream", { timeout: 15_000 })).status()).toBe(401);
      const setup = await api.post("/api/setup", { data: { username: "w9a-setup", password: "w9a-setup-pass" } });
      expect(setup.status()).toBe(409);
      expect(await detail(setup)).toBe("setup has already been completed");
    });
  });

  test("a role with assets.view and dashboards.view only is refused billing, writing dashboards and the audit export", async ({ browser }) => {
    test.setTimeout(180_000);
    await as(browser, LOOK_USER, async (api) => {
      const named = [get("/api/billing/costs"), post("/api/dashboards"), get("/api/audit.csv")];
      expect(await notRefused(api, named), "the three routes the role lacks").toEqual([]);
      expect(await notRefused(api, [...ADMIN_TIER, ...OPERATOR_TIER, ...BILLING]), "every other route the role lacks").toEqual([]);
      expect(await wronglyRefused(api, [get("/api/assets"), get("/api/dashboards"), get("/api/fleet/summary"), ...SIGNED_IN]),
        "routes the role holds").toEqual([]);
      expect((await me(api)).permissions).toEqual(["assets.view", "dashboards.view"]);
    });
  });

  // (c) a custom role with one permission, in the browser ------------------------------------------------------------------------

  test("a role that holds only assets.view sees only the Assets Tree, is turned away from Billing and lands on it", async ({ browser }) => {
    test.setTimeout(180_000);
    await asUser(browser, ASSETS_USER, async (page) => {
      await test.step("signing in lands on the Assets Tree, and so does /", async () => {
        await expect(page).toHaveURL(onPath("/assets"));
        await expect(heading1(page, "Assets Tree")).toBeVisible();
        await page.goto("/");
        await expect(page).toHaveURL(onPath("/assets"));
        await expect(heading1(page, "Assets Tree")).toBeVisible();
      });
      await test.step("the sidebar has the Assets Tree and nothing else, and the page offers no change", async () => {
        await expectSidebar(page, ["Assets Tree"], ["Monitor"]);
        await expect(page.getByRole("button", { name: "Add asset", exact: true })).toHaveCount(0);
      });
      await test.step("Billing and the other pages say No access, and the API agrees", async () => {
        for (const path of ["/billing", "/dashboards", "/sources", "/users", "/settings"]) await expectDenied(page, path);
        expect((await page.request.get("/api/billing/costs")).status()).toBe(403);
        expect((await page.request.get("/api/assets")).status()).toBe(200);
      });
    });
  });

  // (d) a role with no permission ------------------------------------------------------------------------------------------------

  test("a role that holds nothing lands on a plain screen that says it has no pages yet", async ({ browser }) => {
    test.setTimeout(180_000);
    await asUser(browser, NONE_USER, async (page) => {
      await page.goto("/");
      await expect(heading1(page, "Your role has no pages yet.")).toBeVisible();
      await expect(page.getByText("Ask an administrator to give your role access.", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(onPath("/"));
      await expect(mainNav(page)).toHaveCount(0); // no sidebar column at all, not an empty one
      await expect(userBlock(page)).toContainText(ROLE_NONE);
      await expectDenied(page, "/assets");
      expect((await page.request.get("/api/assets")).status()).toBe(403);
      await page.goto("/password"); // the one page every account has
      await expect(heading1(page, "Change password")).toBeVisible();
    });
  });

  // (e) a permission taken away while a page is open -----------------------------------------------------------------------------

  test("taking a permission from a role is refused at once, and the open page of its account says so on its next focus check", async ({ browser }) => {
    test.setTimeout(240_000);
    const notice = (page: Page) =>
      page.getByRole("status").filter({ hasText: "Your access changed. Reload to see what you can use now." });

    await asUser(browser, LOOK_USER, async (page) => {
      await test.step("with both permissions the sidebar shows the Assets Tree and Dashboards", async () => {
        await expectSidebar(page, ["Assets Tree", "Dashboards"], ["Monitor"]);
        expect((await page.request.get("/api/dashboards")).status()).toBe(200);
        await expect(notice(page)).toHaveCount(0);
      });

      await test.step("the administrator removes dashboards.view; the very next request is refused", async () => {
        await asAdmin(browser, async (api) => {
          const changed = await api.patch(`/api/roles/${roleIds[ROLE_LOOK]}`, { data: { permissions: ["assets.view"] } });
          expect(changed.status(), `changing the role: ${await changed.text()}`).toBe(200);
        });
        expect((await page.request.get("/api/dashboards")).status()).toBe(403);
        expect((await page.request.get("/api/assets")).status()).toBe(200);
      });

      await test.step("the open page keeps what it loaded with and says the access changed once it looks", async () => {
        // The focus check is spaced 10 s apart (and a request refused meanwhile may have made the check already); either way the notice
        // is there within the gap, so the wait is longer than that.
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(notice(page)).toBeVisible({ timeout: 25_000 });
        await expect(navLink(page, "Dashboards")).toBeVisible(); // nothing moves under an open page
      });

      await test.step("Reload shows the new access: the Assets Tree only, and Dashboards says No access", async () => {
        await notice(page).getByRole("button", { name: "Reload", exact: true }).click();
        await expectSidebar(page, ["Assets Tree"], ["Monitor"]);
        await expect(notice(page)).toHaveCount(0);
        await expectDenied(page, "/dashboards");
      });
    });

    await test.step("the Audit log words the creation and the change of the role", async () => {
      await asUser(browser, ADMIN, async (page) => {
        await page.goto(`/audit?q=${encodeURIComponent(ROLE_LOOK)}`);
        await expect(heading1(page, "Audit log")).toBeVisible();
        await expect(page.getByRole("row").filter({ hasText: `Created role ${ROLE_LOOK}` }).first()).toBeVisible();
        await expect(page.getByRole("row").filter({ hasText: `Changed role ${ROLE_LOOK}: removed See dashboards` }).first()).toBeVisible();
      });
    });
  });

  // a role that may change users still cannot make or take over an Admin ---------------------------------------------------------

  test("a role that may change users cannot make an Admin or touch one, however much else it holds", async ({ browser }) => {
    test.setTimeout(180_000);
    const OTHER_ADMIN: Account = { username: "w9a-admin2", password: "w9a-admin2-pass", role: "admin" };
    const adminId = await asAdmin(browser, async (api) => {
      const found = (await json<ApiUser[]>(api, "/api/users")).find((u) => u.username === ADMIN.username);
      expect(found, "the seeded admin exists").toBeTruthy();
      return found!.id;
    });
    const otherAdminId = await asAdmin(browser, (api) => createAccount(api, OTHER_ADMIN));

    try {
      await as(browser, STAFF_USER, async (api) => {
        const own = await me(api);
        expect(own.permissions, "32 permissions: all but roles.manage").toHaveLength(32);
        expect(own.permissions).toContain("users.edit");
        expect(own.permissions).not.toContain("roles.manage");
        const ownId = (await json<ApiUser[]>(api, "/api/users")).find((u) => u.username === STAFF_USER.username)!.id;

        // What it may do: make a Viewer, raise it to Operator (it holds every permission of Operator), delete it.
        const made = await api.post("/api/users", { data: { username: "w9a-made", password: "w9a-made-pass", role: "viewer" } });
        expect(made.status(), await made.text()).toBe(201);
        const madeId = ((await made.json()) as ApiUser).id;
        const raised = await api.patch(`/api/users/${madeId}`, { data: { role: "operator" } });
        expect(raised.status(), await raised.text()).toBe(200);

        // What it may not: an account at the Admin level, for anyone or for itself.
        const grab = await api.post("/api/users", { data: { username: "w9a-grab", password: "w9a-grab-pass", role: "admin" } });
        expect(grab.status()).toBe(403);
        expect(await detail(grab)).toMatch(/more access than yours/);
        const promote = await api.patch(`/api/users/${madeId}`, { data: { role: "admin" } });
        expect(promote.status()).toBe(403);
        const self = await api.patch(`/api/users/${ownId}`, { data: { role: "admin" } });
        expect(self.status()).toBe(409);
        expect(await detail(self)).toMatch(/own role/);

        // Nor may it reset, deactivate, demote, unblock or delete an Admin account.
        const hostile: [string, Probe][] = [
          ["reset the password of an Admin", patch(`/api/users/${otherAdminId}`, { password: "w9a-takeover-pass" })],
          ["deactivate an Admin", patch(`/api/users/${otherAdminId}`, { active: false })],
          ["demote an Admin", patch(`/api/users/${otherAdminId}`, { role: "viewer" })],
          ["unblock an Admin", post(`/api/users/${otherAdminId}/unblock`)],
          ["delete an Admin", del(`/api/users/${otherAdminId}`)],
          // The seeded admin, with the password it already has: were this ever allowed, nothing would change for the later specs.
          ["reset the password of the seeded admin", patch(`/api/users/${adminId}`, { password: ADMIN.password })],
        ];
        for (const [what, probe] of hostile) {
          const refused = await send(api, probe);
          expect(refused.status(), `${what}: ${await refused.text()}`).toBe(403);
          expect(await detail(refused), what).toMatch(/more access than yours/);
        }

        // No role of its own either: managing roles is the Admin's alone, and the list shows no other role's permissions.
        expect(await notRefused(api, ROLES_WRITE), "the role routes").toEqual([]);
        const roles = await json<ApiRole[]>(api, "/api/roles");
        expect(roles.map((r) => r.name)).toEqual(expect.arrayContaining(["viewer", "operator", "admin", ROLE_STAFF]));
        expect(roles.filter((r) => r.permissions !== null), "no permission lists for an account that cannot manage roles").toEqual([]);
        expect(roles.find((r) => r.name === "admin")!.assignable, "it cannot hand out Admin").toBe(false);
        expect(roles.find((r) => r.name === "operator")!.assignable, "it can hand out Operator").toBe(true);

        const removed = await api.delete(`/api/users/${madeId}`);
        expect(removed.status(), await removed.text()).toBe(204);
      });

      // The Admin it aimed at still signs in with the password it had, and is still an active Admin.
      await as(browser, OTHER_ADMIN, async (api) => {
        const answer = await me(api);
        expect(answer.role).toBe("admin");
      });
      await asAdmin(browser, async (api) => {
        const users = await json<ApiUser[]>(api, "/api/users");
        const target = users.find((u) => u.id === otherAdminId);
        expect(target, "the other admin was not deleted").toBeTruthy();
        expect(target).toMatchObject({ role: "admin", active: true });
        expect(users.find((u) => u.id === adminId)).toMatchObject({ role: "admin", active: true });
        expect(users.find((u) => u.username === "w9a-grab"), "no Admin was made").toBeUndefined();
      });
    } finally {
      await asAdmin(browser, async (api) => {
        const gone = await api.delete(`/api/users/${otherAdminId}`);
        expect([204, 404]).toContain(gone.status());
      });
    }
  });

  // (f) an Admin acting on itself, a role in use, the built-in roles ------------------------------------------------------------------------

  test("an Admin cannot demote, deactivate or delete itself, and the roles Admin made are managed with their safeguards", async ({ browser }) => {
    test.setTimeout(180_000);
    await asAdmin(browser, async (api) => {
      const users = await json<ApiUser[]>(api, "/api/users");
      const admin = users.find((u) => u.username === ADMIN.username)!;
      expect(admin, "the seeded admin exists and is an active Admin").toMatchObject({ role: "admin", active: true });

      await test.step("it cannot demote, deactivate or delete itself (409), and is unchanged afterwards", async () => {
        for (const role of ["viewer", "operator"]) {
          const demote = await api.patch(`/api/users/${admin.id}`, { data: { role } });
          expect(demote.status(), `demote to ${role}: ${await demote.text()}`).toBe(409);
        }
        const deactivate = await api.patch(`/api/users/${admin.id}`, { data: { active: false } });
        expect(deactivate.status(), await deactivate.text()).toBe(409);
        expect(await detail(deactivate)).toMatch(/yourself/);
        const remove = await api.delete(`/api/users/${admin.id}`);
        expect(remove.status(), await remove.text()).toBe(409);
        expect(await detail(remove)).toMatch(/yourself/);
        const after = (await json<ApiUser[]>(api, "/api/users")).find((u) => u.id === admin.id);
        expect(after).toMatchObject({ username: "admin", role: "admin", active: true });
      });

      await test.step("the built-in roles come first, hold what they hold, and cannot be changed or deleted", async () => {
        const roles = await json<ApiRole[]>(api, "/api/roles");
        expect(roles.slice(0, 3).map((r) => [r.name, r.builtin])).toEqual([["viewer", true], ["operator", true], ["admin", true]]);
        expect([...roles[0].permissions!].sort()).toEqual(VIEWER_PERMISSIONS);
        expect([...roles[1].permissions!].sort()).toEqual(OPERATOR_PERMISSIONS);
        expect(roles[2].permissions).toHaveLength(33);
        for (const role of roles.slice(0, 3)) {
          const deleted = await api.delete(`/api/roles/${role.id}`);
          expect(deleted.status(), `deleting ${role.name}: ${await deleted.text()}`).toBe(409);
          expect(await detail(deleted)).toMatch(/built-in/);
          // An empty body: it asks for no change and is still refused, and a gate that let it through would change nothing.
          const changed = await api.patch(`/api/roles/${role.id}`, { data: {} });
          expect(changed.status(), `changing ${role.name}: ${await changed.text()}`).toBe(409);
        }
        const copy = await api.post(`/api/roles/${roles[2].id}/duplicate`, { data: { name: "w9a-copy-of-admin" } });
        expect(copy.status(), await copy.text()).toBe(201);
        const copied = (await copy.json()) as ApiRole;
        expect(copied.permissions, "a copy of Admin holds everything but roles.manage").toHaveLength(32);
        expect(copied.permissions).not.toContain("roles.manage");
        expect((await api.delete(`/api/roles/${copied.id}`)).status()).toBe(204);
      });

      await test.step("no custom role may hold roles.manage, an unknown permission, or a built-in name", async () => {
        const manage = await api.post("/api/roles", { data: { name: "w9a-boss", permissions: ["roles.manage"] } });
        expect(manage.status()).toBe(422);
        expect(await detail(manage)).toMatch(/roles\.manage is only held by the Admin role/);
        const unknown = await api.post("/api/roles", { data: { name: "w9a-typo", permissions: ["assets.vew"] } });
        expect(unknown.status()).toBe(422);
        const taken = await api.post("/api/roles", { data: { name: "ADMIN", permissions: [] } });
        expect(taken.status()).toBe(409);
        expect((await json<ApiRole[]>(api, "/api/roles")).filter((r) => r.name.startsWith("w9a-boss") || r.name.startsWith("w9a-typo"))).toEqual([]);
      });

      await test.step("a role an account holds cannot be deleted until the account is gone", async () => {
        const spareId = await createRole(api, ROLE_SPARE, ["assets.view"]);
        const holder: Account = { username: "w9a-spare-holder", password: "w9a-spare-pass", role: ROLE_SPARE };
        const holderId = await createAccount(api, holder);
        const refused = await api.delete(`/api/roles/${spareId}`);
        expect(refused.status(), await refused.text()).toBe(409);
        expect(await detail(refused)).toMatch(/in use by 1 account/);
        const listed = (await json<ApiRole[]>(api, "/api/roles")).find((r) => r.id === spareId);
        expect(listed).toMatchObject({ name: ROLE_SPARE, user_count: 1, builtin: false });

        expect((await api.delete(`/api/users/${holderId}`)).status()).toBe(204);
        expect((await api.delete(`/api/roles/${spareId}`)).status()).toBe(204);
        expect((await json<ApiRole[]>(api, "/api/roles")).find((r) => r.id === spareId)).toBeUndefined();
      });

      await test.step("the permission list is the 33 permissions, in the catalogue's order, with an area, a label and a description each", async () => {
        const served = await json<ApiPermission[]>(api, "/api/permissions");
        expect(served.map((p) => p.id)).toEqual(catalogue.map((p) => p.id));
        for (const p of served) {
          expect(p.id, "area.action").toMatch(/^[a-z]+\.[a-z]+$/);
          for (const text of [p.area, p.label, p.description]) expect(text.trim(), p.id).not.toBe("");
        }
        expect((await send(api, get("/api/diagnostics/report?format=bogus"))).status(), "an Admin passes the gate").toBe(422);
      });
    });
  });
});
