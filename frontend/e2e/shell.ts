import { expect, type Locator, type Page } from "@playwright/test";

// Locators for the app shell (W7a): the sidebar, the Assets tree, the profile block in the top bar. A crumb link, a tree link and a
// sidebar link can share one name ("Assets", "Sources", an asset's name ...), so a page-wide getByRole("link", { name }) is ambiguous
// on many pages: the specs go through these.

/** The sidebar (`nav[aria-label="Main"]`); the breadcrumb trail is a second navigation landmark, `Breadcrumb`. */
export const mainNav = (page: Page) => page.getByRole("navigation", { name: "Main" });

/** A sidebar link, matched by its whole name. */
export const navLink = (page: Page, name: string) => mainNav(page).getByRole("link", { name, exact: true });

/** The Assets tree's node link for an asset name. On `/assets/:id` the same name can also be a crumb link, so never look an asset up page-wide. */
export const treeLink = (page: Page, name: string) =>
  page.getByRole("region", { name: "Asset tree" }).getByRole("link", { name, exact: true });

/** The profile trigger in the top bar (user name and role). Not `header .who`: PageHeader renders a header too. */
export const userBlock = (page: Page) => page.locator(".navbar .who");

/** Opens the profile panel, chooses Sign out, confirms in the dialog and waits for the sign-in page. */
export async function signOut(page: Page): Promise<void> {
  await userBlock(page).click();
  // The panel is in the top bar; the confirm dialog is rendered into the body, so the first click is scoped to the bar.
  await page.locator(".navbar").getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("dialog", { name: /^Sign out/ }).getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
}

/** Clicks the row's `Actions for <name>` button and returns the open menu (named after that button; a click opens it and pins it, whether a hover got there first or not). */
async function openRowMenu(page: Page, row: Locator): Promise<Locator> {
  const trigger = row.getByRole("button", { name: /^Actions for / });
  const label = await trigger.getAttribute("aria-label");
  expect(label, "the row has an Actions button").toBeTruthy();
  await trigger.click();
  const menu = page.getByRole("menu", { name: label!, exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * Opens the three-dot menu of a table row and returns the menu item to click: `await (await rowAction(page, row, "Edit")).click()`.
 * The menu is a portal on the page and its items exist only while it is open, so the item is looked up inside THIS row's menu. The menu
 * must be closed on entry (a second click on the trigger closes it again).
 */
export async function rowAction(page: Page, row: Locator, item: string | RegExp): Promise<Locator> {
  return (await openRowMenu(page, row)).getByRole("menuitem", { name: item, exact: typeof item === "string" });
}

/**
 * Opens the row's menu, checks that `item` is not in it and that other items are, and closes it again (Escape puts the focus back on the
 * trigger). With the menu closed no item is in the page at all, so a bare `toHaveCount(0)` on a menuitem would prove nothing.
 */
export async function expectNoRowAction(page: Page, row: Locator, item: string | RegExp): Promise<void> {
  const menu = await openRowMenu(page, row);
  await expect(menu.getByRole("menuitem")).not.toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: item, exact: typeof item === "string" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
}

/**
 * Marks the dashboard's first-run guide (w27) as already seen, for every account: `localStorage.getItem` answers "1" for any key starting
 * `dcdash.guide.dashboard.v1:` (lib/guideMemory.ts), whatever the user id in it. Call it from `test.beforeEach(({ page }) => markGuideSeen(page))` in
 * every spec that opens a dashboard, so the panel does not push the cards down or take a Tab stop; only w27.spec.ts looks at the guide itself. A page
 * made with `browser.newPage()` or `newContext()` is not the `page` fixture: call it on that page too, before its first `goto`.
 */
export async function markGuideSeen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const read = Storage.prototype.getItem;
    Storage.prototype.getItem = function getItem(this: Storage, key: string): string | null {
      return typeof key === "string" && key.startsWith("dcdash.guide.dashboard.v1:") ? "1" : read.call(this, key);
    };
  });
}
