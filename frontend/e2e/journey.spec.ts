import { expect, test } from "@playwright/test";
import { navLink, treeLink } from "./shell";

test("first-run journey: setup, simulator source, map two points, live values", async ({ page }) => {
  // 1. First-run setup
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "First-run setup" })).toBeVisible();
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password", { exact: true }).fill("correct-horse");
  await page.getByLabel("Confirm password").fill("correct-horse");
  await page.getByRole("button", { name: "Create admin" }).click();
  await expect(page).toHaveURL(/\/assets$/);
  await expect(page.getByRole("heading", { name: "Assets" })).toBeVisible();

  // 2. Add the simulator source and test it
  await navLink(page, "Sources").click();
  await expect(page.getByRole("heading", { name: "Sources" })).toBeVisible();
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByLabel("Name").fill("sim");
  await page.getByLabel("Connector").selectOption("simulator");
  await page.getByLabel(/^Url/i).fill("http://simulator:9000");
  await page.getByLabel("Secret").fill("sim-key");
  await page.getByRole("button", { name: "Save" }).click();
  const simRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "sim", exact: true }) });
  await expect(simRow).toBeVisible();
  await simRow.getByRole("button", { name: "Test" }).click();
  await expect(simRow).toContainText("online", { timeout: 30_000 });

  // 3. Browse points
  await simRow.getByRole("link", { name: "Points" }).click();
  await expect(page.getByRole("heading", { name: "Points" })).toBeVisible();
  await page.getByRole("button", { name: "Browse points" }).click();
  await expect(page.getByText(/found \d+ points/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Refresh list" }).click();
  await expect(page.getByRole("cell", { name: "LVP01_kW", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("cell", { name: "LVP01_kWh", exact: true })).toBeVisible();

  // 4. Create an asset
  await navLink(page, "Assets").click();
  await page.getByRole("button", { name: "Add asset" }).click();
  await page.getByLabel("Name").fill("MV2");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(treeLink(page, "MV2")).toBeVisible();

  // 5. Map two points to MV2
  await navLink(page, "Sources").click();
  await page.getByRole("row").filter({ has: page.getByRole("cell", { name: "sim", exact: true }) })
    .getByRole("link", { name: "Points" }).click();
  await expect(page.getByRole("heading", { name: "Points" })).toBeVisible();
  for (const [address, metric] of [["LVP01_kW", "active_power_kw"], ["LVP01_kWh", "energy_kwh"]] as const) {
    const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: address, exact: true }) });
    await row.getByRole("button", { name: "Map" }).click();
    await expect(page.getByRole("heading", { name: `Map ${address}` })).toBeVisible();
    await page.getByLabel("Asset").selectOption({ label: "MV2" });
    await page.getByLabel("Metric").selectOption(metric);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(row).toContainText(`MV2 · ${metric}`);
  }

  // 6. Live values on the asset page within 10 s
  await navLink(page, "Assets").click();
  // A tree node is a link to the asset page: one click opens it, and the tree stays beside it.
  await treeLink(page, "MV2").click();
  await expect(page).toHaveURL(/\/assets\/\d+$/);
  await expect(page.getByRole("heading", { name: "MV2" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Metrics" })).toBeVisible();
  const power = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "active_power_kw", exact: true }) });
  await expect(power).toBeVisible();
  await expect(power.getByRole("cell").nth(1)).toHaveText(/^-?\d+\.\d{2}$/, { timeout: 20_000 });
  await expect(page.getByText("live", { exact: true })).toBeVisible();
});
