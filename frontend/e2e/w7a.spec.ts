import { expect, test, type Page } from "@playwright/test";
import { roleLabel } from "./roles";
import { signOut, treeLink, userBlock } from "./shell";

// W7a (the Assets workspace and the shell: a navy top bar with quick find, status chip, site time and profile panel; pages at full
// width; breadcrumbs; the asset tree beside `/assets` and every `/assets/:id`; the fleet summary on `/assets`) on the state the earlier
// projects leave behind: admin `admin` / `correct-horse`; the root asset `Site` with `Panel 01` and `LVP02` ... `LVP10` below it, the root
// `MV2`, and a collector that has been polling for some minutes. Every case signs in on its own and gets a fresh browser context, so the
// remembered tree width and folds (localStorage) start empty; nothing is written to the database.
//
// Locators: a tree node link and a crumb link can carry the same name, so asset names go through `treeLink`, and the profile trigger
// through `userBlock` (e2e/shell.ts).

const ADMIN = { username: "admin", password: "correct-horse" };

// frontend/src/lib/treeWidth.ts: the narrowest the tree column goes, and the width of one arrow key press.
const TREE_MIN = 220;
const TREE_STEP = 16;

interface ApiAsset { id: number; parent_id: number | null; name: string }

async function getJson<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.ok(), path).toBe(true);
  return (await response.json()) as T;
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN.username);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(userBlock(page)).toContainText(ADMIN.username);
  await expect(userBlock(page)).toContainText(roleLabel("admin"));
}

