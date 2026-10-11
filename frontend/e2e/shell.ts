import { expect, type Page } from "@playwright/test";

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
