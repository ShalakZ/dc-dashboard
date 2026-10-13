import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { roleLabel } from "./roles";
import { userBlock } from "./shell";

// W9c (the Roles editor offers to tick what a permission needs, and to untick what needs it) on the state the earlier projects leave
// behind: admin `admin` / `correct-horse`. Every role this spec makes has a name starting with `w9c-`; beforeAll and afterAll remove them
// (and what an earlier, interrupted run left behind) through the API. No account is made: only roles, and only two of them are saved.
//
// What it proves, as a person sees it: (1) ticking "Change users" opens a card that says it also needs "See users", the card sits whole
// inside the window beside its box, "Also tick See users" ticks both and hands the focus back, and Save posts exactly the two ids;
// (2) "Not now" ticks nothing more and the hint line stays; (3) the whole thing works from the keyboard and Escape closes only the card;
// (4) unticking a permission that another ticked one needs offers to untick that one too; (5) the `?` bubble of every permission in the
// Change column (the grid's right edge) is whole and the grid does not scroll sideways; (6) a quick click on the box the card covers goes
// to that box, and a press on the card's own text keeps it open; (7) the card is whole inside the window at 1024 and 1440 wide, for a
// box in the See column, the Change column and Sensitive actions.
//
// Locators: a card is `role="group"` named by its sentence, so it is always found by that sentence with `exact: true`. A bare
// getByRole("group") would also match `fieldset.role-sensitive` (the Sensitive actions box), so "any card" is the name /to show anything/,
// which every sentence of the card contains and the fieldset's legend does not. The same sentence is also the hint line of the summary
// when a single need is missing, so the hint is looked up inside the summary region only. Checkboxes are matched by the server's whole
// label, `exact: true`. The card ignores the pointer for its first 400 ms (CSS arming delay, R8 of the plan): a Playwright click on one of
// its buttons waits until the button is hittable; a click aimed at a box the card covers must not be made while a card is open (it would
// wait for the covered box forever), so a card is answered or dismissed (Escape) before the next box is touched. Step 6 is the one place
// that breaks this rule on purpose.
//
// Set W9C_SHOTS to a directory to also get a screenshot of every card of step 7 (light, and dark when the account follows the device).

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";
const SHOTS = process.env.W9C_SHOTS;
const PREFIX = "w9c-";
const ROLE_USERS = "w9c-users"; // saved by test 1
const ROLE_TARIFFS = "w9c-tariffs"; // saved by test 2

const ADMIN = { username: "admin", password: "correct-horse", role: "admin" };
type Account = typeof ADMIN;

interface ApiRole { id: number; name: string; builtin: boolean; permissions: string[] | null }

// ---------------------------------------------------------------------------------------------------------------------------------
// Requests

async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
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

/** Every custom role whose name starts with w9c- (no account holds one: this spec makes no account). */
async function removeMine(request: APIRequestContext): Promise<void> {
  const mine = (role: ApiRole) => !role.builtin && role.name.toLowerCase().startsWith(PREFIX);
  for (const role of (await json<ApiRole[]>(request, "/api/roles")).filter(mine)) {
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

/** Runs `use` with a page of a fresh browser context (1600 x 1000 unless told otherwise) in which the admin is signed in. */
async function asAdminPage(browser: Browser, use: (page: Page) => Promise<void>, viewport = { width: 1600, height: 1000 }): Promise<void> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport });
  try {
    const page = await context.newPage();
    await signIn(page, ADMIN);
    await use(page);
  } finally {
    await context.close();
  }
}

