import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { roleLabel } from "./roles";
import { expectNoRowAction, navLink, rowAction, signOut, userBlock } from "./shell";

// W3d (sign-in protection and Users: the admin sets how many failed sign-ins block an account and for how long, a blocked account shows
// on the Users page and can be unblocked, an account can be deleted and its past audit entries keep its name; and no screen or API answer
// shows the user name and password stored inside a source's URL) on the state the earlier projects leave behind: admin `admin` /
// `correct-horse`. The spec creates the account `w3d-victim` and the source `w3d-cred` itself and removes both before it ends.
//
// Every browser of the scratch stack reaches the api through one gateway address, so the only block this spec creates is the one on
// (that address, `w3d-victim`): the admin's own sign-ins are not touched. The policy is lowered to 3 failures / 1 minute for the test;
// beforeAll reads the two numbers it finds and afterAll puts exactly those back, whatever happens.
//
// Playwright's getByLabel / getByRole(name) match substrings, case-insensitively: labels and buttons that are prefixes or parts of
// others (Name, Url, Save, Delete admin, saved) are matched with `exact: true`.

const ADMIN = { username: "admin", password: "correct-horse" };
const VICTIM = { username: "w3d-victim", password: "victim-pass-1", role: "viewer" };
type Account = { username: string; password: string };

const SOURCE = "w3d-cred";
const RENAMED = "w3d-cred-renamed";
const SECRET = "Zq9-pw"; // the password inside the source's URL: it must never show up anywhere

// The same default as playwright.config.ts: the second browser context and afterAll need it spelled out.
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";

interface ApiSource { id: number; name: string; hidden_config_keys: string[]; config: Record<string, unknown> }
interface ApiUser { id: number; username: string }
interface ApiAuditEntry { id: number; action: string; detail: { name?: string; before?: Record<string, unknown>; after?: Record<string, unknown> } }

async function getJson<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.ok(), path).toBe(true);
  return (await response.json()) as T;
}

async function send<T>(page: Page, method: "post" | "patch" | "delete", path: string, data?: unknown): Promise<T | null> {
  const response = await page.request[method](path, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return response.status() === 204 ? null : ((await response.json()) as T);
}

const userRow = (page: Page, username: string) =>
  page.getByRole("row").filter({ has: page.getByRole("cell", { name: username, exact: true }) });
const sourceRow = (page: Page, name: string) =>
  page.getByRole("row").filter({ has: page.getByRole("cell", { name, exact: true }) });

async function signIn(page: Page, who: Account, role: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(who.username);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  const block = userBlock(page);
  await expect(block).toContainText(who.username);
  await expect(block).toContainText(roleLabel(role));
}

/** One refused attempt on the login page. Resolves once the page has handled the answer (the page empties the password box then). */
async function refusedAttempt(page: Page, who: Account, password: string): Promise<{ status: number; message: string }> {
  const box = page.getByLabel("Password", { exact: true });
  await page.getByLabel("Username").fill(who.username);
  await box.fill(password);
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/login"),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  await expect(box).toHaveValue("");
  return { status: response.status(), message: (await page.getByRole("alert").textContent()) ?? "" };
}

async function createUser(page: Page, who: Account & { role: string }) {
  await navLink(page, "Users & Roles").click();
  await expect(page.getByRole("heading", { name: "Users & Roles", exact: true })).toBeVisible();
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Create user" }) });
  await form.getByLabel("Username").fill(who.username);
  await form.getByLabel("Password").fill(who.password);
  await form.getByLabel("Role").selectOption({ value: who.role });
  await form.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByRole("cell", { name: who.username, exact: true })).toBeVisible();
}

/** Every /api answer the page receives from now on, as text (the live-update stream is skipped: its body never ends). */
function recordApiBodies(page: Page): () => Promise<string[]> {
  const bodies: Promise<string>[] = [];
  page.on("response", (response) => {
    if (!new URL(response.url()).pathname.startsWith("/api/")) return;
    if ((response.headers()["content-type"] ?? "").includes("text/event-stream")) return;
    bodies.push(response.text().catch(() => ""));
  });
  return () => Promise.all(bodies);
}

