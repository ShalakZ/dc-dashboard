import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { rowAction, treeLink } from "./shell";

// W7m (asset kinds as data: the Asset kinds page, a default icon per kind, and the Add/Edit asset dialog following the registry) on the
// state the earlier projects leave behind: admin `admin` / `correct-horse`. Every name the spec makes starts with `W7m ` and carries the run
// suffix, and afterAll removes what this run made through the API (the assets first: a kind that assets use cannot be deleted), then the
// viewer account. The admin signs in through the API: the sign-in page is not what is tested here.
//
// The run suffix is digits only on purpose. A kind's default icon is a guess from its words (lib/kindIcon.ts), and a base-36 suffix such as
// `k3ups2` would split into letter runs that can be a keyword; a number cannot, so "W7m Pump N" is always a pump and "W7m Fan N" a fan.
//
// The flow, in order (one serial describe, the tests hand the ids on):
//   1. A viewer opens /assets/kinds: the list, no New kind, no row menu; the API refuses its writes with 403.
//   2. The tree header's "Asset kinds" link opens the page: heading and crumb, the tree column beside it.
//   3. New kind "W7m Pump N" with the Pump icon: the dialog guesses it from the name, a pick is the person's; the row reads "No assets".
//   4. Add asset with that kind and Automatic: the tree row, the asset page's header and quick find draw the pump.
//   5. Edit the kind to Server: the tree row, the header and quick find change, on the same page load (a marker on `window` survives).
//   6. Rename the kind "W7m Pumps N": the asset page shows the new kind text, the row says "1 asset", the icon stays.
//   7. The asset's own icon (Rack) wins over the kind's.
//   8. The kind's Delete is refused while the asset uses it (dialog and API 409); /assets/kinds survives a reload.
//   9. Delete the asset, then the kind.
//  10. Add asset with a NEW typed kind: it is registered with the suggested icon, and the next asset of that kind needs no choice.
//  11. No horizontal scroll at 1440 and 1024 px, on the page and with the New kind dialog (and its grid) open.
//
// Locators. Icons are told apart by the `innerHTML` of the whole <svg>, never by the first path, and each reference is read from its own
// cell in a picker's grid (a cell is looked up inside the radiogroup by its title, `exact: true`: "Rack" is also the start of "Row of
// racks"). A kind's row is found by its label (`.kind-label`) matched as a whole, since "W7m Pump N" must not find "W7m Pumps N". The
// dialogs are looked up by their exact names; the Add asset dialog also has a field called "New kind", so every lookup of that name is
// inside a dialog. Toasts are `.toast-stack .toast`. The Add/Edit asset dialog's Kind select, its "Automatic (X)" caption and the note
// about a new kind are Task 4's: they are matched by label, a start-anchored caption and one fragment of the note.

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const ADMIN = { username: "admin", password: "correct-horse" };
const VIEWER = { username: "w7m-viewer", password: "w7m-viewer-pass", role: "viewer" };

const RUN = Date.now().toString();
const KIND_PUMP = `W7m Pump ${RUN}`;
const KIND_PUMPS = `W7m Pumps ${RUN}`;
const KIND_FAN = `W7m Fan ${RUN}`;
const KIND_SEEN = `W7m Seen ${RUN}`; // made through the API for the viewer to read
const ASSET = `W7m asset ${RUN}`;
const ASSET_TYPED = `W7m typed ${RUN}`;

interface ApiAsset { id: number; name: string; kind: string; icon: string | null; kind_icon: string | null }
interface ApiKind { id: number; name: string; icon: string; asset_count: number }

/** The names this run made (the prefix alone would also catch an earlier run's leftovers, which are not ours to remove). */
const mine = (name: string) => name.startsWith("W7m ") && name.includes(` ${RUN}`);

async function signInAs(page: Page, who: { username: string; password: string }): Promise<void> {
  const login = await page.request.post("/api/login", { data: { username: who.username, password: who.password } });
  expect(login.ok(), `signing in as ${who.username}: ${login.status()}`).toBe(true);
}
const signIn = (page: Page) => signInAs(page, ADMIN);

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
  expect(response.ok(), `GET /api/assets: ${response.status()}`).toBe(true);
  return (await response.json()) as ApiAsset[];
}