const heading1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const rolesTable = (page: Page) => page.getByRole("table", { name: "Roles", exact: true });
const newRoleButton = (page: Page) => page.getByRole("button", { name: "New role", exact: true });
const editor = (page: Page) => page.getByRole("dialog", { name: "New role", exact: true });
const summary = (dialog: Locator) => dialog.getByRole("region", { name: "What this role can do", exact: true });
const tick = (dialog: Locator, label: string) => dialog.getByRole("checkbox", { name: label, exact: true });
const labelOf = (box: Locator) => box.locator("xpath=ancestor::label[1]");
const save = (dialog: Locator) => dialog.getByRole("button", { name: "Save", exact: true });
/** The card with this sentence. */
const card = (dialog: Locator, sentence: string) => dialog.getByRole("group", { name: sentence, exact: true });
/** Every card that is open, whatever its sentence (see the header: not the bare group role). */
const cards = (dialog: Locator) => dialog.getByRole("group", { name: /to show anything/ });
const button = (group: Locator, name: string) => group.getByRole("button", { name, exact: true });
/** Puts a box in the middle of the window, so nothing scrolls under a later measurement and a card has room on both sides. */
const centred = (box: Locator) => box.evaluate((node) => node.scrollIntoView({ block: "center" }));

/** The Roles tab, opened by its address; the editor is opened with a click, or from the keyboard (focus on the button, then Enter). */
async function openNewRole(page: Page, how: "click" | "keyboard" = "click"): Promise<Locator> {
  await page.goto("/users/roles");
  await expect(heading1(page, "Users & Roles")).toBeVisible();
  await expect(rolesTable(page)).toBeVisible();
  await expect(newRoleButton(page)).toBeEnabled();
  if (how === "click") {
    await newRoleButton(page).click();
  } else {
    await newRoleButton(page).focus();
    await page.keyboard.press("Enter");
  }
  const dialog = editor(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Clicks Save and returns the permissions the browser posted (the request is read before the click's answer arrives). */
async function saveAndRead(page: Page, dialog: Locator): Promise<{ name: string; permissions: string[] }> {
  const posted = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/roles");
  await save(dialog).click();
  const body = (await posted).postDataJSON() as { name: string; permissions: string[] };
  await expect(dialog).toBeHidden();
  return body;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Geometry

interface Rect { x: number; y: number; width: number; height: number }

async function rectOf(target: Locator, what: string): Promise<Rect> {
  const found = await target.boundingBox();
  expect(found, `${what} has a box on screen`).not.toBeNull();
  return found!;
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** True when the topmost thing at each of four points well inside `target` is `target` or part of it: nothing clips it and nothing covers it. */
const isShownWhole = (target: Locator) =>
  target.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const inset = 12; // beyond the rounded corners
    const points: [number, number][] = [
      [r.left + inset, r.top + inset], [r.right - inset, r.top + inset], [r.left + inset, r.bottom - inset], [r.right - inset, r.bottom - inset],
    ];
    return points.every(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && node.contains(hit);
    });
  });

/** The permission grid and the editor body (the two boxes a card or a bubble could once push sideways) do not scroll sideways. */
async function expectNoSidewaysScroll(dialog: Locator, what: string) {
  for (const selector of [".table-wrap", ".role-editor-body"]) {
    const m = await dialog.locator(selector).evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }));
    expect(m.scroll, `${what}: ${selector} scrolls sideways (${m.scroll} > ${m.client})`).toBeLessThanOrEqual(m.client);
  }
}

/**
 * The card is whole inside the window, shown whole (the topmost thing at its inner corners is the card), off the label of the box it is
 * about, and where `placeTip` puts it: under the label when it fits there, else above it. Waits until the card takes the pointer
 * (the arming delay), so the corner test sees the card and not the box beneath it.
 */