/** The source.updated entries that mention `name`, newest first. */
async function sourceUpdates(page: Page, name: string): Promise<ApiAuditEntry[]> {
  const log = await getJson<{ items: ApiAuditEntry[] }>(
    page, `/api/audit?action=source.updated&q=${encodeURIComponent(name)}&limit=10`,
  );
  return log.items;
}

/** The two numbers of the sign-in policy as they were before the spec touched them (undefined until beforeAll has read them). */
let foundPolicy: { max_failures: number; block_minutes: number } | undefined;

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

test.beforeAll(async ({ browser }) => {
  foundPolicy = await asAdmin(browser, async (request) => {
    const got = await request.get("/api/settings/sign-in");
    expect(got.ok(), `reading the policy: ${got.status()} ${await got.text()}`).toBe(true);
    const { max_failures, block_minutes } = (await got.json()) as { max_failures: number; block_minutes: number };
    return { max_failures, block_minutes };
  });
});

test.afterAll(async ({ browser }) => {
  // Put the policy back to what beforeAll found, even when the test failed half way. Nothing to restore if it was never read.
  if (!foundPolicy) return;
  const restore = foundPolicy;
  await asAdmin(browser, async (request) => {
    const put = await request.put("/api/settings/sign-in", { data: restore });
    expect(put.ok(), `restoring ${restore.max_failures} / ${restore.block_minutes}: ${put.status()} ${await put.text()}`).toBe(true);
  });
});

