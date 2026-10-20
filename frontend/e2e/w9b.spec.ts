import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { roleLabel } from "./roles";
import { mainNav, navLink, rowAction, userBlock } from "./shell";

// W9b (the Users & Roles page: a Roles tab where an administrator makes, duplicates, edits and deletes roles, and every permission does
// something) on the state the earlier projects leave behind: admin `admin` / `correct-horse`. Every account and role this spec makes has a
// name starting with `w9b-` (the Duplicate test also meets `Copy of operator` for a moment), and is removed again, users first (a role an
// account holds cannot be deleted). beforeAll also removes what an earlier, interrupted run left behind.
//
// What it proves: (1) the page is "Users & Roles", opens on Users, and its tabs follow the arrow keys, the address and the Back button;
// (2) the owner's Executive example works end to end, through the screens: a role made with four ticks, handed to an account on the Users
// tab, the account's sidebar and the API agree with it, and a tick added later reaches the open page of that account; (3) the safeguards
// (a role in use, the admin's own role, a taken name); (4) Duplicate of the built-in Operator; (5) the Operator reads Tariffs without
// changing anything, and settings.edit / settings.security each open one card of Settings; (6) the editor works from the keyboard.
//
// Locators: sidebar links go through `navLink` / `mainNav` (e2e/shell.ts): the page now has TWO links named "Users & Roles" (the sidebar's
// and the first crumb), so a page-wide link lookup by that name is ambiguous. Tabs are matched with `exact: true` ("Roles" is also the
// table's name, the card's heading and a substring of "Users and roles", the tab strip's label). A role's row is found through its own
// `Actions for <role>` button, never through its cell text (the built-in rows carry a "Built in" tag in the name cell). Checkboxes are
// matched by the server's whole label, `exact: true`.

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const PREFIX = "w9b-";
const COPY_PREFIX = "copy of operator"; // what Duplicate names the copy of the built-in Operator (lower case: names are matched without case)
const REFUSED = "insufficient permission"; // the one text of every missing permission (backend api/deps.py)

const ADMIN = { username: "admin", password: "correct-horse", role: "admin" };
type Account = typeof ADMIN;

const ROLE_EXEC = "w9b-executive"; // made on the Roles tab by the Executive test
const ROLE_IN_USE = "w9b-in-use"; // assets.view, held by w9b-holder
const ROLE_GENERAL = "w9b-settings-general"; // settings.view + settings.edit
const ROLE_SECURITY = "w9b-settings-security"; // settings.view + settings.security
const ROLE_PLUS = "w9b-operator-plus"; // the renamed copy of Operator

const EXEC: Account = { username: "w9b-exec", password: "w9b-exec-pass", role: ROLE_EXEC };
const OPERATOR: Account = { username: "w9b-operator", password: "w9b-operator-pass", role: "operator" };
const HOLDER: Account = { username: "w9b-holder", password: "w9b-holder-pass", role: ROLE_IN_USE };
const GENERAL: Account = { username: "w9b-general", password: "w9b-general-pass", role: ROLE_GENERAL };
const SECURITY: Account = { username: "w9b-security", password: "w9b-security-pass", role: ROLE_SECURITY };

// The sidebar's links, in the order it draws them (components/navItems.ts); the check that a link is NOT there goes through these names.
const EVERY_LINK = ["Assets Tree", "Dashboards", "Billing", "Sources", "Scans", "Discovery", "Users & Roles", "Settings", "Tariffs", "Storage", "Displays", "Audit", "Diagnostics"];

// What the Operator's role holds, from /api/me (backend core/permissions.py BUILTIN), sorted: the Duplicate test compares a copy against it.
const OPERATOR_PERMISSIONS = [
  "assets.view", "billing.export", "billing.view", "dashboards.edit", "dashboards.view", "diagnostics.run", "discovery.view",
  "sources.test", "sources.view", "tariffs.view",
];

const SIGN_IN_READ_ONLY = "Your role can see this but not change it: changing sign-in protection is a separate permission.";
const PAGE_READ_ONLY = "Your role can see this page but not change it.";

interface ApiUser { id: number; username: string; role: string; active: boolean }
interface ApiRole { id: number; name: string; builtin: boolean; user_count: number; permissions: string[] | null }

// ---------------------------------------------------------------------------------------------------------------------------------
// Requests