test.describe("W7a: the Assets workspace and the shell", () => {
  let assets: ApiAsset[] = [];
  const idOf = (name: string) => {
    const found = assets.filter((a) => a.name === name);
    expect(found, `asset ${name}`).toHaveLength(1);
    return found[0].id;
  };
  const tree = (page: Page) => page.getByRole("region", { name: "Asset tree" });
  const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    assets = await getJson<ApiAsset[]>(page, "/api/assets");
  });

  test("a tree node opens its asset with one click, and the tree stays beside it", async ({ page }) => {
    await page.goto("/assets");
    await expect(tree(page)).toBeVisible();
    // Tag the tree's element: if the tree were rebuilt on a navigation the tag would be gone.
    await tree(page).evaluate((el) => el.setAttribute("data-w7a", "kept"));

    await treeLink(page, "MV2").click();
    await expect(page).toHaveURL(new RegExp(`/assets/${idOf("MV2")}$`)); // no "Selected: ... (open page)" step in between
    await expect(heading1(page, "MV2")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Metrics" })).toBeVisible();
    await expect(treeLink(page, "MV2")).toHaveAttribute("aria-current", "true");

    await treeLink(page, "Panel 01").click();
    await expect(page).toHaveURL(new RegExp(`/assets/${idOf("Panel 01")}$`));
    await expect(heading1(page, "Panel 01")).toBeVisible();
    await expect(treeLink(page, "Panel 01")).toHaveAttribute("aria-current", "true");
    await expect(treeLink(page, "MV2")).not.toHaveAttribute("aria-current", "true");
    await expect(tree(page)).toHaveAttribute("data-w7a", "kept");
  });

  test("the crumb Assets Tree leads back to the fleet summary, with the tree still there", async ({ page }) => {
    await page.goto(`/assets/${idOf("Panel 01")}`);
    await expect(heading1(page, "Panel 01")).toBeVisible();
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    // Assets Tree / Site / Panel 01: the ancestors are links, the asset itself is the current page
    await expect(crumbs.getByRole("link")).toHaveText(["Assets Tree", "Site"]);

    await crumbs.getByRole("link", { name: "Assets Tree", exact: true }).click();
    await expect(page).toHaveURL(/\/assets$/);
    await expect(heading1(page, "Assets Tree")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();
    await expect(tree(page)).toBeVisible();
    await expect(treeLink(page, "Panel 01")).not.toHaveAttribute("aria-current", "true");
  });

  test("the tree column resizes by keyboard, and the width survives a reload", async ({ page }) => {
    await page.goto("/assets");
    const handle = page.getByRole("separator", { name: "Resize the tree column" });
    await handle.focus();
    // Home goes to the minimum, so the rest does not depend on the default width.
    await page.keyboard.press("Home");
    await expect(handle).toHaveAttribute("aria-valuenow", String(TREE_MIN));
    for (let press = 0; press < 3; press++) await page.keyboard.press("ArrowRight");
    const wanted = TREE_MIN + 3 * TREE_STEP;
    await expect(handle).toHaveAttribute("aria-valuenow", String(wanted));
    await expect(tree(page)).toHaveAttribute("style", new RegExp(`--tree-user-w:\\s*${wanted}px`));

    await page.reload();
    await expect(handle).toHaveAttribute("aria-valuenow", String(wanted));
    await expect(tree(page)).toHaveAttribute("style", new RegExp(`--tree-user-w:\\s*${wanted}px`));
  });

  test("Collapse all folds the branches, Expand all opens them, and the fold survives a reload", async ({ page }) => {
    await page.goto("/assets"); // nothing is selected here, so no ancestor is unfolded to reveal a selection
    const panel = treeLink(page, "Panel 01"); // a child of Site
    const collapse = page.getByRole("button", { name: "Collapse all", exact: true });
    const expand = page.getByRole("button", { name: "Expand all", exact: true });
    const twisties = (expanded: boolean) => page.getByRole("button", { name: /^Children of /, expanded });
    await expect(panel).toBeVisible();

    await collapse.click();
    await expect(panel).toBeHidden();
    await expect(treeLink(page, "Site")).toBeVisible(); // only the children are folded away
    await expect(twisties(true)).toHaveCount(0);
    expect(await twisties(false).count(), "folded branches").toBeGreaterThan(0);

    await expand.click();
    await expect(panel).toBeVisible();
    await expect(twisties(false)).toHaveCount(0);

    await collapse.click();
    await expect(panel).toBeHidden();
    await page.reload();
    await expect(treeLink(page, "Site")).toBeVisible();
    await expect(panel).toBeHidden();
    await expect(twisties(true)).toHaveCount(0);

    await expand.click();
    await expect(panel).toBeVisible();
  });

  test("quick find: Ctrl+K, type, choose with the arrows and Enter", async ({ page }) => {
    await page.goto("/assets");
    const find = page.getByRole("combobox", { name: "Quick find" });
    await expect(find).toBeVisible(); // the shortcut is registered when the shell mounts; a key pressed before that goes nowhere
    await page.keyboard.press("Control+k");
    await expect(find).toBeFocused();
    await page.keyboard.type("LVP05");
    const option = page.getByRole("option", { name: /^LVP05/ });
    await expect(option).toBeVisible();
    // Enter acts on the option the arrows are on; with none chosen it does nothing.
    await page.keyboard.press("ArrowDown");
    await expect(option).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/assets/${idOf("LVP05")}$`));
    await expect(heading1(page, "LVP05")).toBeVisible();
    await expect(find).toHaveValue("");
    await expect(page.getByRole("listbox", { name: "Suggestions" })).toHaveCount(0);
    await expect(treeLink(page, "LVP05")).toHaveAttribute("aria-current", "true");
  });

  test("quick find: the first Escape closes the list and keeps the text, the second clears it", async ({ page }) => {
    await page.goto("/assets");
    const find = page.getByRole("combobox", { name: "Quick find" });
    const list = page.getByRole("listbox", { name: "Suggestions" });
    await expect(find).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(find).toBeFocused();
    await page.keyboard.type("LVP05");
    await expect(list).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(find).toHaveValue("LVP05");
    await expect(find).toHaveAttribute("aria-expanded", "false");
    await expect(page).toHaveURL(/\/assets$/);

    await page.keyboard.press("Escape");
    await expect(find).toHaveValue("");
  });

  test("the status chip says Live while the simulator runs", async ({ page }) => {
    await page.goto("/assets");
    const chip = page.locator(".navbar .live");
    await expect(chip.locator("b")).toHaveText("Live", { timeout: 30_000 });
    await expect(chip).toHaveAttribute("data-state", "live");
  });

  test("Billing and Users use the whole width of a 1920 px window", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    for (const [path, title] of [["/billing", "Billing"], ["/users", "Users"]] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      // main's content box: its width without the padding (no 1200 px cap)
      const content = await page.locator("main").evaluate((el) => {
        const style = getComputedStyle(el);
        return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      });
      expect(content, `${path}: width of main's content box`).toBeGreaterThan(1500);
    }
  });

  test("the Assets landing page shows four tiles and Needs attention", async ({ page }) => {
    await page.goto("/assets");
    await expect(heading1(page, "Assets Tree")).toBeVisible();
    const tiles = page.locator(".fleet-tiles .tile");
    await expect(tiles).toHaveCount(4);
    await expect(tiles).toHaveText([/^Assets\s*\d+$/, /^Live power/, /^Energy today/, /^Cost today/]);
    await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();
  });

  // Last: it ends the session.
  test("the profile panel: Cancel keeps the session, confirming signs out", async ({ page }) => {
    await page.goto("/assets");
    await userBlock(page).click();
    const bar = page.locator(".navbar");
    await expect(bar.getByRole("link", { name: "Password", exact: true })).toBeVisible(); // the panel is open
    await bar.getByRole("button", { name: "Sign out", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: /^Sign out/ });
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/assets$/);
    await expect(userBlock(page)).toContainText(ADMIN.username);
    expect((await page.request.get("/api/me")).status(), "still signed in on the server").toBe(200);

    await signOut(page);
    await expect(page).toHaveURL(/\/login$/);
    expect((await page.request.get("/api/me")).status(), "signed out on the server").toBe(401);
  });
});