test("W3d: block, unblock and delete an account, and a source never shows the credentials stored in its URL", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const victimContext = await browser.newContext({ baseURL: BASE_URL });
  const victimPage = await victimContext.newPage();
  const rows = page.locator("tbody tr");

  await test.step("the admin signs in, clears what an earlier run left, and creates w3d-victim on the Users page", async () => {
    await signIn(page, ADMIN, "admin");
    const users = await getJson<ApiUser[]>(page, "/api/users");
    for (const old of users.filter((u) => u.username === VICTIM.username)) await send(page, "delete", `/api/users/${old.id}`);
    const sources = await getJson<ApiSource[]>(page, "/api/sources");
    for (const old of sources.filter((s) => s.name === SOURCE || s.name === RENAMED)) {
      await send(page, "delete", `/api/sources/${old.id}?confirm=true`);
    }

    await createUser(page, VICTIM);
    // Your own account cannot be deleted from here; a row that is not blocked offers no Unblock (checked in its open menu).
    await expect(page.getByRole("button", { name: "Delete admin", exact: true })).toBeDisabled();
    await expect(userRow(page, VICTIM.username).getByRole("button", { name: `Delete ${VICTIM.username}` })).toBeEnabled();
    await expectNoRowAction(page, userRow(page, VICTIM.username), "Unblock");
  });

  await test.step("Settings: 3 failed sign-ins block an account for 1 minute", async () => {
    await navLink(page, "Settings").click();
    await expect(page.getByRole("heading", { name: "Sign-in protection" })).toBeVisible();
    const failures = page.getByLabel("Failed sign-ins before a block", { exact: true });
    const minutes = page.getByLabel("Block time in minutes", { exact: true });
    await expect(failures).toHaveValue(/^\d+$/); // the stored numbers have arrived
    await failures.fill("3");
    await minutes.fill("1");
    await page.getByRole("button", { name: "Save sign-in protection", exact: true }).click();
    // the button keeps its aria-label in every phase; the green shows as data-phase (for 2.5 s)
    await expect(page.getByRole("button", { name: "Save sign-in protection", exact: true })).toHaveAttribute("data-phase", "saved");
    expect(await getJson(page, "/api/settings/sign-in")).toMatchObject({ max_failures: 3, block_minutes: 1 });
  });

  await test.step("in another browser, three wrong passwords block w3d-victim, and even the right password is refused", async () => {
    await victimPage.goto("/login");
    for (let i = 1; i <= 3; i++) {
      const wrong = await refusedAttempt(victimPage, VICTIM, `not-the-password-${i}`);
      expect(wrong, `wrong password ${i}`).toEqual({ status: 401, message: "Invalid username or password" });
    }
    const blocked = await refusedAttempt(victimPage, VICTIM, VICTIM.password);
    expect(blocked.status).toBe(429);
    await expect(victimPage.getByRole("alert")).toHaveText("Too many failed attempts, try again in about 1 minute");
    await expect(victimPage.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  await test.step("the Users page shows the account as blocked; Unblock lets it in", async () => {
    await page.goto("/users"); // a fresh load, so the list is not an earlier answer
    const row = userRow(page, VICTIM.username);
    await expect(row.getByText("blocked", { exact: true })).toBeVisible();
    await (await rowAction(page, row, "Unblock")).click();
    await expect(row.getByText("blocked", { exact: true })).toHaveCount(0);
    await expectNoRowAction(page, row, "Unblock");

    await signIn(victimPage, VICTIM, VICTIM.role);
    await signOut(victimPage);
  });

  await test.step("Delete asks first: Cancel keeps the account, Delete user removes it, and it can no longer sign in", async () => {
    const row = userRow(page, VICTIM.username);
    await row.getByRole("button", { name: `Delete ${VICTIM.username}` }).click();
    const dialog = page.getByRole("dialog", { name: `Delete user ${VICTIM.username}?` });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`${VICTIM.username} will no longer be able to sign in.`);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: `Delete ${VICTIM.username}` }).click();
    await page.getByRole("dialog", { name: `Delete user ${VICTIM.username}?` }).getByRole("button", { name: "Delete user", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("cell", { name: VICTIM.username, exact: true })).toHaveCount(0);

    const refused = await refusedAttempt(victimPage, VICTIM, VICTIM.password);
    expect(refused).toEqual({ status: 401, message: "Invalid username or password" });
  });

  await test.step("the Audit page names the deletion, and the earlier entries still read w3d-victim", async () => {
    // The address holds the search, so the first answer the page asks for is already the filtered one.
    await page.goto(`/audit?q=${encodeURIComponent(VICTIM.username)}`);
    await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
    await expect(page.getByLabel("Search", { exact: true })).toHaveValue(VICTIM.username);
    await expect(rows.filter({ hasText: `Deleted user ${VICTIM.username}` }).first()).toBeVisible();

    // The sign-in failures and the block were written while the account existed; the account is gone now, the name on them is not.
    const attacked = rows.filter({ hasText: /Failed sign-in to this account|Sign-in blocked after repeated failures/ });
    await expect(attacked.first()).toBeVisible();
    const withName = attacked.filter({ has: page.getByRole("cell", { name: VICTIM.username, exact: true }) });
    await expect(withName).toHaveCount(await attacked.count());

    // The User filter lists the account as one that no longer exists.
    await expect(
      page.getByLabel("User", { exact: true }).getByRole("option", { name: new RegExp(`^${VICTIM.username} \\(deleted\\)`) }).first(),
    ).toBeAttached();
  });

  await test.step("a source with credentials in its URL: the page and every answer it receives hide them", async () => {
    const created = (await send<ApiSource>(page, "post", "/api/sources", {
      name: SOURCE, connector_type: "simulator", enabled: false, config: { url: `http://svc:${SECRET}@simulator:9000` },
    }))!;
    expect(JSON.stringify(created), "the answer to the create").not.toContain(SECRET);
    expect(created.hidden_config_keys).toEqual(["url"]);

    const apiBodies = recordApiBodies(page);
    await navLink(page, "Sources").click();
    await expect(page.getByRole("heading", { name: "Sources", exact: true })).toBeVisible();
    await (await rowAction(page, sourceRow(page, SOURCE), "Edit")).click();
    let dialog = page.getByRole("dialog", { name: `Edit source ${SOURCE}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/^The user name and password stored in Url are hidden/)).toBeVisible();
    await expect(dialog.getByLabel("Url", { exact: true })).toHaveValue(/^http:\/\/simulator:9000\/?$/);
    const remove = dialog.getByLabel("Remove the credentials stored in Url", { exact: true });
    await expect(remove).not.toBeChecked();
    await expect(page.locator("body")).not.toContainText(SECRET);

    // Saving only a new name keeps what was stored: no credentials entry in the audit row of the rename, and still a hidden part.
    await dialog.getByLabel("Name", { exact: true }).fill(RENAMED);
    const [rename] = await Promise.all([
      page.waitForRequest((r) => r.method() === "PATCH" && new URL(r.url()).pathname === `/api/sources/${created.id}`),
      dialog.getByRole("button", { name: "Save", exact: true }).click(),
    ]);
    expect(rename.postDataJSON()).not.toHaveProperty("clear_config_credentials");
    expect(rename.postData() ?? "").not.toContain(SECRET);
    await expect(dialog).toBeHidden();
    await expect(sourceRow(page, RENAMED)).toBeVisible();
    const afterRename = (await getJson<ApiSource[]>(page, "/api/sources")).find((s) => s.id === created.id)!;
    expect(afterRename.hidden_config_keys, "the rename kept the stored credentials").toEqual(["url"]);
    const renameEntry = (await sourceUpdates(page, RENAMED))[0];
    expect(renameEntry.detail.after).toMatchObject({ name: RENAMED });
    expect(renameEntry.detail.before).not.toHaveProperty("config_credentials");
    expect(renameEntry.detail.after).not.toHaveProperty("config_credentials");

    // Ticking Remove and saving drops them, and the audit row says the credentials changed (never what they were).
    await (await rowAction(page, sourceRow(page, RENAMED), "Edit")).click();
    dialog = page.getByRole("dialog", { name: `Edit source ${RENAMED}` });
    await expect(dialog.getByText(/^The user name and password stored in Url are hidden/)).toBeVisible();
    await dialog.getByLabel("Remove the credentials stored in Url", { exact: true }).check();
    const [removal] = await Promise.all([
      page.waitForRequest((r) => r.method() === "PATCH" && new URL(r.url()).pathname === `/api/sources/${created.id}`),
      dialog.getByRole("button", { name: "Save", exact: true }).click(),
    ]);
    expect(removal.postDataJSON()).toMatchObject({ clear_config_credentials: ["url"] });
    expect(removal.postData() ?? "").not.toContain(SECRET);
    await expect(dialog).toBeHidden();
    const afterRemoval = (await getJson<ApiSource[]>(page, "/api/sources")).find((s) => s.id === created.id)!;
    expect(afterRemoval.hidden_config_keys, "nothing is hidden any more").toEqual([]);
    const removalEntry = (await sourceUpdates(page, RENAMED))[0];
    expect(removalEntry.id).toBeGreaterThan(renameEntry.id);
    expect(removalEntry.detail.after).toMatchObject({ config_credentials: "changed" });
    expect(JSON.stringify(removalEntry)).not.toContain(SECRET);

    // Open again: nothing is hidden, so neither the note nor the checkbox is offered.
    await (await rowAction(page, sourceRow(page, RENAMED), "Edit")).click();
    dialog = page.getByRole("dialog", { name: `Edit source ${RENAMED}` });
    await expect(dialog.getByLabel("Url", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/^The user name and password stored in/)).toHaveCount(0);
    await expect(dialog.getByLabel("Remove the credentials stored in Url", { exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();

    // Nothing the page was sent, showed, or holds in its markup carried the password. The recorder must have seen the sources list.
    const seen = await apiBodies();
    expect(seen.some((body) => body.includes(RENAMED)), "the recorder saw the sources answers").toBe(true);
    expect(seen.filter((body) => body.includes(SECRET)), "answers that carry the password").toEqual([]);
    expect(await page.content()).not.toContain(SECRET);
    expect(JSON.stringify(await getJson<ApiSource[]>(page, "/api/sources"))).not.toContain(SECRET);

    await send(page, "delete", `/api/sources/${created.id}?confirm=true`);
  });

  await victimContext.close();
});
