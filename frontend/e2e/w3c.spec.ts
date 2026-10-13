import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { roleLabel } from "./roles";
import { navLink, signOut, userBlock } from "./shell";

// W3c (the Audit screen: filters, quick filters, search, a permanent link per entry, links to the thing an entry is about, the friendly
// and the raw view, CSV export, "Go to date", page size and page controls, admin only) on the state the earlier projects leave behind:
// admin `admin` / `correct-horse`, the operator `operator1` / `operator-pass-1` (phase3), the root asset `Site`. The spec makes its own
// audit rows through the JSON API (two assets, one deleted, a dashboard, 30 renames) and leaves them behind.
//
// Playwright's getByLabel / getByRole(name) match substrings, case-insensitively: the labels and buttons below that are prefixes or
// parts of others (To, Search, Page, Last, Go, Raw, First) are matched with `exact: true`.

const ADMIN = { username: "admin", password: "correct-horse" };
const OPERATOR = { username: "operator1", password: "operator-pass-1", role: "operator" };

// A run suffix, so the spec can run again on a stack an earlier run left its assets and dashboards on.
const RUN = Date.now().toString(36);
const KEEP = `W3c keep ${RUN}`;
const GONE = `W3c gone ${RUN}`;
const BOARD = `W3c board ${RUN}`;

interface ApiAsset { id: number; parent_id: number | null; name: string }

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

async function signIn(page: Page, who: { username: string; password: string }, role: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(who.username);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  const block = userBlock(page);
  await expect(block).toContainText(who.username);
  await expect(block).toContainText(roleLabel(role));
}