async function expectPlaced(page: Page, group: Locator, label: Locator, what: string) {
  await expect(group).toHaveCSS("pointer-events", "auto");
  const view = page.viewportSize();
  expect(view, "the page has a viewport").not.toBeNull();
  const c = await rectOf(group, `${what}: the card`);
  const l = await rectOf(label, `${what}: the label`);
  const note = `${what}: card ${JSON.stringify(c)}, label ${JSON.stringify(l)}, window ${view!.width}x${view!.height}`;
  expect(c.x, `${note}: left edge`).toBeGreaterThanOrEqual(-0.5);
  expect(c.y, `${note}: top edge`).toBeGreaterThanOrEqual(-0.5);
  expect(c.x + c.width, `${note}: right edge`).toBeLessThanOrEqual(view!.width + 0.5);
  expect(c.y + c.height, `${note}: bottom edge`).toBeLessThanOrEqual(view!.height + 0.5);
  expect(overlaps(c, l), `${note}: the card covers its label`).toBe(false);
  const fitsBelow = l.y + l.height + 6 + c.height <= view!.height - 8; // placeTip's own rule
  if (fitsBelow) expect(c.y, `${note}: there is room below, so the card is below`).toBeGreaterThanOrEqual(l.y + l.height - 0.5);
  else expect(c.y + c.height, `${note}: no room below, so the card is above`).toBeLessThanOrEqual(l.y + 0.5);
  expect(await isShownWhole(group), `${note}: something clips or covers the card`).toBe(true);
}

