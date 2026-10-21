import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { roleLabel } from "./roles";
import { navLink, rowAction, userBlock } from "./shell";

// W8 (field diagnostics): the admin Diagnostics page (a pasteable report with a header and a checksum line per part, a masked variant with
// an address key, Copy and Download), the audit row a build leaves, and the step-by-step connection check, which an operator reaches
// from a Sources row. Runs on the state the earlier projects leave behind: admin `admin` / `correct-horse` and the source `sim`
// (a simulator source, so its check is the one generic `Connection test` step; the nine OPC UA steps are covered by the backend tests).
// The spec makes its own operator through the API and deletes it again. Nothing else is written, except the audit rows and jobs a
// report and a check leave.
//
// Locators: the Report card's select and the check panel's select both contain "Source", so the check's is matched by its exact label;
// sidebar links go through `navLink` (e2e/shell.ts).

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse", role: "admin" };
const OPERATOR = { username: "w8-operator", password: "w8-operator-pass", role: "operator" };
type Account = typeof ADMIN;

/** How long the API makes a source wait between two checks (backend api/sources.py): a second check sooner answers 429. */
const COOLDOWN_MS = 5_500;
const CHECK_WAIT = 60_000;

async function signIn(page: Page, who: Account) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(who.username);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(userBlock(page)).toContainText(who.username);
  await expect(userBlock(page)).toContainText(roleLabel(who.role));
}

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

const reportBox = (page: Page, index = 1, of = 1) => page.getByRole("textbox", { name: `Report part ${index} of ${of}`, exact: true });
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Waits for the check shown in `scope` to pass. A check right after another one on the same source is answered with the cooldown
 * sentence (429); then the button is pressed once more after the cooldown.
 */
async function untilChecked(scope: Locator) {
  const passed = scope.getByText("Every step passed.");
  const tooSoon = scope.getByText(/finished a moment ago/);
  await expect(passed.or(tooSoon)).toBeVisible({ timeout: CHECK_WAIT });
  if (await tooSoon.isVisible()) {
    await scope.page().waitForTimeout(COOLDOWN_MS);
    await scope.getByRole("button", { name: "Run connection check" }).click();
  }
  await expect(passed).toBeVisible({ timeout: CHECK_WAIT });
}