async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
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

/** Runs `use` with the request context of a fresh browser context in which the admin is signed in. */
async function asAdmin<T>(browser: Browser, use: (request: APIRequestContext) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    const login = await context.request.post("/api/login", { data: { username: ADMIN.username, password: ADMIN.password } });
    expect(login.ok(), `admin signs in: ${login.status()} ${await login.text()}`).toBe(true);
    return await use(context.request);
  } finally {
    await context.close();
  }
}

async function createRole(request: APIRequestContext, name: string, permissions: string[]): Promise<number> {
  const made = await request.post("/api/roles", { data: { name, description: "made by w9b.spec.ts", permissions } });
  expect(made.status(), `creating role ${name}: ${await made.text()}`).toBe(201);
  return ((await made.json()) as ApiRole).id;
}

async function createAccount(request: APIRequestContext, who: Account): Promise<void> {
  const made = await request.post("/api/users", { data: { username: who.username, password: who.password, role: who.role } });
  expect(made.status(), `creating ${who.username}: ${await made.text()}`).toBe(201);
}

/** Every account whose name starts with w9b-, then every custom role this spec can leave behind (a role an account holds cannot be deleted). */
async function removeMine(request: APIRequestContext): Promise<void> {
  for (const user of (await json<ApiUser[]>(request, "/api/users")).filter((u) => u.username.startsWith(PREFIX))) {
    const gone = await request.delete(`/api/users/${user.id}`);
    expect([204, 404], `deleting ${user.username}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
  const mine = (r: ApiRole) => !r.builtin && (r.name.toLowerCase().startsWith(PREFIX) || r.name.toLowerCase().startsWith(COPY_PREFIX));
  for (const role of (await json<ApiRole[]>(request, "/api/roles")).filter(mine)) {
    const gone = await request.delete(`/api/roles/${role.id}`);
    expect([204, 404], `deleting role ${role.name}: ${gone.status()} ${await gone.text()}`).toContain(gone.status());
  }
}

/** The status and refusal text of each call, as readable lines when it was not the 403 of a missing permission (empty when every one was refused). */
async function notRefused(request: APIRequestContext, calls: readonly [method: "GET" | "POST" | "PUT", path: string][]): Promise<string[]> {
  const bad: string[] = [];
  for (const [method, path] of calls) {
    // An empty body on the writes: a broken gate answers 422 and changes nothing.
    const response = await request.fetch(path, { method, data: method === "GET" ? undefined : {} });
    const body = await response.text();
    if (response.status() !== 403) bad.push(`${method} ${path} answered ${response.status()}`);
    else if (!body.includes(`"${REFUSED}"`)) bad.push(`${method} ${path} answered 403 with ${body}`);
  }
  return bad;
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
const heading2 = (page: Page, name: string) => page.getByRole("heading", { level: 2, name, exact: true });
const onPath = (path: string) => new RegExp(`${path.replace(/\//g, "\\/")}$`);

const tab = (page: Page, name: "Users" | "Roles") => page.getByRole("tab", { name, exact: true });
const rolesTable = (page: Page) => page.getByRole("table", { name: "Roles", exact: true });
/** A role's row on the Roles tab, through its own Actions button (see the header). */
const roleRow = (page: Page, role: string) =>
  rolesTable(page).getByRole("row").filter({ has: page.getByRole("button", { name: `Actions for ${role}`, exact: true }) });
const usersOf = (row: Locator) => row.locator("td.num");
const editor = (page: Page, title: string) => page.getByRole("dialog", { name: title, exact: true });
const summary = (dialog: Locator) => dialog.getByRole("region", { name: "What this role can do", exact: true });
const tick = (scope: Locator, label: string) => scope.getByRole("checkbox", { name: label, exact: true });
const card = (page: Page, title: string) => page.locator(".settings-page .page-card").filter({ has: heading2(page, title) });

/** The Roles tab, opened by its address (the same thing a reload does). */
async function openRoles(page: Page) {
  await page.goto("/users/roles");
  await expect(heading1(page, "Users & Roles")).toBeVisible();
  await expect(rolesTable(page)).toBeVisible();
}

/** Makes an account on the Users tab, the way a person does. */
async function createUserInPage(page: Page, who: Account) {
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Create user", exact: true }) });
  await form.getByLabel("Username").fill(who.username);
  await form.getByLabel("Password").fill(who.password);
  await form.getByLabel("Role").selectOption({ value: who.role });
  await form.getByRole("button", { name: "Create user", exact: true }).click();
  await expect(page.getByRole("cell", { name: who.username, exact: true })).toBeVisible();
}

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

/** The Tariffs page of a person who may read it and not change it. */
async function expectReadOnlyTariffs(page: Page) {
  await expect(heading1(page, "Tariffs")).toBeVisible();
  await expect(page.getByText(PAGE_READ_ONLY, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add rate", exact: true })).toHaveCount(0);
  await expect(page.getByRole("form", { name: "Site currency", exact: true })).toHaveCount(0);
}

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W9b: Users & Roles", () => {
  test.beforeAll(async ({ browser }) => {
    await asAdmin(browser, async (request) => {
      await removeMine(request);
      await createRole(request, ROLE_IN_USE, ["assets.view"]);
      await createRole(request, ROLE_GENERAL, ["settings.view", "settings.edit"]);
      await createRole(request, ROLE_SECURITY, ["settings.view", "settings.security"]);
      for (const who of [OPERATOR, HOLDER, GENERAL, SECURITY]) await createAccount(request, who);
    });
  });

  test.afterAll(async ({ browser }) => {
    await asAdmin(browser, removeMine);
  });

  // 1 ---------------------------------------------------------------------------------------------------------------------------

  test("the page is Users & Roles: it opens on Users, ArrowRight moves to Roles, the address follows, a reload keeps it and Back returns", async ({ browser }) => {
    test.setTimeout(180_000);
    await asUser(browser, ADMIN, async (page) => {
      await page.goto("/assets");
      await navLink(page, "Users & Roles").click();
      await expect(page).toHaveURL(onPath("/users"));
      await expect(heading1(page, "Users & Roles")).toBeVisible();
      await expect(page).toHaveTitle(/^Users & Roles/);
      await expect(tab(page, "Users")).toHaveAttribute("aria-selected", "true");
      await expect(tab(page, "Roles")).toHaveAttribute("aria-selected", "false");
      await expect(page.getByRole("button", { name: "Create user", exact: true })).toBeVisible();

      await tab(page, "Users").focus();
      await page.keyboard.press("ArrowRight");
      await expect(page).toHaveURL(onPath("/users/roles"));
      await expect(tab(page, "Roles")).toHaveAttribute("aria-selected", "true");
      await expect(tab(page, "Roles")).toBeFocused();
      await expect(heading2(page, "Roles")).toBeVisible();
      await expect(rolesTable(page)).toBeVisible();

      await page.reload();
      await expect(page).toHaveURL(onPath("/users/roles"));
      await expect(tab(page, "Roles")).toHaveAttribute("aria-selected", "true");
      await expect(rolesTable(page)).toBeVisible();

      await page.goBack();
      await expect(page).toHaveURL(onPath("/users"));
      await expect(tab(page, "Users")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("button", { name: "Create user", exact: true })).toBeVisible();
    });
  });

  // 2 ---------------------------------------------------------------------------------------------------------------------------

  test("the Executive: a role made with four ticks, given on the Users tab, shapes the sidebar and the API, and a later tick reaches the open page", async ({ browser }) => {
    test.setTimeout(300_000);
    const notice = (page: Page) =>
      page.getByRole("status").filter({ hasText: "Your access changed. Reload to see what you can use now." });

    await asUser(browser, ADMIN, async (admin) => {
      await test.step("New role: a name and four ticks, and the summary says what they add up to", async () => {
        await openRoles(admin);
        await admin.getByRole("button", { name: "New role", exact: true }).click();
        const dialog = editor(admin, "New role");
        await expect(dialog).toBeVisible();
        await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(ROLE_EXEC);
        await dialog.getByRole("textbox", { name: "Description", exact: true }).fill("Sees assets, dashboards and billing");
        for (const label of ["See the Assets Tree", "See dashboards", "See billing", "Export billing as CSV"]) await tick(dialog, label).check();
        await expect(summary(dialog)).toContainText("Opens: Assets Tree, Dashboards, Billing.");
        await expect(summary(dialog)).toContainText("Can change: nothing.");
        await expect(summary(dialog)).toContainText("Sensitive: Export billing as CSV.");
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(roleRow(admin, ROLE_EXEC)).toBeVisible();
        await expect(usersOf(roleRow(admin, ROLE_EXEC))).toHaveText("0");
      });

      await test.step("the Users tab offers the new role; the account is made, and the Roles tab counts it", async () => {
        await tab(admin, "Users").click();
        await createUserInPage(admin, EXEC);
        await tab(admin, "Roles").click();
        await expect(usersOf(roleRow(admin, ROLE_EXEC))).toHaveText("1");
      });

      await asUser(browser, EXEC, async (exec) => {
        await test.step("the Executive's sidebar is exactly Assets Tree, Dashboards and Billing", async () => {
          await expectSidebar(exec, ["Assets Tree", "Dashboards", "Billing"], ["Monitor"]);
        });

        await test.step("Sources, Users & Roles (both tabs), Tariffs and Settings say No access", async () => {
          for (const path of ["/sources", "/users", "/users/roles", "/tariffs", "/settings"]) await expectDenied(exec, path);
        });

        await test.step("the API agrees: 403 on what the role lacks, 200 on the billing export", async () => {
          const lacks: [method: "GET" | "POST" | "PUT", path: string][] = [
            ["GET", "/api/sources"], ["GET", "/api/roles"], ["GET", "/api/tariffs"], ["POST", "/api/assets"], ["PUT", "/api/settings/sign-in"],
          ];
          expect(await notRefused(exec.request, lacks), "calls the Executive must be refused").toEqual([]);
          const csv = await exec.request.get("/api/billing/costs.csv");
          expect(csv.status(), await csv.text()).toBe(200);
          expect(csv.headers()["content-type"]).toContain("text/csv");
        });

        await test.step("the administrator ticks See tariffs on the role while the Executive has Billing open", async () => {
          // The page is opened BEFORE the change: it holds the access it loaded with (a later visit would load the new one).
          await exec.goto("/billing");
          await expect(heading1(exec, "Billing")).toBeVisible();
          await expect(notice(exec)).toHaveCount(0);
          await (await rowAction(admin, roleRow(admin, ROLE_EXEC), "Edit")).click();
          const dialog = editor(admin, `Edit role ${ROLE_EXEC}`);
          await expect(dialog).toBeVisible();
          await expect(tick(dialog, "See billing")).toBeChecked(); // the editor shows what the role holds
          await expect(tick(dialog, "See tariffs")).not.toBeChecked();
          await tick(dialog, "See tariffs").check();
          await dialog.getByRole("button", { name: "Save", exact: true }).click();
          await expect(dialog).toBeHidden();
        });

        await test.step("the open page of the Executive keeps what it loaded with and says the access changed on its next focus check", async () => {
          // The focus check is spaced 10 s apart (and a request refused meanwhile may have made the check already); either way the notice
          // is there within the gap, so the wait is longer than that.
          await exec.evaluate(() => window.dispatchEvent(new Event("focus")));
          await expect(notice(exec)).toBeVisible({ timeout: 25_000 });
          await expect(navLink(exec, "Tariffs")).toHaveCount(0); // nothing moves under an open page
        });

        await test.step("Reload shows the new menu: Tariffs appears, and it opens read-only", async () => {
          await notice(exec).getByRole("button", { name: "Reload", exact: true }).click();
          await expectSidebar(exec, ["Assets Tree", "Dashboards", "Billing", "Tariffs"], ["Monitor", "Administer"]);
          await expect(notice(exec)).toHaveCount(0);
          await navLink(exec, "Tariffs").click();
          await expectReadOnlyTariffs(exec);
          expect((await exec.request.get("/api/tariffs")).status()).toBe(200);
          expect(await notRefused(exec.request, [["POST", "/api/tariffs"]]), "changing a rate stays refused").toEqual([]);
        });
      });
    });
  });

  // 3 ---------------------------------------------------------------------------------------------------------------------------

  test("safeguards: a role in use cannot be deleted, the admin cannot change their own role, a taken name keeps the dialog open", async ({ browser }) => {
    test.setTimeout(180_000);
    await asUser(browser, ADMIN, async (page) => {
      await test.step("a role an account holds has a disabled bin that says why, and the server refuses a direct delete", async () => {
        await openRoles(page);
        const row = roleRow(page, ROLE_IN_USE);
        const reason = "In use by 1 account(s). Give them another role first.";
        await expect(usersOf(row)).toHaveText("1");
        const bin = row.getByRole("button", { name: `Delete ${ROLE_IN_USE}`, exact: true });
        await expect(bin).toBeDisabled();
        await expect(bin).toHaveAttribute("title", reason);
        await expect(bin).toHaveAccessibleDescription(reason);

        const id = (await json<ApiRole[]>(page.request, "/api/roles")).find((r) => r.name === ROLE_IN_USE)!.id;
        const refused = await page.request.delete(`/api/roles/${id}`);
        expect(refused.status(), await refused.text()).toBe(409);
        expect(await detail(refused)).toMatch(/in use by 1 account/);
        await expect(row).toBeVisible();
      });

      await test.step("the seeded admin's own role select and bin are disabled on the Users tab", async () => {
        await tab(page, "Users").click();
        await expect(page.getByLabel("Role for admin", { exact: true })).toBeDisabled();
        await expect(page.getByRole("button", { name: "Delete admin", exact: true })).toBeDisabled();
      });

      await test.step("a name that is already taken (in other letters) is refused in the dialog, which keeps what was typed", async () => {
        await tab(page, "Roles").click();
        await page.getByRole("button", { name: "New role", exact: true }).click();
        const dialog = editor(page, "New role");
        const typed = ROLE_IN_USE.toUpperCase();
        await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(typed);
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        await expect(dialog.getByRole("alert")).toHaveText("A role with that name already exists.");
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(typed);
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(dialog).toBeHidden();
        const same = (await json<ApiRole[]>(page.request, "/api/roles")).filter((r) => r.name.toLowerCase() === ROLE_IN_USE);
        expect(same, "still one role of that name").toHaveLength(1);
      });
    });
  });

  // 4 ---------------------------------------------------------------------------------------------------------------------------

  test("Duplicate of the built-in Operator opens the copy in the editor with Operator's ticks; it is renamed, gets one more tick, saved and deleted", async ({ browser }) => {
    test.setTimeout(180_000);
    await asUser(browser, ADMIN, async (page) => {
      await openRoles(page);

      await test.step("Duplicate on the Operator row makes `Copy of operator` and opens it", async () => {
        await (await rowAction(page, roleRow(page, "Operator"), "Duplicate")).click();
        const dialog = editor(page, "Edit role Copy of operator");
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Copy of operator");
        await expect(dialog.getByText(/This copy already exists/)).toBeVisible();
        for (const label of ["See tariffs", "Change dashboards", "Run the connection check", "See scans and the graph"]) {
          await expect(tick(dialog, label), label).toBeChecked();
        }
        for (const label of ["Change tariffs", "See users", "Change assets"]) await expect(tick(dialog, label), label).not.toBeChecked();
      });

      await test.step("renamed, with Change tariffs ticked, it is saved", async () => {
        const dialog = editor(page, "Edit role Copy of operator");
        await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(ROLE_PLUS);
        await tick(dialog, "Change tariffs").check();
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(roleRow(page, ROLE_PLUS)).toBeVisible();
        await expect(roleRow(page, "Copy of operator")).toHaveCount(0);
        const saved = (await json<ApiRole[]>(page.request, "/api/roles")).find((r) => r.name === ROLE_PLUS);
        expect([...(saved?.permissions ?? [])].sort()).toEqual([...OPERATOR_PERMISSIONS, "tariffs.edit"].sort());
      });

      await test.step("the bin asks first, and the role is gone afterwards", async () => {
        await roleRow(page, ROLE_PLUS).getByRole("button", { name: `Delete ${ROLE_PLUS}`, exact: true }).click();
        const confirm = page.getByRole("dialog", { name: `Delete role ${ROLE_PLUS}?`, exact: true });
        await expect(confirm).toBeVisible();
        await confirm.getByRole("button", { name: "Delete role", exact: true }).click();
        await expect(confirm).toBeHidden();
        await expect(roleRow(page, ROLE_PLUS)).toHaveCount(0);
        expect((await json<ApiRole[]>(page.request, "/api/roles")).find((r) => r.name === ROLE_PLUS)).toBeUndefined();
      });
    });
  });

  // 5 ---------------------------------------------------------------------------------------------------------------------------

  test("the built-in Operator reads Tariffs but cannot change anything on it", async ({ browser }) => {
    test.setTimeout(180_000);
    await asUser(browser, OPERATOR, async (page) => {
      await navLink(page, "Tariffs").click();
      await expectReadOnlyTariffs(page);
      expect((await page.request.get("/api/settings/billing")).status(), "the currency may be read").toBe(200);
      expect(await notRefused(page.request, [["PUT", "/api/settings/billing"], ["POST", "/api/tariffs"]]), "changing stays refused").toEqual([]);
    });
  });

  test("a role with settings.edit saves the time zone and sees Sign-in protection read-only; with settings.security it is the other way round", async ({ browser }) => {
    test.setTimeout(240_000);
    const original = await asAdmin(browser, async (api) => (await json<{ timezone: string }>(api, "/api/settings/general")).timezone);
    const other = original === "Asia/Qatar" ? "Europe/London" : "Asia/Qatar";
    try {
      await asUser(browser, GENERAL, async (page) => {
        await page.goto("/settings");
        await expect(heading1(page, "Settings")).toBeVisible();
        const general = card(page, "General");
        const protection = card(page, "Sign-in protection");
        await expect(general.getByLabel("Timezone")).toBeEnabled();
        await expect(protection.getByRole("switch")).toBeDisabled();
        await expect(protection.getByText(SIGN_IN_READ_ONLY, { exact: true })).toBeVisible();
        await expect(protection.getByRole("button", { name: "Save sign-in protection", exact: true })).toHaveCount(0);

        await general.getByLabel("Timezone").fill(other);
        await general.getByRole("button", { name: "Save", exact: true }).click();
        await expect(general.getByRole("button", { name: "Saved", exact: true })).toBeVisible(); // green for 2.5 s
        expect((await json<{ timezone: string }>(page.request, "/api/site")).timezone).toBe(other);
        expect(await notRefused(page.request, [["PUT", "/api/settings/sign-in"]]), "the sign-in limits stay refused").toEqual([]);
      });
    } finally {
      await asAdmin(browser, async (api) => {
        const back = await api.put("/api/settings/general", { data: { timezone: original } });
        expect(back.ok(), `restoring the time zone ${original}: ${back.status()} ${await back.text()}`).toBe(true);
      });
    }

    await asUser(browser, SECURITY, async (page) => {
      await page.goto("/settings");
      await expect(heading1(page, "Settings")).toBeVisible();
      const general = card(page, "General");
      const protection = card(page, "Sign-in protection");
      await expect(general.getByLabel("Timezone")).toBeDisabled();
      await expect(general.getByText(PAGE_READ_ONLY, { exact: true })).toBeVisible();
      await expect(general.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
      await expect(protection.getByRole("switch")).toBeEnabled();
      await expect(protection.getByRole("button", { name: "Save sign-in protection", exact: true })).toBeVisible();
      await expect(protection.getByText(SIGN_IN_READ_ONLY, { exact: true })).toHaveCount(0);
      // The same zone it already has: were the gate ever open, nothing would change.
      expect(await notRefused(page.request, [["PUT", "/api/settings/general"]]), "the time zone stays refused").toEqual([]);
    });
  });

  // 6 ---------------------------------------------------------------------------------------------------------------------------

  test("from the keyboard: Enter on New role opens the editor, Tab reaches the first box, Space ticks it, Escape closes and the focus returns", async ({ browser }) => {
    test.setTimeout(180_000);
    await asUser(browser, ADMIN, async (page) => {
      await openRoles(page);
      // Nothing is clicked from here on, so the mouse rests where it was (no hover-opened tip can be in the way of the keys).
      const newRole = page.getByRole("button", { name: "New role", exact: true });
      await expect(newRole).toBeEnabled();
      await newRole.focus();
      await page.keyboard.press("Enter");
      const dialog = editor(page, "New role");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toBeFocused(); // the dialog starts on its first field
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("textbox", { name: "Description", exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("combobox", { name: "Start from" })).toBeFocused();
      await page.keyboard.press("Tab");
      const first = tick(dialog, "See the Assets Tree");
      await expect(first).toBeFocused();
      await page.keyboard.press("Space");
      await expect(first).toBeChecked();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(newRole).toBeFocused();
    });
  });
});
