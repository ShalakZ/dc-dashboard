import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { mainNav, navLink, treeLink } from "./shell";

// W7g (a chosen icon per asset, picked in the Add/Edit asset dialog; the Assets page is called "Assets Tree") on the state the earlier
// projects leave behind: admin `admin` / `correct-horse`. The spec makes ONE asset of its own (top level, a run suffix in its name) through
// the dialog, and deletes everything whose name starts with the run's prefix in afterAll, so it depends on no other asset. The admin
// signs in through the API: the sign-in page is not what is tested here.
//
// Locators: the dialog's field is `getByRole("group", { name: "Icon" })`, its picker `getByRole("radiogroup", { name: "Icon choices" })`
// and the cells are native radios named by their label. A cell is looked up INSIDE the radiogroup with `exact: true`: "Rack" is also the
// start of "Row of racks", and asset names such as Panel 01 or Site exist in the tree. Two icons are told apart by the `innerHTML` of
// their <svg> as a whole, never by the first path (several icons start with the same <rect>). The Server icon is read from its own cell in
// the dialog, so the tree row, the page header and quick find are compared with what the picker itself draws, and the kind's own icon (UPS,
// as the Automatic cell draws it) is the other reference.

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse" };

const RUN = Date.now().toString(36);
const PREFIX = `W7g ${RUN}`;
const NAME = `${PREFIX} icon`;
const UNSAVED = `${PREFIX} not saved`;
const KIND = "UPS"; // typed under "Other…": a kind with an icon of its own, so Automatic is not the generic cube

interface ApiAsset { id: number; name: string; kind: string; icon: string | null }