test.describe("W8: field diagnostics", () => {
  let buildId = "";

  test.beforeAll(async ({ browser }) => {
    await asAdmin(browser, async (request) => {
      const version = await request.get("/api/version");
      expect(version.ok(), "reading the build id").toBe(true);
      buildId = ((await version.json()) as { build_id: string }).build_id;
      const made = await request.post("/api/users", { data: { username: OPERATOR.username, password: OPERATOR.password, role: OPERATOR.role } });
      expect(made.ok(), `creating the operator: ${made.status()} ${await made.text()}`).toBe(true);
    });
  });

  test.afterAll(async ({ browser }) => {
    await asAdmin(browser, async (request) => {
      const users = (await (await request.get("/api/users")).json()) as { id: number; username: string }[];
      const mine = users.find((u) => u.username === OPERATOR.username);
      if (mine) await request.delete(`/api/users/${mine.id}`);
    });
  });

  test("an admin builds a summary report: header, size, checksum line, build id, and an audit row without the content", async ({ page }) => {
    await signIn(page, ADMIN);
    await navLink(page, "Diagnostics").click();
    await expect(page).toHaveURL(/\/diagnostics$/);
    await expect(page.getByRole("heading", { level: 1, name: "Diagnostics", exact: true })).toBeVisible();
    await expect(page.getByText(/Nothing built yet/)).toBeVisible();

    await page.getByRole("button", { name: "Build report" }).click();
    const box = reportBox(page);
    await expect(box).toBeVisible();
    await expect(box).toHaveValue(/^DCDASH-REPORT v1 \| PART 1 OF 1 \| build /);
    await expect(box).toHaveValue(new RegExp(`build ${escaped(buildId)} \\|`));
    await expect(box).toHaveValue(/\nEND OF REPORT [0-9a-f]{12}$/);
    await expect(box).toHaveValue(/== SOURCES ==/);
    await expect(box).toHaveValue(/\bsim\b/); // the seeded source is listed
    await expect(box).toHaveValue(/CONNECTION CHECKS/);
    await expect(page.getByText(/^[\d,]+ characters of content, [\d,]+ lines$/)).toBeVisible();
    await expect(page.getByText(/^Built a summary report in 1 part, /)).toBeVisible();
    await expect(page.getByText("Address key")).toHaveCount(0); // not masked

    // The build is audited, and the row says how it was asked for, never what the report said.
    await navLink(page, "Audit").click();
    const row = page.getByRole("row").filter({ hasText: "Generated a diagnostics report (summary, not masked)" }).first();
    await expect(row).toBeVisible();
    await expect(page.getByText("DCDASH-REPORT v1")).toHaveCount(0);
  });

  test("a masked report names no source address in its text, and the address key lists what each alias stands for", async ({ page }) => {
    await signIn(page, ADMIN);
    const sources = await page.request.get("/api/sources");
    expect(sources.ok()).toBe(true);
    const sim = ((await sources.json()) as { name: string; config: { url?: string } }[]).find((s) => s.name === "sim");
    expect(sim?.config.url, "the seeded source has a url").toBeTruthy();
    const host = new URL(sim!.config.url!).host; // simulator:9000

    await page.goto("/diagnostics");
    await page.getByLabel("Hide host names and addresses").check();
    await page.getByRole("button", { name: "Build report" }).click();
    const box = reportBox(page);
    await expect(box).toBeVisible();
    await expect(box).toHaveValue(/HOST-\d+/);
    // "simulator" is also the source's connector type, so the word alone proves nothing; the address in any of its shapes must be gone.
    await expect(box).not.toHaveValue(new RegExp(escaped(host)));
    await expect(box).not.toHaveValue(new RegExp(`//${escaped(host.split(":")[0])}`));
    await expect(box).toHaveValue(/\nEND OF REPORT [0-9a-f]{12}$/);
    await expect(page.getByText(/host names and addresses hidden\.$/)).toBeVisible();

    const key = page.locator("details.address-key");
    await expect(key).toBeVisible();
    await expect(key.getByRole("cell", { name: /simulator/ }).first()).toBeHidden(); // collapsed
    await key.getByText("Address key").click();
    await expect(key.getByRole("cell", { name: /simulator/ }).first()).toBeVisible();
    await expect(key.getByRole("cell", { name: /^HOST-\d+$/ }).first()).toBeVisible();
  });

  test("Copy puts the exact text of the part on the clipboard, and Download saves the same text", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await signIn(page, ADMIN);
    await page.goto("/diagnostics");
    await page.getByRole("button", { name: "Build report" }).click();
    const box = reportBox(page);
    await expect(box).toBeVisible();
    const shown = await box.inputValue();

    await page.getByRole("button", { name: "Copy part 1 of 1" }).click();
    await expect(page.getByText("Copied part 1 of 1.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);

    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download .txt" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^dcdash-report-.+-summary\.txt$/);
    const saved = (await readFile((await download.path())!)).toString("utf8");
    expect(saved).toBe(shown); // one part: the file is the part
    expect(requests.filter((url) => url.includes("/api/diagnostics/report"))).toEqual([]); // saved from the held text, no second request
  });

  test("the admin's Diagnostics page runs a connection check on a chosen source and shows its steps", async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto("/diagnostics");
    const card = page.locator(".page-card").filter({ has: page.getByRole("heading", { name: "Connection check", exact: true }) });
    await card.getByRole("combobox").selectOption({ label: "sim" }); // the label wraps the select, so its name includes the options
    await card.getByRole("button", { name: "Run connection check" }).click();
    await untilChecked(card);
    const steps = card.getByRole("list", { name: "Check steps" }).getByRole("listitem");
    await expect(steps).toHaveCount(1);
    await expect(steps.first()).toContainText("Connection test");
    await expect(steps.first()).toContainText(/detailed step-by-step check exists for OPC UA sources only/);
    await expect(card.getByText(/^Checked at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  });

  test("an operator has no Diagnostics, is turned away from it and from the report, but checks a source from its row", async ({ page }) => {
    await signIn(page, OPERATOR);
    await expect(navLink(page, "Sources")).toBeVisible();
    await expect(navLink(page, "Diagnostics")).toHaveCount(0);

    await page.goto("/diagnostics");
    await expect(page.getByRole("heading", { name: "No access" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Build report" })).toHaveCount(0);
    expect((await page.request.get("/api/diagnostics/report")).status()).toBe(403);

    await navLink(page, "Sources").click();
    const row = page.getByRole("row").filter({ has: page.locator(".cell-name[title=\"sim\"]") });
    await (await rowAction(page, row, "Check connection")).click();
    const dialog = page.getByRole("dialog", { name: "Check connection: sim", exact: true });
    await expect(dialog).toBeVisible();
    await untilChecked(dialog); // the dialog queued the check by itself
    await expect(dialog.getByRole("listitem")).toContainText(["Connection test"]);
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeVisible();
  });
});
