import { expect, test, type Page } from "@playwright/test";

// W3a (assets, mapping, sources) on the state the journey, discovery, phase3 and headers projects leave behind: admin `admin` /
// `correct-horse`; the manual source `sim` (60 simulator points; LVP01_kW and LVP01_kWh mapped to the asset MV2); every asset of kind
// `generic`. The spec builds on that and leaves its own assets and the source `idle-renamed` behind.
//
// Locators: a label that wraps a <select> has the option texts in its text, so `getByLabel("Kind", { exact: true })` would never match
// it; those labels are matched by a regular expression anchored at the start (`/^Kind/`). Labels that wrap an <input> are matched
// with `exact: true` where another label could contain the same word ("Name" and "Username", "Kind" and "New kind", "Secret" and
// "Remove the stored secret").

const ADMIN = { username: "admin", password: "correct-horse" };

interface ApiAsset { id: number; parent_id: number | null; name: string; kind: string }
interface ApiSource {
  id: number; name: string; connector_type: string; enabled: boolean; has_secret: boolean; mapped_points: number; config: Record<string, unknown>;
}
interface ApiPoint { id: number; address: string; name: string; unit_hint: string | null; mapping: { id: number; asset_id: number; metric: string } | null }

async function getJson<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.ok(), path).toBe(true);
  return (await response.json()) as T;
}