async function signIn(page: Page): Promise<void> {
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in: ${login.status()}`).toBe(true);
}

/** Runs `use` with the request context of a fresh browser context in which the admin is signed in. */
async function asAdmin<T>(browser: Browser, use: (request: APIRequestContext) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    const login = await context.request.post("/api/login", { data: ADMIN });
    expect(login.ok(), "the admin signs in").toBe(true);
    return await use(context.request);
  } finally {
    await context.close();
  }
}

async function assetsOf(request: APIRequestContext): Promise<ApiAsset[]> {
  const response = await request.get("/api/assets");
  expect(response.ok(), "GET /api/assets").toBe(true);
  return (await response.json()) as ApiAsset[];
}

const tree = (page: Page) => page.getByRole("region", { name: "Asset tree" });
const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const crumbs = (page: Page) => page.getByRole("navigation", { name: "Breadcrumb" });

/** Two animation frames: whatever the page does about a key or a click has happened by then. */
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** The <svg> of a tree row, found by the row's own link (the same name can also be a crumb on the asset page). */
const treeIcon = (page: Page) => tree(page).locator(".node").filter({ has: page.getByRole("link", { name: NAME, exact: true }) }).locator(".node-icon svg");
/** The tile in the asset page's header (the dialog's preview tile is not in the header). */
const headerIcon = (page: Page) => page.locator(".page-head .page-tile svg");

/** The Add asset / Edit asset dialog and the parts of its Icon field. */
function iconDialog(page: Page, title: "Add asset" | "Edit asset") {
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  const field = dialog.getByRole("group", { name: "Icon", exact: true });
  const grid = field.getByRole("radiogroup", { name: "Icon choices", exact: true });
  return {
    dialog,
    field,
    grid,
    change: field.getByRole("button", { name: "Change icon", exact: true }),
    caption: field.locator(".icon-caption"),
    preview: field.locator(".icon-preview svg"),
    radio: (name: string) => grid.getByRole("radio", { name, exact: true }),
    /** The cell to click: the label around the radio carries the catalogue name as its title. */
    cell: (name: string) => (name === "Automatic" ? grid.getByTitle(/^Automatic: follows the kind/) : grid.getByTitle(name, { exact: true })), // Automatic's title says what it does
    name: dialog.getByLabel("Name", { exact: true }),
    kind: dialog.getByLabel(/^Kind/), // a label that wraps a <select> has the option texts in its text
    newKind: dialog.getByLabel("New kind", { exact: true }),
    save: dialog.getByRole("button", { name: "Save", exact: true }),
  };
}

async function openAddDialog(page: Page) {
  await page.goto("/assets");
  await page.getByRole("button", { name: "Add asset", exact: true }).click();
  const parts = iconDialog(page, "Add asset");
  await expect(parts.dialog).toBeVisible();
  return parts;
}

test.describe.serial("W7g: asset icons and the Assets Tree name", () => {
  let created = 0; // the asset the second test makes
  let autoHtml = ""; // the kind's own icon (UPS), as the Automatic cell draws it
  let serverHtml = ""; // the Server icon, as its cell draws it

  test.afterAll(async ({ browser }) => {
    await asAdmin(browser, async (request) => {
      for (const asset of (await assetsOf(request)).filter((a) => a.name.startsWith(PREFIX))) {
        const removed = await request.delete(`/api/assets/${asset.id}?confirm=true`);
        expect(removed.ok(), `deleting ${asset.name}: ${removed.status()}`).toBe(true);
      }
    });
  });

  test("the sidebar entry, the tree heading and the summary title read Assets Tree", async ({ page }) => {
    await signIn(page);
    await page.goto("/assets");
    await expect(navLink(page, "Assets Tree")).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: "Assets", exact: true }), "the old name is gone from the sidebar").toHaveCount(0);
    await expect(heading1(page, "Assets Tree")).toBeVisible();
    await expect(tree(page).getByText("Assets Tree", { exact: true }), "the tree column's own title").toBeVisible();
  });

  test("Add asset: the Icon field follows the Kind, the arrow keys change the choice, Server is chosen and saved", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const form = await openAddDialog(page);

    await test.step("the field is there, the grid is closed, Automatic reads as the default kind's icon", async () => {
      await expect(form.field).toBeVisible();
      await expect(form.change).toHaveAttribute("aria-expanded", "false");
      await expect(form.grid, "a closed grid is not in the accessibility tree").toBeHidden();
      await expect(form.caption).toHaveText("Automatic (Generic)");
    });

    await test.step("the caption and the preview follow the Kind while it is Automatic, also a new kind being typed", async () => {
      await form.name.fill(NAME);
      await form.kind.selectOption({ label: "Other…" });
      await expect(form.caption, "Other… with nothing typed yet").toHaveText("Automatic (Generic)");
      await form.newKind.fill(KIND);
      await expect(form.caption).toContainText(`Automatic (${KIND})`);
    });

    await test.step("Change icon opens the grid with the focus on the checked cell, and does not save", async () => {
      await form.change.click();
      await expect(form.change).toHaveAttribute("aria-expanded", "true");
      await expect(form.grid).toBeVisible();
      await expect(form.grid.getByRole("radio"), "Automatic and the 48 icons").toHaveCount(49);
      await expect(form.radio("Automatic")).toBeChecked();
      await expect(form.radio("Automatic")).toBeFocused();
      await expect(form.dialog, "opening the grid must not submit the form").toBeVisible();
      autoHtml = await form.cell("Automatic").locator("svg").innerHTML();
      await expect(form.cell("Automatic"), "a dashed edge tells Automatic from the same icon in the list").toHaveCSS("border-top-style", "dashed");
      expect(await form.preview.innerHTML(), "the preview draws the same icon as the Automatic cell").toBe(autoHtml);
    });

    await test.step("the arrow keys move the choice, the caption and the preview", async () => {
      await page.keyboard.press("ArrowRight");
      await expect(form.radio("Site")).toBeChecked();
      await expect(form.radio("Site")).toBeFocused();
      await expect(form.caption).toHaveText(/^Site/);
      expect(await form.preview.innerHTML(), "the preview left the kind's icon").not.toBe(autoHtml);
      await page.keyboard.press("ArrowLeft");
      await expect(form.radio("Automatic")).toBeChecked();
      await expect(form.caption).toContainText(`Automatic (${KIND})`);
      expect(await form.preview.innerHTML(), "and came back to it").toBe(autoHtml);
    });

    await test.step("choose Server with a click, then save", async () => {
      await form.cell("Server").click();
      await expect(form.radio("Server")).toBeChecked();
      await expect(form.caption).toHaveText(/^Server/);
      serverHtml = await form.cell("Server").locator("svg").innerHTML();
      expect(serverHtml, "the Server icon is not the kind's icon").not.toBe(autoHtml);
      expect(await form.preview.innerHTML(), "the preview draws the Server cell's icon").toBe(serverHtml);

      await form.save.click();
      await expect(form.dialog).toBeHidden();
      await expect(treeLink(page, NAME)).toBeVisible();
    });

    await test.step("the server stored it: the choice and the kind are separate fields", async () => {
      const asset = (await assetsOf(page.request)).find((a) => a.name === NAME);
      expect(asset, `the asset ${NAME} was created`).toBeTruthy();
      expect(asset!.icon).toBe("server");
      expect(asset!.kind.toLowerCase()).toBe(KIND.toLowerCase());
      created = asset!.id;
    });
  });

  test("the Server icon is in the tree row, the asset page header and quick find, the first crumb reads Assets Tree, and a reload keeps the icon", async ({ page }) => {
    test.setTimeout(90_000);
    expect(created, "the asset from the previous test").toBeGreaterThan(0);
    await signIn(page);
    await page.goto(`/assets/${created}`);
    await expect(heading1(page, NAME)).toBeVisible();

    await test.step("the first crumb and the sidebar", async () => {
      await expect(crumbs(page).locator("li").first()).toHaveText("Assets Tree");
      await expect(crumbs(page).getByRole("link")).toHaveText(["Assets Tree"]); // the asset is top level, so its own name is the current page
      await expect(navLink(page, "Assets Tree")).toBeVisible();
    });

    await test.step("tree row and header tile", async () => {
      await expect.poll(() => treeIcon(page).innerHTML(), { message: "the tree row" }).toBe(serverHtml);
      await expect.poll(() => headerIcon(page).innerHTML(), { message: "the header tile" }).toBe(serverHtml);
    });

    await test.step("quick find", async () => {
      const find = page.getByRole("combobox", { name: "Quick find" });
      await find.fill(NAME);
      const option = page.getByRole("listbox", { name: "Suggestions" }).getByRole("option").filter({ hasText: NAME });
      await expect(option).toHaveCount(1);
      expect(await option.locator("svg").innerHTML(), "the hit").toBe(serverHtml);
    });

    await test.step("a reload keeps the choice", async () => {
      await page.reload();
      await expect(heading1(page, NAME)).toBeVisible();
      await expect.poll(() => headerIcon(page).innerHTML(), { message: "the header tile after a reload" }).toBe(serverHtml);
      await expect.poll(() => treeIcon(page).innerHTML(), { message: "the tree row after a reload" }).toBe(serverHtml);
    });
  });

  test("Edit: back to Automatic, and the icon follows the kind again", async ({ page }) => {
    test.setTimeout(90_000);
    expect(created, "the asset from the earlier tests").toBeGreaterThan(0);
    await signIn(page);
    await page.goto(`/assets/${created}`);
    await expect(heading1(page, NAME)).toBeVisible();

    await page.locator(".page-head").getByRole("button", { name: "Edit", exact: true }).click();
    const form = iconDialog(page, "Edit asset");
    await expect(form.dialog).toBeVisible();
    await expect(form.caption, "the stored choice, by name").toHaveText("Server");
    expect(await form.preview.innerHTML()).toBe(serverHtml);

    await form.change.click();
    await expect(form.radio("Server"), "the focus lands on the stored choice").toBeChecked();
    await expect(form.radio("Server")).toBeFocused();
    await form.cell("Automatic").click();
    await expect(form.radio("Automatic")).toBeChecked();
    await expect(form.caption).toContainText(`Automatic (${KIND})`);
    await form.save.click();
    await expect(form.dialog).toBeHidden();

    await expect.poll(() => headerIcon(page).innerHTML(), { message: "the header tile follows the kind again" }).toBe(autoHtml);
    await expect.poll(() => treeIcon(page).innerHTML(), { message: "the tree row follows the kind again" }).toBe(autoHtml);
    const asset = (await assetsOf(page.request)).find((a) => a.id === created);
    expect(asset!.icon, "Automatic is stored as no choice").toBeNull();
  });

  test("Esc inside the open grid closes the grid, a second Esc the dialog, with nothing saved; Enter on a cell and Change icon do not save either", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/assets") posts.push(request.url());
    });

    const form = await openAddDialog(page);
    await form.name.fill(UNSAVED); // a form with a name would be saved by Enter or by a button that submits

    await form.change.click();
    await expect(form.radio("Automatic")).toBeFocused();
    await settled(page);
    expect(posts, "Change icon is not a submit button").toHaveLength(0);
    await expect(form.dialog).toBeVisible();

    await page.keyboard.press("ArrowRight");
    await expect(form.radio("Site")).toBeChecked();
    await page.keyboard.press("Enter");
    await settled(page);
    expect(posts, "Enter on a cell does not save the form").toHaveLength(0);
    await expect(form.dialog).toBeVisible();
    await expect(form.radio("Site"), "the choice is still there").toBeChecked();
    await expect(form.radio("Site")).toBeFocused();

    // W7i (E1): the first Esc closes only the grid, so one stray key does not throw the typed name away; a second Esc closes the dialog.
    await page.keyboard.press("Escape");
    await expect(form.grid, "the first Esc closes the grid").toBeHidden();
    await expect(form.dialog, "and leaves the dialog open").toBeVisible();
    await expect(form.name, "with the typed name").toHaveValue(UNSAVED);
    await expect(form.change, "focus is back on Change icon").toBeFocused();
    await page.keyboard.press("Escape");
    await expect(form.dialog, "a second Esc closes the dialog").toBeHidden();
    await settled(page);
    expect(posts, "closing saves nothing").toHaveLength(0);
    expect((await assetsOf(page.request)).filter((a) => a.name === UNSAVED), "no asset was made").toHaveLength(0);

    await page.getByRole("button", { name: "Add asset", exact: true }).click();
    const again = iconDialog(page, "Add asset");
    await expect(again.dialog).toBeVisible();
    await expect(again.name, "a new, empty form").toHaveValue("");
    await expect(again.change, "no half-open grid survives").toHaveAttribute("aria-expanded", "false");
    await expect(again.grid).toBeHidden();
    await expect(again.caption).toHaveText("Automatic (Generic)");
  });

  test("with the dialog open and the grid open there is no horizontal scroll at 1440 and 1024 px", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const form = await openAddDialog(page);
    await form.change.click();
    await expect(form.grid).toBeVisible();

    for (const [width, height] of [[1440, 900], [1024, 640]] as const) {
      await test.step(`${width} x ${height}`, async () => {
        await page.setViewportSize({ width, height });
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
        await settled(page);
        const measured = await form.dialog.evaluate((dialog) => {
          const root = document.documentElement;
          const box = dialog.getBoundingClientRect();
          const grid = dialog.querySelector('[role="radiogroup"]')!.getBoundingClientRect();
          return { page: root.scrollWidth - root.clientWidth, dialog: dialog.scrollWidth - dialog.clientWidth, dialogRight: box.right, gridRight: grid.right, viewport: window.innerWidth };
        });
        expect(measured.page, `the page scrolls sideways by ${measured.page} px`).toBeLessThanOrEqual(0);
        expect(measured.dialog, `the dialog scrolls sideways by ${measured.dialog} px`).toBeLessThanOrEqual(0);
        expect(measured.gridRight, "the grid ends inside the dialog").toBeLessThanOrEqual(measured.dialogRight);
        expect(measured.dialogRight, "the dialog ends inside the window").toBeLessThanOrEqual(measured.viewport);
        const save = await form.dialog.getByRole("button", { name: "Save", exact: true }).boundingBox();
        expect(save!.y + save!.height, `Save sits at ${save!.y + save!.height} px in a ${height} px window with the grid open`).toBeLessThanOrEqual(height);
      });
    }
  });
});