async function kindsOf(request: APIRequestContext): Promise<ApiKind[]> {
  const response = await request.get("/api/asset-kinds");
  expect(response.ok(), `GET /api/asset-kinds: ${response.status()}`).toBe(true);
  return (await response.json()) as ApiKind[];
}

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const crumbs = (page: Page) => page.getByRole("navigation", { name: "Breadcrumb" });
const tree = (page: Page) => page.getByRole("region", { name: "Asset tree" });
/** The tree header's link to the page (the crumb "Asset kinds" is plain text, so this is the one link of that name in the tree). */
const kindsLink = (page: Page) => treeLink(page, "Asset kinds");
const toast = (page: Page, text: string) => page.locator(".toast-stack .toast").filter({ hasText: text });

/** Two animation frames: whatever the page does about a viewport change has happened by then. */
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

const exactly = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
/** A kind's row on the Asset kinds page, by its label as a whole. */
const kindRow = (page: Page, name: string) => page.getByRole("row").filter({ has: page.locator(".kind-label", { hasText: exactly(name) }) });
const kindTile = (page: Page, name: string) => kindRow(page, name).locator(".kind-tile svg");
const kindCount = (page: Page, name: string) => kindRow(page, name).getByRole("cell").nth(1);

/** The <svg> of the asset's tree row, found by the row's own link (the same name can also be a crumb on the asset page). */
const treeIcon = (page: Page, name: string) => tree(page).locator(".node").filter({ has: page.getByRole("link", { name, exact: true }) }).locator(".node-icon svg");
/** The tile in the asset page's header (a dialog's preview tile is not in the header). */
const headerIcon = (page: Page) => page.locator(".page-head .page-tile svg");

/** The icon quick find draws for `name`; "" while the list does not (yet) hold exactly one such hit. */
async function quickFindIcon(page: Page, name: string): Promise<string> {
  const find = page.getByRole("combobox", { name: "Quick find" });
  await find.fill(name);
  const hits = page.getByRole("listbox", { name: "Suggestions" }).getByRole("option").filter({ hasText: name });
  return (await hits.count()) === 1 ? await hits.locator("svg").innerHTML() : "";
}

/** On the asset's page: the tree row, the header tile and quick find all draw `html`. They are polled, since a query refetches after a write. */
async function expectAssetIcon(page: Page, name: string, html: string, when: string): Promise<void> {
  await expect.poll(() => treeIcon(page, name).innerHTML(), { message: `${when}: the tree row` }).toBe(html);
  await expect.poll(() => headerIcon(page).innerHTML(), { message: `${when}: the header tile` }).toBe(html);
  await expect.poll(() => quickFindIcon(page, name), { message: `${when}: quick find` }).toBe(html);
  await page.getByRole("combobox", { name: "Quick find" }).fill(""); // an empty query closes the popup, which would cover the page's top
}

/** The New kind / Edit kind dialog and the parts of its Icon field. */
function kindDialog(page: Page, title: "New kind" | "Edit kind") {
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  const field = dialog.getByRole("group", { name: "Icon", exact: true });
  const grid = field.getByRole("radiogroup", { name: "Icon choices", exact: true });
  return {
    dialog,
    grid,
    name: dialog.getByLabel("Name", { exact: true }),
    change: field.getByRole("button", { name: "Change icon", exact: true }),
    caption: field.locator(".icon-caption"),
    hint: field.locator(".icon-hint"),
    radio: (label: string) => grid.getByRole("radio", { name: label, exact: true }),
    /** The cell to click, and to read the reference drawing from. */
    cell: (label: string) => grid.getByTitle(label, { exact: true }),
    save: dialog.getByRole("button", { name: "Save", exact: true }),
  };
}

/** The Add asset / Edit asset dialog (W7g's lookups, plus the registry-aware parts). */
function assetDialog(page: Page, title: "Add asset" | "Edit asset") {
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  const field = dialog.getByRole("group", { name: "Icon", exact: true });
  const grid = field.getByRole("radiogroup", { name: "Icon choices", exact: true });
  return {
    dialog,
    grid,
    change: field.getByRole("button", { name: "Change icon", exact: true }),
    caption: field.locator(".icon-caption"),
    cell: (label: string) => grid.getByTitle(label, { exact: true }),
    name: dialog.getByLabel("Name", { exact: true }),
    kind: dialog.getByLabel(/^Kind/), // a label that wraps a <select> has the option texts in its text
    newKind: dialog.getByLabel("New kind", { exact: true }),
    /** Task 4's one-line note for a typed kind that is not in the registry. */
    note: dialog.getByText(/added to Asset kinds/),
    save: dialog.getByRole("button", { name: "Save", exact: true }),
    cancel: dialog.getByRole("button", { name: "Cancel", exact: true }),
  };
}