/** A screenshot of the open card into W9C_SHOTS (nothing when it is not set): light, then dark when the account follows the device. */
async function shoot(page: Page, group: Locator, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await expect(group).toHaveCSS("opacity", "1"); // the fade-in is over: toBeVisible does not wait for it
  await page.screenshot({ path: join(SHOTS, `${name}-light.png`) });
  await page.emulateMedia({ colorScheme: "dark" });
  // A plain wait that does not throw (and so leaves no failed step in the report): an account that chose Light or Dark does not follow
  // the device, and then there is no dark picture of it.
  const followed = await page.waitForFunction(() => document.documentElement.dataset.mode === "dark", null, { timeout: 3_000 }).then(() => true, () => false);
  if (followed) {
    await expect(group).toHaveCSS("opacity", "1");
    await page.screenshot({ path: join(SHOTS, `${name}-dark.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W9c: the Roles editor offers what a permission needs", () => {
  test.beforeAll(async ({ browser }) => {
    await asAdmin(browser, removeMine);
  });

  test.afterAll(async ({ browser }) => {
    await asAdmin(browser, removeMine);
  });

  // 1 ---------------------------------------------------------------------------------------------------------------------------

  test("ticking Change users opens a card that offers See users: it sits whole inside the window, Also tick ticks both, and Save posts exactly the two", async ({ browser }) => {
    test.setTimeout(180_000);
    await asAdminPage(browser, async (page) => {
      const dialog = await openNewRole(page);
      await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(ROLE_USERS);
      const changeUsers = tick(dialog, "Change users");
      const seeUsers = tick(dialog, "See users");
      const sentence = "Change users also needs See users to show anything.";

      await test.step("ticking Change users opens the card, with the primary button focused, beside its box and inside the window", async () => {
        await centred(changeUsers);
        await expect(cards(dialog)).toHaveCount(0);
        await changeUsers.check();
        const offer = card(dialog, sentence);
        await expect(offer).toBeVisible();
        await expect(cards(dialog)).toHaveCount(1);
        await expect(button(offer, "Also tick See users")).toBeFocused();
        await expect(offer.getByRole("button")).toHaveText(["Also tick See users", "Not now"]);
        await expectPlaced(page, offer, labelOf(changeUsers), "Change users");
        await expectNoSidewaysScroll(dialog, "with the card open");
        await expect(changeUsers).toBeChecked();
        await expect(seeUsers).not.toBeChecked();
      });

      await test.step("Also tick See users ticks both, the card goes and the focus is on Change users", async () => {
        const offer = card(dialog, sentence);
        await button(offer, "Also tick See users").click();
        await expect(offer).toHaveCount(0);
        await expect(cards(dialog)).toHaveCount(0);
        await expect(seeUsers).toBeChecked();
        await expect(changeUsers).toBeChecked();
        await expect(changeUsers).toBeFocused();
        await expect(summary(dialog).getByRole("listitem")).toHaveCount(0); // no hint line is left: nothing is missing
        await expectNoSidewaysScroll(dialog, "with the card closed");
      });

      await test.step("Save posts exactly the two ids, and the stored role holds them", async () => {
        const body = await saveAndRead(page, dialog);
        expect(body.name).toBe(ROLE_USERS);
        expect([...body.permissions].sort()).toEqual(["users.edit", "users.view"]); // sorted: the editor posts them in the catalogue's order
        await expect(page.getByRole("button", { name: `Actions for ${ROLE_USERS}`, exact: true })).toBeVisible();
        const stored = (await json<ApiRole[]>(page.request, "/api/roles")).find((role) => role.name === ROLE_USERS);
        expect([...(stored?.permissions ?? [])].sort()).toEqual(["users.edit", "users.view"]);
      });
    });
  });

  // 2 ---------------------------------------------------------------------------------------------------------------------------

  test("Not now on Change tariffs leaves only that box ticked and the hint line in the summary, and Save posts exactly tariffs.edit", async ({ browser }) => {
    test.setTimeout(180_000);
    await asAdminPage(browser, async (page) => {
      const dialog = await openNewRole(page);
      await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(ROLE_TARIFFS);
      const changeTariffs = tick(dialog, "Change tariffs");

      await test.step("two needs are missing, so the card lists both and offers to tick the two", async () => {
        await centred(changeTariffs);
        await changeTariffs.check();
        const offer = card(dialog, "Change tariffs also needs these to show anything:");
        await expect(offer).toBeVisible();
        await expect(offer.getByRole("listitem")).toHaveText(["See tariffs", "See the Assets Tree"]);
        await expect(offer.getByRole("button")).toHaveText(["Also tick 2 permissions", "Not now"]);
        await expectPlaced(page, offer, labelOf(changeTariffs), "Change tariffs");
      });

      await test.step("Not now closes the card, ticks nothing else, and the hint line stays", async () => {
        const offer = card(dialog, "Change tariffs also needs these to show anything:");
        await button(offer, "Not now").click();
        await expect(offer).toHaveCount(0);
        await expect(cards(dialog)).toHaveCount(0);
        await expect(dialog.locator('input[type="checkbox"]:checked')).toHaveCount(1);
        await expect(changeTariffs).toBeChecked();
        await expect(changeTariffs).toBeFocused();
        await expect(summary(dialog).getByRole("listitem")).toHaveCount(1);
        await expect(summary(dialog).getByRole("listitem")).toContainText("Change tariffs also needs");
        await expect(summary(dialog)).toContainText("Opens: no pages.");
      });

      await test.step("Save posts exactly tariffs.edit: a dismissed offer lost and added nothing", async () => {
        const body = await saveAndRead(page, dialog);
        expect(body.name).toBe(ROLE_TARIFFS);
        expect(body.permissions).toEqual(["tariffs.edit"]);
        const stored = (await json<ApiRole[]>(page.request, "/api/roles")).find((role) => role.name === ROLE_TARIFFS);
        expect(stored?.permissions).toEqual(["tariffs.edit"]);
      });
    });
  });

  // 3 ---------------------------------------------------------------------------------------------------------------------------

  test("from the keyboard: Space opens the card on its primary button, Enter ticks both and the focus returns; Escape closes only the card, a second Escape the dialog", async ({ browser }) => {
    test.setTimeout(180_000);
    await asAdminPage(browser, async (page) => {
      // Nothing is clicked from here on, so the mouse rests where it was (no hover-opened tip can be in the way of the keys).
      const dialog = await openNewRole(page, "keyboard");
      const changeUsers = tick(dialog, "Change users");
      const seeUsers = tick(dialog, "See users");

      await test.step("Space on Change users opens the card and the primary button has the focus", async () => {
        await changeUsers.focus();
        await expect(changeUsers).toBeFocused();
        await page.keyboard.press("Space");
        const offer = card(dialog, "Change users also needs See users to show anything.");
        await expect(offer).toBeVisible();
        await expect(button(offer, "Also tick See users")).toBeFocused();
      });

      await test.step("Enter ticks both and the focus is on Change users", async () => {
        await page.keyboard.press("Enter");
        await expect(cards(dialog)).toHaveCount(0);
        await expect(seeUsers).toBeChecked();
        await expect(changeUsers).toBeChecked();
        await expect(changeUsers).toBeFocused();
      });

      await test.step("Space on another box with a need, then Escape: the card is gone, the dialog stays, the box keeps its tick and the focus", async () => {
        const changeTariffs = tick(dialog, "Change tariffs");
        await changeTariffs.focus();
        await page.keyboard.press("Space");
        const offer = card(dialog, "Change tariffs also needs these to show anything:");
        await expect(button(offer, "Also tick 2 permissions")).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(cards(dialog)).toHaveCount(0);
        await expect(dialog).toBeVisible();
        await expect(changeTariffs).toBeChecked();
        await expect(changeTariffs).toBeFocused();
      });

      await test.step("a second Escape closes the dialog and the focus goes back to New role", async () => {
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(newRoleButton(page)).toBeFocused();
      });
    });
  });

  // 4 ---------------------------------------------------------------------------------------------------------------------------

  test("unticking See users while Change users is ticked offers to untick Change users: Leave ticked keeps it, Also untick takes both away", async ({ browser }) => {
    test.setTimeout(180_000);
    await asAdminPage(browser, async (page) => {
      const dialog = await openNewRole(page);
      const seeUsers = tick(dialog, "See users");
      const changeUsers = tick(dialog, "Change users");
      const sentence = "Change users needs See users to show anything. Also untick Change users?";
      const hint = summary(dialog).getByText("Change users also needs See users to show anything.", { exact: true });

      await test.step("ticking the need first, then the permission, opens nothing", async () => {
        await centred(seeUsers);
        await seeUsers.check();
        await expect(cards(dialog)).toHaveCount(0);
        await changeUsers.check();
        await expect(cards(dialog)).toHaveCount(0);
        await expect(hint).toHaveCount(0);
      });

      await test.step("unticking See users opens the untick card beside See users", async () => {
        await seeUsers.uncheck();
        const offer = card(dialog, sentence);
        await expect(offer).toBeVisible();
        await expect(cards(dialog)).toHaveCount(1);
        await expect(offer.getByRole("button")).toHaveText(["Also untick Change users", "Leave ticked"]);
        await expect(button(offer, "Also untick Change users")).toBeFocused();
        await expectPlaced(page, offer, labelOf(seeUsers), "See users, untick offer");
      });

      await test.step("Leave ticked keeps Change users ticked, shows the hint line and puts the focus on See users", async () => {
        await button(card(dialog, sentence), "Leave ticked").click();
        await expect(cards(dialog)).toHaveCount(0);
        await expect(changeUsers).toBeChecked();
        await expect(seeUsers).not.toBeChecked();
        await expect(seeUsers).toBeFocused();
        await expect(hint).toBeVisible();
      });

      await test.step("ticking See users again clears the hint; unticking it and answering Also untick takes both away", async () => {
        await seeUsers.check();
        await expect(cards(dialog)).toHaveCount(0);
        await expect(hint).toHaveCount(0);
        await seeUsers.uncheck();
        const offer = card(dialog, sentence);
        await expect(offer).toBeVisible();
        await button(offer, "Also untick Change users").click();
        await expect(cards(dialog)).toHaveCount(0);
        await expect(seeUsers).not.toBeChecked();
        await expect(changeUsers).not.toBeChecked();
        await expect(seeUsers).toBeFocused();
        await expect(dialog.locator('input[type="checkbox"]:checked')).toHaveCount(0);
        await expect(summary(dialog).getByRole("listitem")).toHaveCount(0);
      });
    });
  });

  // 5 ---------------------------------------------------------------------------------------------------------------------------

  test("the ? bubble of every permission in the Change column opens whole inside the window and the grid does not scroll sideways", async ({ browser }) => {
    test.setTimeout(180_000);
    for (const view of [{ width: 1600, height: 1000 }, { width: 1024, height: 768 }]) {
      await asAdminPage(browser, async (page) => {
        const dialog = await openNewRole(page);
        // The Change column is the third of the grid (Area, See, Change): its boxes are the ones nearest the grid's right edge.
        const perms = dialog.locator(".role-grid tbody td:nth-child(3) .role-perm");
        const count = await perms.count();
        expect(count, "the Change column lists its permissions").toBeGreaterThanOrEqual(6);
        for (let index = 0; index < count; index += 1) {
          const perm = perms.nth(index);
          const name = (await perm.locator("label").innerText()).trim();
          const at = `${view.width} wide, ${name}`;
          await perm.getByRole("button", { name: "What does this mean?", exact: true }).click();
          const bubble = page.locator(".tip-bubble");
          await expect(bubble, at).toBeVisible();
          await expect(bubble, at).toHaveText(/\S/);
          const b = await rectOf(bubble, `${at}: the bubble`);
          expect(b.x, `${at}: bubble left edge ${JSON.stringify(b)}`).toBeGreaterThanOrEqual(-0.5);
          expect(b.x + b.width, `${at}: bubble right edge ${JSON.stringify(b)}`).toBeLessThanOrEqual(view.width + 0.5);
          expect(b.y, `${at}: bubble top edge ${JSON.stringify(b)}`).toBeGreaterThanOrEqual(-0.5);
          expect(b.y + b.height, `${at}: bubble bottom edge ${JSON.stringify(b)}`).toBeLessThanOrEqual(view.height + 0.5);
          expect(await isShownWhole(bubble), `${at}: something clips or covers the bubble`).toBe(true);
          await expectNoSidewaysScroll(dialog, at);
          await page.keyboard.press("Escape"); // closes only the tip
          await expect(page.locator(".tip-bubble"), at).toHaveCount(0);
          await expect(dialog, at).toBeVisible();
        }
      }, view);
    }
  });

  // 6 ---------------------------------------------------------------------------------------------------------------------------

  test("a quick click on the box the card covers goes to that box and leaves one card; a press on the card's text keeps it open and the focus where it is", async ({ browser }) => {
    test.setTimeout(180_000);
    await asAdminPage(browser, async (page) => {
      const dialog = await openNewRole(page);
      const changeDashboards = tick(dialog, "Change dashboards");
      const changeSources = tick(dialog, "Change sources");
      const firstSentence = "Change dashboards also needs these to show anything:";
      const secondSentence = "Change sources also needs See sources to show anything.";

      await tick(dialog, "See dashboards").check(); // so Change dashboards misses two things (the list form), and the card is tall enough to cover Change sources

      // The centre of Change sources is taken BEFORE the tick, with both boxes in view and nothing left to scroll (the tick below does not scroll:
      // Change dashboards is already in the middle of the window and Change sources a few rows under it).
      await centred(changeDashboards);
      await expect(cards(dialog)).toHaveCount(0);
      const view = page.viewportSize();
      expect(view, "the page has a viewport").not.toBeNull();
      const sources = await rectOf(changeSources, "Change sources");
      expect(sources.y, "Change sources is in view").toBeGreaterThanOrEqual(0);
      expect(sources.y + sources.height, "Change sources is in view").toBeLessThanOrEqual(view!.height);
      const at = { x: sources.x + sources.width / 2, y: sources.y + sources.height / 2 };
      // The editor body scrolls and clips: a box inside the window can still be hidden by the body's edge. At this point nothing covers
      // it, so the topmost thing there must be the box (or its own label); anything else is a layout miss, not a defect of the card.
      const isTheBox = await changeSources.evaluate((node, p) => {
        const hit = document.elementFromPoint(p.x, p.y);
        return hit !== null && (hit === node || hit.closest("label") === node.closest("label"));
      }, at);
      expect(isTheBox, `the point ${JSON.stringify(at)} must be on Change sources before the tick (the editor body clips it?)`).toBe(true);
      let elapsed = 0;

      await test.step("the click lands within a few hundred milliseconds of the tick, on the box under the card", async () => {
        const t0 = Date.now();
        await changeDashboards.check();
        const first = card(dialog, firstSentence);
        await expect(first).toBeVisible();
        const covered = await rectOf(first, "the first card");
        expect(
          at.x >= covered.x && at.x <= covered.x + covered.width && at.y >= covered.y && at.y <= covered.y + covered.height,
          `the first card ${JSON.stringify(covered)} must cover the centre of Change sources ${JSON.stringify(at)}`,
        ).toBe(true);
        await page.mouse.click(at.x, at.y);
        elapsed = Date.now() - t0;
      });

      await test.step("Change sources is ticked, the first card is gone and exactly one card is open: the one for Change sources", async () => {
        const slow = `the click came ${elapsed} ms after the tick (the card ignores the pointer for 400 ms; a slow machine can miss that window)`;
        await expect(changeSources, slow).toBeChecked();
        await expect(card(dialog, firstSentence), slow).toHaveCount(0);
        await expect(card(dialog, secondSentence), slow).toBeVisible();
        await expect(cards(dialog), slow).toHaveCount(1);
        await expect(changeDashboards).toBeChecked();
        // The first card's Also tick was never pressed, so none of its needs was ticked behind the user's back.
        await expect(tick(dialog, "See the Assets Tree")).not.toBeChecked();
        await expect(tick(dialog, "See scans and the graph")).not.toBeChecked();
        await expect(tick(dialog, "See sources")).not.toBeChecked();
      });

      await test.step("a press on the card's own text keeps it open and the focus on its primary button", async () => {
        const second = card(dialog, secondSentence);
        const primary = button(second, "Also tick See sources");
        await expect(primary).toBeFocused();
        await second.locator("p").click(); // Playwright waits until the card takes the pointer
        await expect(second).toBeVisible();
        await expect(cards(dialog)).toHaveCount(1);
        await expect(primary).toBeFocused();
        await expect(changeSources).toBeChecked();
      });
    });
  });

  // 7 ---------------------------------------------------------------------------------------------------------------------------

  // Six boxes at different places: the See column (left), the Change column (right, one of them with the widest label) and the Sensitive
  // actions box (several columns, so left, middle and right). Their needs are all different and none is ticked, so each card has the
  // sentence below whatever was ticked before it.
  const PLACES = [
    { label: "See tariffs", sentence: "See tariffs also needs See the Assets Tree to show anything.", where: "see-column" },
    { label: "Change users", sentence: "Change users also needs See users to show anything.", where: "change-column" },
    { label: "Change scan scopes and the graph layout", sentence: "Change scan scopes and the graph layout also needs See scans and the graph to show anything.", where: "change-column-widest" },
    { label: "Accept scan results", sentence: "Accept scan results also needs See scans and the graph to show anything.", where: "sensitive-middle" },
    { label: "Change sign-in protection", sentence: "Change sign-in protection also needs See settings to show anything.", where: "sensitive-right" },
    { label: "Export the audit log", sentence: "Export the audit log also needs See the audit log to show anything.", where: "sensitive-left" },
  ] as const;

  test("at 1024 and 1440 wide the card stays whole inside the window for a box in the See column, the Change column and Sensitive actions", async ({ browser }) => {
    test.setTimeout(300_000);
    for (const view of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
      await asAdminPage(browser, async (page) => {
        const dialog = await openNewRole(page);
        for (const place of PLACES) {
          const at = `${view.width} wide, ${place.label}`;
          const box = tick(dialog, place.label);
          await centred(box);
          await expect(cards(dialog), at).toHaveCount(0);
          await box.check();
          const offer = card(dialog, place.sentence);
          await expect(offer, at).toBeVisible();
          await expect(cards(dialog), at).toHaveCount(1);
          await expectPlaced(page, offer, labelOf(box), at);
          await expectNoSidewaysScroll(dialog, at);
          await shoot(page, offer, `w9c-${view.width}-${place.where}`);
          await page.keyboard.press("Escape"); // dismisses only the card; the box keeps its tick
          await expect(offer, at).toHaveCount(0);
          await expect(box, at).toBeChecked();
          await expect(dialog, at).toBeVisible();
        }
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(dialog).toBeHidden();
      }, view);
    }
  });
});