/** Today as `YYYY-MM-DD` on the site's wall clock, which is what the screen and the API call "today". */
async function siteToday(page: Page): Promise<string> {
  const site = await getJson<{ timezone: string }>(page, "/api/site");
  return new Intl.DateTimeFormat("en-CA", { timeZone: site.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

test("W3c: the audit screen filters, links, exports and pages, and is for admins only", async ({ page }) => {
  test.setTimeout(300_000);
  const rows = page.locator(".audit-table tbody tr"); // the real table: the loading skeleton's rows are `tbody tr` too (W7f)
  const filterBy = (label: string) => page.getByLabel(label, { exact: true });

  await test.step("the admin signs in and makes some audit rows through the API", async () => {
    await signIn(page, ADMIN, "admin");
    const assets = await getJson<ApiAsset[]>(page, "/api/assets");
    const root = assets.find((a) => a.name === "Site" && a.parent_id === null);
    expect(root, "the root asset Site").toBeTruthy();
    const keep = (await send<ApiAsset>(page, "post", "/api/assets", { name: KEEP, parent_id: root!.id, kind: "generic", sort_order: 0 }))!;
    const gone = (await send<ApiAsset>(page, "post", "/api/assets", { name: GONE, parent_id: root!.id, kind: "generic", sort_order: 0 }))!;
    await send(page, "delete", `/api/assets/${gone.id}`);
    await send(page, "post", "/api/dashboards", { name: BOARD, range: "24h" });
    // 30 renames, so the log certainly has more than one page of 25.
    for (let i = 1; i <= 30; i++) await send(page, "patch", `/api/assets/${keep.id}`, { name: `${KEEP} r${i}` });
  });

  await test.step("the Action filter, the Deletions quick filter and the search narrow the log, and the address holds them", async () => {
    await navLink(page, "Audit").click();
    await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
    await expect(rows.first()).toBeVisible();

    await filterBy("Action").selectOption("asset.created");
    await expect(page).toHaveURL(/action=asset\.created/);
    await expect(rows.filter({ hasText: KEEP })).toHaveCount(1);
    await expect(rows.filter({ hasNotText: /Created/ })).toHaveCount(0);

    const deletions = page.getByRole("button", { name: "Deletions", exact: true });
    await deletions.click();
    await expect(deletions).toHaveAttribute("aria-pressed", "true");
    await expect(rows.filter({ hasText: GONE })).toHaveCount(1);
    await expect(rows.filter({ hasNotText: /Deleted/ })).toHaveCount(0);
    await deletions.click();
    await expect(deletions).toHaveAttribute("aria-pressed", "false");

    await filterBy("Search").fill(GONE);
    await expect(page).toHaveURL(/q=W3c/);
    // The creation and the deletion of that one asset, both mention it, nothing else does.
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: GONE })).toHaveCount(2);

    await page.reload();
    await expect(filterBy("Search")).toHaveValue(GONE);
    await expect(rows).toHaveCount(2);
  });

  await test.step("an entry has its own page with the friendly text and the raw JSON", async () => {
    await rows.first().locator("td.cell-time").getByRole("link").click(); // the Details chevron is the first cell (W7j)
    await expect(page).toHaveURL(/\/audit\/\d+$/);
    await expect(page.getByRole("heading", { name: /^Audit entry #\d+$/ })).toBeVisible();
    await expect(page.getByText(GONE).first()).toBeVisible();
    await expect(page.locator("pre")).toContainText('"name"');
    await page.getByRole("link", { name: "Back to the log" }).click();
    await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  });

  await test.step("a created asset links to the asset, and the raw view shows the stored action", async () => {
    await page.goto(`/audit?action=asset.created&q=${encodeURIComponent(KEEP)}`);
    const link = page.getByRole("link", { name: new RegExp(`^Open asset.*${KEEP}`) });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByRole("heading", { name: new RegExp(KEEP) })).toBeVisible();

    await page.goto(`/audit?action=asset.created&q=${encodeURIComponent(KEEP)}`);
    await page.getByRole("button", { name: "Raw", exact: true }).click();
    await expect(page).toHaveURL(/view=raw/);
    await expect(page.getByRole("columnheader", { name: "Action" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "asset.created", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Friendly", exact: true }).click();
    await expect(page.getByRole("columnheader", { name: "What happened" })).toBeVisible();
  });

  await test.step("Export CSV downloads the filtered log: a byte-order mark, the five columns, only the matching rows", async () => {
    await page.goto(`/audit?q=${encodeURIComponent(GONE)}`);
    await expect(rows).toHaveCount(2);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^audit-\d{8}-\d{4}\.csv$/);
    const bytes = readFileSync((await download.path())!);
    expect([...bytes.subarray(0, 3)], "the UTF-8 byte-order mark").toEqual([0xef, 0xbb, 0xbf]);
    const lines = bytes.subarray(3).toString("utf8").trimEnd().split("\r\n");
    expect(lines[0]).toBe("id,time,user,action,detail");
    expect(lines.length - 1, "one line per matching entry").toBe(2);
    expect(lines.slice(1).every((line) => line.includes(GONE))).toBe(true);
  });

  await test.step("Go to date: today keeps the newest entry on top, a long-gone day says so", async () => {
    await page.goto("/audit");
    await expect(rows.first()).toBeVisible();
    const today = await siteToday(page);
    await filterBy("Go to date").fill(today);
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect(page.getByText(/No entries on/)).toHaveCount(0);
    await expect(rows.first().locator("td.cell-time")).toContainText(today);

    await filterBy("Go to date").fill("2001-01-01");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect(page.getByText("No entries on 2001-01-01; showing the nearest ones.")).toBeVisible();
  });

  await test.step("a page size of 25 pages the log, and the controls move through it", async () => {
    await page.goto("/audit");
    await expect(rows.first()).toBeVisible();
    await filterBy("Rows per page").selectOption("25");
    await expect(rows).toHaveCount(25);
    await expect(page.getByText(/^Showing 1–25 of \d+$/)).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText(/^Showing 26–\d+ of \d+$/)).toBeVisible();
    await expect(page.getByText(/^Page 2 of \d+$/)).toBeVisible();
    await page.getByRole("button", { name: "Last", exact: true }).click();
    await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "First", exact: true }).click();
    await expect(page.getByText(/^Showing 1–25 of \d+$/)).toBeVisible();
  });

  await test.step("an operator has no Audit link, is turned away from the page and from the API", async () => {
    await signOut(page);
    await signIn(page, OPERATOR, OPERATOR.role);
    await expect(page.getByRole("link", { name: "Audit", exact: true })).toHaveCount(0);
    await page.goto("/audit");
    await expect(page.getByRole("heading", { name: "Admins only" })).toBeVisible();
    for (const path of ["/api/audit", "/api/audit/options", "/api/audit.csv"]) {
      expect((await page.request.get(path)).status(), path).toBe(403);
    }
  });
});