async function openAddAsset(page: Page) {
  await page.goto("/assets");
  await page.getByRole("button", { name: "Add asset", exact: true }).click();
  const form = assetDialog(page, "Add asset");
  await expect(form.dialog).toBeVisible();
  return form;
}

test.describe.serial("W7m: asset kinds", () => {
  let viewerId = 0;
  let assetId = 0; // the asset the Add asset test makes
  let kindId = 0; // the kind "W7m Pump N" (renamed later)
  const icons = { pump: "", server: "", rack: "", fan: "" }; // the drawings, as the picker's own cells draw them

  test.beforeAll(async ({ browser }) => {
    await asAdmin(browser, async (request) => {
      // No account left over from an earlier run that stopped half way.
      const users = (await (await request.get("/api/users")).json()) as { id: number; username: string }[];
      for (const old of users.filter((u) => u.username === VIEWER.username)) await request.delete(`/api/users/${old.id}`);
      const made = await request.post("/api/users", { data: { username: VIEWER.username, password: VIEWER.password, role: VIEWER.role } });
      expect(made.ok(), `creating ${VIEWER.username}: ${made.status()} ${await made.text()}`).toBe(true);
      viewerId = ((await made.json()) as { id: number }).id;

      const seen = await request.post("/api/asset-kinds", { data: { name: KIND_SEEN, icon: "meter" } });
      expect(seen.status(), `creating the kind ${KIND_SEEN}: ${await seen.text()}`).toBe(201);
    });
  });

  test.afterAll(async ({ browser }) => {
    await asAdmin(browser, async (request) => {
      for (const asset of (await assetsOf(request)).filter((a) => mine(a.name))) {
        const removed = await request.delete(`/api/assets/${asset.id}?confirm=true`);
        expect([200, 204, 404], `deleting ${asset.name}: ${removed.status()}`).toContain(removed.status());
      }
      for (const kind of (await kindsOf(request)).filter((k) => mine(k.name))) {
        const removed = await request.delete(`/api/asset-kinds/${kind.id}`);
        expect([204, 404], `deleting the kind ${kind.name}: ${removed.status()} ${await removed.text()}`).toContain(removed.status());
      }
      if (viewerId) await request.delete(`/api/users/${viewerId}`);
    });
  });

  test("a viewer reads the list and cannot change it; the API refuses the writes", async ({ page }) => {
    test.setTimeout(90_000);
    await signInAs(page, VIEWER);
    await page.goto("/assets/kinds");
    await expect(heading1(page, "Asset kinds")).toBeVisible();
    await expect(tree(page), "the tree column stays beside the page").toBeVisible();
    await expect(kindRow(page, KIND_SEEN), "the list").toBeVisible();
    await expect(kindCount(page, KIND_SEEN)).toHaveText("No assets");
    await expect(page.getByRole("button", { name: "New kind", exact: true }), "a reader has no New kind").toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Actions for / }), "and no row menu").toHaveCount(0);

    const seen = (await kindsOf(page.request)).find((k) => k.name === KIND_SEEN);
    expect(seen, "the viewer reads the registry").toBeTruthy();
    for (const [what, response] of [
      ["POST", await page.request.post("/api/asset-kinds", { data: { name: `W7m refused ${RUN}` } })],
      ["PATCH", await page.request.patch(`/api/asset-kinds/${seen!.id}`, { data: { icon: "rack" } })],
      ["DELETE", await page.request.delete(`/api/asset-kinds/${seen!.id}`)],
    ] as const) {
      expect(response.status(), `${what} /api/asset-kinds as a viewer`).toBe(403);
    }
    expect((await kindsOf(page.request)).filter((k) => k.name.startsWith("W7m refused")), "nothing was made").toHaveLength(0);
    expect((await kindsOf(page.request)).find((k) => k.id === seen!.id)?.icon, "and nothing changed").toBe("meter");
  });

  test("the tree header's link opens the Asset kinds page, with the tree beside it", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.goto("/assets");
    await expect(heading1(page, "Assets Tree")).toBeVisible();
    await kindsLink(page).click();
    await expect(page).toHaveURL(/\/assets\/kinds$/);
    await expect(heading1(page, "Asset kinds")).toBeVisible();
    await expect(crumbs(page).getByRole("link"), "the trail: a link to the tree ...").toHaveText(["Assets Tree"]);
    await expect(crumbs(page).locator('[aria-current="page"]'), "... then this page, as text").toHaveText("Asset kinds");
    await expect(tree(page), "the tree column stays").toBeVisible();
    await expect(kindsLink(page), "the link marks the page it is on").toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "New kind", exact: true })).toBeVisible();
    await expect(kindRow(page, KIND_SEEN)).toBeVisible();
  });

  test("New kind: the dialog guesses the icon from the name, a pick is the person's, and the new row reads No assets", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    await page.goto("/assets/kinds");
    await expect(heading1(page, "Asset kinds")).toBeVisible();
    await page.getByRole("button", { name: "New kind", exact: true }).click();
    const form = kindDialog(page, "New kind");
    await expect(form.dialog).toBeVisible();

    await test.step("the icon follows the name while nobody has picked one", async () => {
      await expect(form.caption, "nothing typed yet").toContainText("Generic");
      await form.name.fill(KIND_PUMP);
      await expect(form.caption).toContainText("Pump");
      await expect(form.hint).toHaveText("Suggested from the name");
    });

    await test.step("the grid has the 28 icons and no Automatic cell; the references are read from it", async () => {
      await form.change.click();
      await expect(form.grid).toBeVisible();
      await expect(form.grid.getByRole("radio"), "a kind always has an icon: no Automatic").toHaveCount(28);
      await expect(form.radio("Pump"), "the guess is checked").toBeChecked();
      await expect(form.radio("Pump")).toBeFocused();
      icons.pump = await form.cell("Pump").locator("svg").innerHTML();
      icons.server = await form.cell("Server").locator("svg").innerHTML();
      icons.rack = await form.cell("Rack").locator("svg").innerHTML();
      icons.fan = await form.cell("Fan").locator("svg").innerHTML();
      expect(new Set(Object.values(icons)).size, "four different drawings").toBe(4);
    });

    await test.step("choosing the Pump icon is a choice: the guess stops following the name", async () => {
      await form.cell("Pump").click();
      await expect(form.radio("Pump")).toBeChecked();
      await expect(form.hint, "the icon is the person's now").toHaveCount(0);
      await expect(form.dialog, "choosing does not save").toBeVisible();
      await form.save.click();
      await expect(form.dialog).toBeHidden();
      await expect(toast(page, "Kind created")).toBeVisible();
    });

    await test.step("the row: the name, the pump and No assets", async () => {
      await expect(kindRow(page, KIND_PUMP)).toBeVisible();
      await expect(kindCount(page, KIND_PUMP)).toHaveText("No assets");
      expect(await kindTile(page, KIND_PUMP).innerHTML(), "the row draws the pump").toBe(icons.pump);
      const stored = (await kindsOf(page.request)).find((k) => k.name === KIND_PUMP);
      expect(stored, "the server has the kind").toBeTruthy();
      expect(stored!.icon).toBe("pump");
      expect(stored!.asset_count).toBe(0);
      kindId = stored!.id;
    });
  });

  test("Add asset with that kind and Automatic: the tree row, the header and quick find draw the kind's pump", async ({ page }) => {
    test.setTimeout(120_000);
    expect(kindId, "the kind from the previous test").toBeGreaterThan(0);
    await signIn(page);
    const form = await openAddAsset(page);
    await form.name.fill(ASSET);
    await form.kind.selectOption({ label: KIND_PUMP }); // Task 4: the Kind select lists the registry
    await expect(form.caption, "Automatic names what the kind gives").toHaveText(/^Automatic \(Pump\)/);
    await expect(form.note, "a registered kind is no new kind").toHaveCount(0);
    await form.save.click();
    await expect(form.dialog).toBeHidden();
    await expect(treeLink(page, ASSET)).toBeVisible();

    const asset = (await assetsOf(page.request)).find((a) => a.name === ASSET);
    expect(asset, `the asset ${ASSET} was created`).toBeTruthy();
    expect(asset!.kind, "the kind as the registry spells it").toBe(KIND_PUMP);
    expect(asset!.icon, "Automatic is no choice of its own").toBeNull();
    expect(asset!.kind_icon, "the server resolved the kind's icon").toBe("pump");
    assetId = asset!.id;

    await page.goto(`/assets/${assetId}`);
    await expect(heading1(page, ASSET)).toBeVisible();
    await expectAssetIcon(page, ASSET, icons.pump, "a new asset of a registered kind");
  });

  test("Edit the kind to the Server icon: the tree row, the header and quick find change without a reload", async ({ page }) => {
    test.setTimeout(120_000);
    expect(assetId, "the asset from the previous test").toBeGreaterThan(0);
    await signIn(page);
    await page.goto(`/assets/${assetId}`);
    await expect(heading1(page, ASSET)).toBeVisible();
    await expectAssetIcon(page, ASSET, icons.pump, "before");
    await page.evaluate(() => { (window as unknown as { __w7m?: string }).__w7m = "the same page load"; }); // a reload would lose it

    await kindsLink(page).click();
    await expect(heading1(page, "Asset kinds")).toBeVisible();
    await expect(kindCount(page, KIND_PUMP), "the asset counts").toHaveText("1 asset");
    await (await rowAction(page, kindRow(page, KIND_PUMP), "Edit")).click();
    const form = kindDialog(page, "Edit kind");
    await expect(form.dialog).toBeVisible();
    await expect(form.name, "prefilled").toHaveValue(KIND_PUMP);
    await expect(form.caption).toHaveText("Pump");
    await form.change.click();
    await expect(form.radio("Pump"), "the focus lands on the stored icon").toBeFocused();
    await form.cell("Server").click();
    await expect(form.radio("Server")).toBeChecked();
    await expect(form.caption).toHaveText("Server");
    await form.save.click();
    await expect(form.dialog).toBeHidden();
    await expect(toast(page, "Kind saved")).toBeVisible();

    await test.step("the page and the tree beside it follow at once", async () => {
      await expect.poll(() => kindTile(page, KIND_PUMP).innerHTML(), { message: "the row" }).toBe(icons.server);
      await expect.poll(() => treeIcon(page, ASSET).innerHTML(), { message: "the tree row" }).toBe(icons.server);
    });

    await test.step("the asset's page follows too, with the same page load", async () => {
      await treeLink(page, ASSET).click();
      await expect(heading1(page, ASSET)).toBeVisible();
      await expectAssetIcon(page, ASSET, icons.server, "after the kind's icon changed");
      expect(await page.evaluate(() => (window as unknown as { __w7m?: string }).__w7m), "no reload happened").toBe("the same page load");
    });

    const asset = (await assetsOf(page.request)).find((a) => a.id === assetId);
    expect(asset!.icon, "the asset itself was not touched").toBeNull();
    expect(asset!.kind_icon).toBe("server");
  });

  test("Rename the kind: the asset page shows the new kind text, the row says 1 asset, the icon stays", async ({ page }) => {
    test.setTimeout(120_000);
    expect(assetId, "the asset from the earlier tests").toBeGreaterThan(0);
    await signIn(page);
    await page.goto("/assets/kinds");
    await expect(heading1(page, "Asset kinds")).toBeVisible();
    await (await rowAction(page, kindRow(page, KIND_PUMP), "Edit")).click();
    const form = kindDialog(page, "Edit kind");
    await expect(form.dialog).toBeVisible();
    await expect(form.caption, "the stored icon").toHaveText("Server");
    await form.name.fill(KIND_PUMPS);
    await form.save.click();
    await expect(form.dialog).toBeHidden();
    await expect(toast(page, "Kind renamed, 1 asset follows")).toBeVisible();

    await expect(kindRow(page, KIND_PUMPS)).toBeVisible();
    await expect(kindCount(page, KIND_PUMPS)).toHaveText("1 asset");
    await expect(kindRow(page, KIND_PUMP), "the old name is gone").toHaveCount(0);
    expect(await kindTile(page, KIND_PUMPS).innerHTML(), "the icon stays").toBe(icons.server);

    await treeLink(page, ASSET).click();
    await expect(heading1(page, ASSET)).toBeVisible();
    await expect(page.locator(".page-head .sub"), "the asset page shows the new kind text").toContainText(KIND_PUMPS);
    await expectAssetIcon(page, ASSET, icons.server, "after the rename");

    const asset = (await assetsOf(page.request)).find((a) => a.id === assetId);
    expect(asset!.kind, "the asset's kind text was rewritten").toBe(KIND_PUMPS);
    expect(asset!.kind_icon).toBe("server");
    const kind = (await kindsOf(page.request)).find((k) => k.id === kindId);
    expect(kind!.name).toBe(KIND_PUMPS);
    expect(kind!.asset_count).toBe(1);
  });

  test("the asset's own icon wins over the kind's", async ({ page }) => {
    test.setTimeout(120_000);
    expect(assetId, "the asset from the earlier tests").toBeGreaterThan(0);
    await signIn(page);
    await page.goto(`/assets/${assetId}`);
    await expect(heading1(page, ASSET)).toBeVisible();
    await page.locator(".page-head").getByRole("button", { name: "Edit", exact: true }).click();
    const form = assetDialog(page, "Edit asset");
    await expect(form.dialog).toBeVisible();
    await expect(form.kind, "the asset's own kind, as stored").toHaveValue(KIND_PUMPS);
    await expect(form.caption, "Automatic is what the kind gives, not what its words suggest").toHaveText(/^Automatic \(Server\)/);

    await form.change.click();
    await expect(form.grid).toBeVisible();
    await form.cell("Rack").click();
    await form.save.click();
    await expect(form.dialog).toBeHidden();

    await expectAssetIcon(page, ASSET, icons.rack, "an own icon");
    const asset = (await assetsOf(page.request)).find((a) => a.id === assetId);
    expect(asset!.icon).toBe("rack");
    expect(asset!.kind_icon, "the kind's icon is unchanged").toBe("server");
    expect(asset!.kind, "and so is the kind").toBe(KIND_PUMPS);
  });

  test("a kind in use cannot be deleted (dialog and API), and the page survives a reload", async ({ page }) => {
    test.setTimeout(120_000);
    expect(kindId, "the kind from the earlier tests").toBeGreaterThan(0);
    await signIn(page);
    await page.goto("/assets/kinds"); // a deep link
    await expect(heading1(page, "Asset kinds")).toBeVisible();
    await page.reload();
    await expect(heading1(page, "Asset kinds")).toBeVisible();
    await expect(kindCount(page, KIND_PUMPS)).toHaveText("1 asset");
    expect(await kindTile(page, KIND_PUMPS).innerHTML(), "the kind keeps its own icon, whatever the asset shows").toBe(icons.server);

    await (await rowAction(page, kindRow(page, KIND_PUMPS), "Delete")).click();
    const confirm = page.getByRole("dialog", { name: `Delete the kind "${KIND_PUMPS}"?`, exact: true });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole("alert")).toContainText("1 asset uses");
    await expect(confirm.getByRole("button", { name: "Delete", exact: true }), "nothing to confirm: no Delete button at all").toHaveCount(0);
    await expect(confirm.getByRole("button", { name: "Cancel", exact: true }), "Cancel reads Close").toHaveCount(0);
    await confirm.getByRole("button", { name: "Close", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(kindRow(page, KIND_PUMPS)).toBeVisible();

    const refused = await page.request.delete(`/api/asset-kinds/${kindId}`);
    expect(refused.status(), "the API refuses too").toBe(409);
    const body = (await refused.json()) as { detail: string; assets: number };
    expect(body.detail).toContain("1 asset uses");
    expect(body.assets).toBe(1);
    expect((await kindsOf(page.request)).some((k) => k.id === kindId), "the kind is still there").toBe(true);
  });

  test("with the asset gone the kind can be deleted, and leaves the list", async ({ page }) => {
    test.setTimeout(120_000);
    expect(assetId, "the asset from the earlier tests").toBeGreaterThan(0);
    await signIn(page);
    const removed = await page.request.delete(`/api/assets/${assetId}?confirm=true`);
    expect(removed.ok(), `deleting the asset: ${removed.status()}`).toBe(true);

    await page.goto("/assets/kinds");
    await expect(heading1(page, "Asset kinds")).toBeVisible();
    await expect(kindCount(page, KIND_PUMPS)).toHaveText("No assets");
    await (await rowAction(page, kindRow(page, KIND_PUMPS), "Delete")).click();
    const confirm = page.getByRole("dialog", { name: `Delete the kind "${KIND_PUMPS}"?`, exact: true });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole("alert"), "nothing stands in the way").toHaveCount(0);
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(toast(page, `Kind "${KIND_PUMPS}" deleted`)).toBeVisible();
    await expect(kindRow(page, KIND_PUMPS), "gone from the list").toHaveCount(0);
    await expect(page.getByRole("button", { name: "New kind", exact: true }), "the focus did not fall to the page body").toBeFocused();
    expect((await kindsOf(page.request)).some((k) => k.id === kindId), "and from the server").toBe(false);
  });

  test("Add asset with a NEW typed kind: it is registered with the suggested icon, and the next asset of it needs no choice", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const form = await openAddAsset(page);
    await form.name.fill(ASSET_TYPED);
    await form.kind.selectOption({ label: "Other…" });
    await form.newKind.fill(KIND_FAN);
    await expect(form.caption, "the suggestion, as nothing is registered for it yet").toHaveText(/^Automatic \(Fan\)/);
    await expect(form.note, "the dialog says the kind will be added").toBeVisible();
    await form.save.click();
    await expect(form.dialog).toBeHidden();
    await expect(treeLink(page, ASSET_TYPED)).toBeVisible();

    await test.step("the registry has it, with the suggestion and the new asset counted", async () => {
      await expect.poll(async () => (await kindsOf(page.request)).find((k) => k.name === KIND_FAN)?.icon, { message: "the kind was registered" }).toBe("fan");
      expect((await kindsOf(page.request)).find((k) => k.name === KIND_FAN)!.asset_count).toBe(1);
      const asset = (await assetsOf(page.request)).find((a) => a.name === ASSET_TYPED);
      expect(asset!.kind).toBe(KIND_FAN);
      expect(asset!.icon, "no icon of its own").toBeNull();
      expect(asset!.kind_icon).toBe("fan");
    });

    await test.step("the Asset kinds page lists it", async () => {
      await kindsLink(page).click();
      await expect(heading1(page, "Asset kinds")).toBeVisible();
      await expect(kindRow(page, KIND_FAN)).toBeVisible();
      await expect(kindCount(page, KIND_FAN)).toHaveText("1 asset");
      expect(await kindTile(page, KIND_FAN).innerHTML(), "the suggested fan").toBe(icons.fan);
    });

    await test.step("the next asset of that kind needs no choice and no note", async () => {
      const next = await openAddAsset(page);
      await next.kind.selectOption({ label: KIND_FAN });
      await expect(next.caption).toHaveText(/^Automatic \(Fan\)/);
      await expect(next.note).toHaveCount(0);
      await next.cancel.click();
      await expect(next.dialog).toBeHidden();
    });
  });

  test("no horizontal scroll at 1440 and 1024 px, on the page and with the New kind dialog and its grid open", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    await page.goto("/assets/kinds");
    await expect(heading1(page, "Asset kinds")).toBeVisible();
    const sideways = (): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    for (const [width, height] of [[1440, 900], [1024, 640]] as const) {
      await test.step(`${width} x ${height}`, async () => {
        await page.setViewportSize({ width, height });
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
        await settled(page);
        expect(await sideways(), "the page scrolls sideways").toBeLessThanOrEqual(0);

        await page.getByRole("button", { name: "New kind", exact: true }).click();
        const form = kindDialog(page, "New kind");
        await expect(form.dialog).toBeVisible();
        await form.change.click();
        await expect(form.grid).toBeVisible();
        await settled(page);
        const measured = await form.dialog.evaluate((dialog) => {
          const box = dialog.getBoundingClientRect();
          const grid = dialog.querySelector('[role="radiogroup"]')!.getBoundingClientRect();
          return { dialog: dialog.scrollWidth - dialog.clientWidth, dialogRight: box.right, gridRight: grid.right, viewport: window.innerWidth };
        });
        expect(await sideways(), "the page scrolls sideways with the dialog open").toBeLessThanOrEqual(0);
        expect(measured.dialog, `the dialog scrolls sideways by ${measured.dialog} px`).toBeLessThanOrEqual(0);
        expect(measured.gridRight, "the grid ends inside the dialog").toBeLessThanOrEqual(measured.dialogRight);
        expect(measured.dialogRight, "the dialog ends inside the window").toBeLessThanOrEqual(measured.viewport);
        const save = await form.save.boundingBox();
        expect(save!.y + save!.height, `Save sits at ${save!.y + save!.height} px in a ${height} px window with the grid open`).toBeLessThanOrEqual(height);

        await page.keyboard.press("Escape"); // the first Escape closes the grid, the second the dialog
        await expect(form.grid).toBeHidden();
        await page.keyboard.press("Escape");
        await expect(form.dialog).toBeHidden();
      });
    }
  });
});