test("W3a: child assets and a picked Kind, sortable and filterable points, a mapping warning, editing a source", async ({ page }) => {
  test.setTimeout(240_000);

  await test.step("the admin signs in", async () => {
    await page.goto("/login");
    await page.getByLabel("Username").fill(ADMIN.username);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("navigation")).toContainText(`${ADMIN.username} (admin)`);
  });

  await test.step("assets: a + on a branch, Kind picked from a list, one spelling per kind", async () => {
    await page.goto("/assets");
    await expect(page.getByRole("heading", { name: "Assets", exact: true })).toBeVisible();
    const mv2 = (await getJson<ApiAsset[]>(page, "/api/assets")).find((a) => a.name === "MV2");
    expect(mv2, "the asset MV2 from the journey").toBeTruthy();

    const dialog = page.getByRole("dialog", { name: "Add asset" });
    const kind = dialog.getByLabel(/^Kind/);

    // A child of MV2: the dialog opens with MV2 as its Parent, Kind comes from the list
    await page.getByRole("button", { name: "Add child of MV2", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/^Parent/)).toHaveValue(String(mv2!.id));
    await kind.selectOption("Room");
    await dialog.getByLabel("Name", { exact: true }).fill("W3a-Room");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("link", { name: "W3a-Room", exact: true })).toBeVisible();

    // Kind "Other…": a text box appears; a brand-new kind is stored as typed
    await page.getByRole("button", { name: "Add asset", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/^Parent/)).toHaveValue(""); // nothing is selected in the tree, so no parent
    await expect(dialog.getByLabel("New kind", { exact: true })).toHaveCount(0);
    await kind.selectOption({ label: "Other…" });
    await dialog.getByLabel("New kind", { exact: true }).fill("LV_Panel");
    await dialog.getByLabel("Name", { exact: true }).fill("W3a-Panel-A");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("link", { name: "W3a-Panel-A", exact: true })).toBeVisible();

    // The same kind typed with other case and a trailing blank reuses the stored spelling, and the list now offers it
    await page.getByRole("button", { name: "Add asset", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(kind.locator("option[value='LV_Panel']")).toHaveCount(1);
    await kind.selectOption({ label: "Other…" });
    await dialog.getByLabel("New kind", { exact: true }).fill("lv_panel ");
    await dialog.getByLabel("Name", { exact: true }).fill("W3a-Panel-B");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("link", { name: "W3a-Panel-B", exact: true })).toBeVisible();

    const assets = await getJson<ApiAsset[]>(page, "/api/assets");
    const byName = (name: string) => assets.find((a) => a.name === name);
    expect(byName("W3a-Room")).toMatchObject({ kind: "Room", parent_id: mv2!.id });
    expect(byName("W3a-Panel-A")).toMatchObject({ kind: "LV_Panel", parent_id: null });
    expect(byName("W3a-Panel-B")).toMatchObject({ kind: "LV_Panel", parent_id: null });
    expect(assets.filter((a) => a.kind.trim().toLowerCase() === "lv_panel").map((a) => a.kind), "one spelling of the kind").toEqual(["LV_Panel", "LV_Panel"]);
  });

  await test.step("points of sim: sort, unmapped only, search", async () => {
    const sources = await getJson<ApiSource[]>(page, "/api/sources");
    const sim = sources.find((s) => s.name === "sim")!;
    expect(sim, "the source sim from the journey").toBeTruthy();
    const points = await getJson<ApiPoint[]>(page, `/api/sources/${sim.id}/points`);
    const mapped = points.filter((p) => p.mapping !== null);
    const unmapped = points.filter((p) => p.mapping === null);
    expect(mapped.map((p) => p.address), "mapped by the journey").toEqual(expect.arrayContaining(["LVP01_kW", "LVP01_kWh"]));
    expect(sim.mapped_points, "the sources list counts mapped points").toBe(mapped.length);
    const total = points.length;

    await page.goto(`/sources/${sim.id}/points`);
    await expect(page.getByRole("heading", { name: "Points", exact: true })).toBeVisible();
    const rows = page.locator("tbody tr");
    const addresses = page.locator("tbody tr td:first-child");
    const count = (shown: number) => page.getByText(`Showing ${shown} of ${total} points`, { exact: true });
    await expect(rows).toHaveCount(total);
    await expect(count(total)).toBeVisible();

    // Sort by Name: ascending, then descending, which reverses the whole list (the names are unique)
    const nameHeader = page.getByRole("columnheader", { name: "Name", exact: true });
    const sortByName = page.getByRole("button", { name: "Name", exact: true });
    await sortByName.click();
    await expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
    const ascending = await addresses.allTextContents();
    expect(ascending).toHaveLength(total);
    await sortByName.click();
    await expect(nameHeader).toHaveAttribute("aria-sort", "descending");
    const descending = await addresses.allTextContents();
    expect(descending[0], "first row after the second click is the last row after the first").toBe(ascending[ascending.length - 1]);
    expect(descending[descending.length - 1]).toBe(ascending[0]);
    expect(descending).toEqual([...ascending].reverse());

    // Unmapped only: the mapped rows are gone and the count line follows
    const unmappedOnly = page.getByRole("checkbox", { name: "Unmapped only" });
    await unmappedOnly.check();
    await expect(rows).toHaveCount(unmapped.length);
    await expect(count(unmapped.length)).toBeVisible();
    for (const p of mapped) await expect(page.getByRole("cell", { name: p.address, exact: true })).toHaveCount(0);

    // Search `_V` (plain `V` would match every row: all addresses contain LVP) narrows the rows to the voltage points
    const search = page.getByLabel("Search points");
    const voltage = unmapped.filter((p) => p.address.endsWith("_V")).map((p) => p.address).sort();
    expect(voltage.length, "some voltage points, but not every row").toBeGreaterThan(0);
    expect(voltage.length).toBeLessThan(unmapped.length);
    await search.fill("_V");
    await expect(rows).toHaveCount(voltage.length);
    await expect(count(voltage.length)).toBeVisible();
    expect((await addresses.allTextContents()).sort()).toEqual(voltage);

    // A search that matches nothing says so, and does not claim there are no points at all
    await search.fill("no-such-point-anywhere");
    await expect(page.getByText("No points match the filters.")).toBeVisible();
    await expect(page.getByText("No points yet", { exact: false })).toHaveCount(0);
    await expect(rows).toHaveCount(0);

    // Clear both: everything is back
    await search.fill("");
    await unmappedOnly.uncheck();
    await expect(rows).toHaveCount(total);
    await expect(count(total)).toBeVisible();
    await expect(page.getByRole("cell", { name: "LVP01_kW", exact: true })).toBeVisible();

    // The mapping dialog warns when the unit hint belongs to another metric. Open it on an unmapped voltage point (unit hint `V`).
    const voltagePoint = unmapped.find((p) => p.unit_hint === "V")!;
    expect(voltagePoint, "an unmapped point with unit hint V").toBeTruthy();
    const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: voltagePoint.address, exact: true }) });
    const mapButton = row.getByRole("button", { name: "Map", exact: true });
    const dialog = page.getByRole("dialog", { name: `Map ${voltagePoint.address}` });
    const warning = dialog.getByRole("status");
    const metric = dialog.getByLabel(/^Metric/);

    // Escape with the first field focused and no select popup open closes the dialog and gives the focus back to the button
    await mapButton.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/^Asset/)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(mapButton).toBeFocused();

    // The wrong metric warns but does not block; the matching metric clears the warning; Escape with the Metric select focused closes
    await mapButton.click();
    await expect(dialog).toBeVisible();
    await metric.selectOption("energy_kwh");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(/unit hint is "V".*voltage_v.*not energy_kwh/);
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await metric.selectOption("voltage_v");
    await expect(warning).toHaveCount(0);
    await metric.focus();
    await expect(metric).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(mapButton).toBeFocused();

    // Neither Escape saved anything
    const after = await getJson<ApiPoint[]>(page, `/api/sources/${sim.id}/points`);
    expect(after.find((p) => p.id === voltagePoint.id)!.mapping, "Escape does not map the point").toBeNull();
  });

  await test.step("sources: an unmapped source reads not polled, and Edit renames it", async () => {
    await page.goto("/sources");
    await expect(page.getByRole("heading", { name: "Sources", exact: true })).toBeVisible();
    const sourceRow = (name: string) => page.getByRole("row").filter({ has: page.getByRole("cell", { name, exact: true }) });

    // A source with mapped points is polled, so its status is the stored one
    await expect(sourceRow("sim")).toBeVisible();
    await expect(sourceRow("sim")).not.toContainText("not polled");

    // Add a second simulator source with no mapping
    const add = page.getByRole("dialog", { name: "Add source" });
    await page.getByRole("button", { name: "Add source", exact: true }).click();
    await expect(add.getByLabel("Name", { exact: true })).toBeVisible(); // the connector list has loaded
    await add.getByLabel(/^Connector/).selectOption("simulator");
    await add.getByLabel(/^Url/i).fill("http://simulator:9000");
    await add.getByLabel("Name", { exact: true }).fill("idle");
    await add.getByLabel("Secret", { exact: true }).fill("idle-key");
    await add.getByRole("button", { name: "Save", exact: true }).click();
    await expect(add).toBeHidden();
    await expect(sourceRow("idle")).toBeVisible();
    await expect(sourceRow("idle")).toContainText("not polled (no mapped points)");
    const idle = (await getJson<ApiSource[]>(page, "/api/sources")).find((s) => s.name === "idle")!;
    expect(idle.mapped_points).toBe(0);
    expect(idle.has_secret).toBe(true);

    // Edit it: the stored values are in the form, the connector is fixed, and a blank Secret keeps the stored one
    const edit = page.getByRole("dialog", { name: "Edit source idle" });
    await sourceRow("idle").getByRole("button", { name: "Edit", exact: true }).click();
    await expect(edit).toBeVisible();
    await expect(edit.getByLabel("Name", { exact: true })).toHaveValue("idle");
    await expect(edit.getByText("Connector: simulator")).toBeVisible();
    await expect(edit.getByLabel(/^Url/i)).toHaveValue(/simulator:9000/);
    await expect(edit.getByText("A secret is stored; leave blank to keep it.")).toBeVisible();
    await expect(edit.getByLabel("Secret", { exact: true })).toHaveValue("");
    await edit.getByLabel("Name", { exact: true }).fill("idle-renamed");
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await expect(edit).toBeHidden();
    await expect(sourceRow("idle-renamed")).toBeVisible();
    await expect(sourceRow("idle-renamed")).toContainText("not polled (no mapped points)");
    await expect(page.getByRole("cell", { name: "idle", exact: true })).toHaveCount(0);

    const renamed = (await getJson<ApiSource[]>(page, "/api/sources")).filter((s) => s.id === idle.id);
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatchObject({ name: "idle-renamed", connector_type: "simulator", enabled: true, has_secret: true });
  });
});
