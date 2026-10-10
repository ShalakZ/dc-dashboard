import { expect, test, type Locator, type Page } from "@playwright/test";

async function drag(page: Page, from: Locator, to: Locator | { x: number; y: number }) {
  const a = (await from.boundingBox())!;
  const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  let end: { x: number; y: number };
  if ("x" in to) {
    end = to;
  } else {
    const b = (await to.boundingBox())!;
    end = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 6, start.y + 6, { steps: 3 }); // d3-drag needs real intermediate moves; locator.dragTo is not enough
  await page.mouse.move(end.x, end.y, { steps: 25 });
  await page.mouse.up();
}
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

/** Resolves once `target` has stopped moving: React Flow animates the viewport, and boxes taken mid-animation are stale. */
async function settled(target: Locator) {
  let previous = "";
  await expect.poll(async () => {
    const box = await target.boundingBox();
    const now = JSON.stringify(box);
    const same = box !== null && now === previous;
    previous = now;
    return same;
  }, { intervals: [150], message: "node never stopped moving after fit view" }).toBe(true);
}

/** The "fit view" control; the nodes are small, so re-fit whenever the layout changed. */
async function fitView(page: Page, target: Locator) {
  await page.getByRole("button", { name: "fit view" }).click();
  await settled(target);
}

/** Re-fit when `target` is not fully inside the canvas (a node that is off-screen cannot be clicked or dragged). */
async function ensureOnCanvas(page: Page, target: Locator) {
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  const box = await target.boundingBox();
  const inside = box !== null && box.x >= pane.x && box.y >= pane.y
    && box.x + box.width <= pane.x + pane.width && box.y + box.height <= pane.y + pane.height;
  if (!inside) await fitView(page, target);
}

const METRICS = ["active_power_kw", "energy_kwh", "voltage_v", "current_a", "power_factor", "frequency_hz"];

interface GraphPoint { id: number; mapping_id: number | null }
interface GraphSource {
  id: number; name: string; connector_type: string; clusters: { key: string; points: GraphPoint[] }[]; ungrouped: GraphPoint[];
}

test("discovery journey: scan, drag to map, create assets, audit", async ({ page }) => {
  test.setTimeout(240_000); // the scan wait alone is up to 90 s, and the default budget for the whole test is 90 s
  // 1. Sign in; a root asset and Panel 01 under it (through the API with the session cookie)
  await page.goto("/login");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password", { exact: true }).fill("correct-horse");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Assets" })).toBeVisible();
  const siteRes = await page.request.post("/api/assets", { data: { name: "Site", parent_id: null, kind: "generic", sort_order: 0 } });
  expect(siteRes.ok()).toBe(true);
  const site = (await siteRes.json()) as { id: number };
  const panelRes = await page.request.post("/api/assets", { data: { name: "Panel 01", parent_id: site.id, kind: "generic", sort_order: 0 } });
  expect(panelRes.ok()).toBe(true);
  const panel = (await panelRes.json()) as { id: number };

  // 2. Scope and scan: the HTTP simulator already exists as the manual source `sim`; OPC UA and Modbus are new
  await page.getByRole("link", { name: "Scans", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scans", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New scope" }).click();
  await expect(page.getByLabel("Targets")).toBeVisible();
  await page.getByLabel("Name").fill("sim");
  await page.getByLabel("Targets").fill("simulator");
  await page.getByLabel("Ports").fill("9000, 4840, 5020");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("cell", { name: "sim", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await expect(page.getByText("1 hosts × 3 ports (3 probes)")).toBeVisible();
  await page.getByRole("button", { name: "Start scan" }).click();
  const findings = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Outcome" }) });
  await expect(findings.locator("tbody tr")).toHaveCount(3, { timeout: 90_000 });
  const findingRow = (cell: string) => findings.getByRole("row").filter({ has: page.getByRole("cell", { name: cell, exact: true }) });
  await expect(findingRow("opcua")).toContainText("claimed");
  await expect(findingRow("modbus")).toContainText("claimed");
  await expect(findingRow("9000")).toContainText("existing source");

  // 3. The graph: expand the OPC UA source into ten clusters
  const graphRes = await page.request.get("/api/discovery/graph");
  expect(graphRes.ok()).toBe(true);
  const opcua = ((await graphRes.json()) as { sources: GraphSource[] }).sources.find((s) => s.connector_type === "opcua")!;
  expect(opcua).toBeTruthy();
  await page.getByRole("link", { name: "Discovery", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Discovery", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Expand ${opcua.name}` }).click();
  const cluster = (key: string) => node(page, `cluster:${opcua.id}:${key}`);
  await expect(page.locator(`.react-flow__node[data-id^="cluster:${opcua.id}:"]`)).toHaveCount(10);
  await expect(cluster("__ungrouped__")).toHaveCount(0); // all 60 points group, so there is no Ungrouped bag
  for (let n = 1; n <= 10; n++) await expect(cluster(`LVP${String(n).padStart(2, "0")}`)).toBeVisible();
  await fitView(page, cluster("LVP01"));

  const dialog = page.getByRole("dialog", { name: "Review mappings" });

  // 4. Real drag 1: the LVP01 cluster onto the asset Panel 01
  await drag(page, cluster("LVP01").locator(".node-title"), node(page, `asset:${panel.id}`));
  await expect(dialog).toBeVisible();
  const boxes = dialog.getByRole("checkbox");
  await expect(boxes).toHaveCount(6);
  for (const box of await boxes.all()) await expect(box).toBeChecked();
  await expect(dialog.getByText(/Fix the conflict|already has|already maps/)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Create mappings" }).click();
  await expect(dialog).toBeHidden();
  await expect(cluster("LVP01")).toContainText("6 mapped");
  await fitView(page, cluster("LVP02"));

  // 5. Real drag 2: the LVP02 cluster onto empty canvas offers a new asset
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  await drag(page, cluster("LVP02").locator(".node-title"), { x: pane.x + pane.width - 40, y: pane.y + pane.height - 40 });
  await expect(page.getByText('Create asset "LVP02" from this cluster?')).toBeVisible();
  await page.getByRole("button", { name: "Create asset…" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("New asset name")).toHaveValue("LVP02");
  await dialog.getByLabel("Parent asset").selectOption({ label: "Site" });
  await dialog.getByRole("button", { name: "Create mappings" }).click();
  await expect(dialog).toBeHidden();
  await expect(cluster("LVP02")).toContainText("6 mapped");
  await fitView(page, cluster("LVP03"));

  // 6. LVP03 ... LVP10 through the buttons: no dragging
  for (let n = 3; n <= 10; n++) {
    const name = `LVP${String(n).padStart(2, "0")}`;
    await ensureOnCanvas(page, cluster(name));
    await cluster(name).getByRole("button", { name: `New asset from ${name}…` }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Parent asset").selectOption({ label: "Site" });
    await dialog.getByRole("button", { name: "Create mappings" }).click();
    await expect(dialog).toBeHidden();
    await expect(cluster(name)).toContainText("6 mapped");
  }

  // 7. The done-when, through the API
  const after = (await (await page.request.get("/api/discovery/graph")).json()) as { sources: GraphSource[] };
  const mapped = after.sources.find((s) => s.id === opcua.id)!;
  const points = [...mapped.clusters.flatMap((c) => c.points), ...mapped.ungrouped];
  expect(points).toHaveLength(60);
  expect(points.every((p) => p.mapping_id !== null)).toBe(true);

  const assets = (await (await page.request.get("/api/assets")).json()) as { id: number; name: string }[];
  const names = ["Panel 01", ...Array.from({ length: 9 }, (_, i) => `LVP${String(i + 2).padStart(2, "0")}`)];
  const ids = new Map<string, number>();
  for (const name of names) {
    const found = assets.filter((a) => a.name === name);
    expect(found, name).toHaveLength(1);
    ids.set(name, found[0].id);
    const summary = (await (await page.request.get(`/api/assets/${found[0].id}/summary`)).json()) as { metrics: { metric: string }[] };
    expect(summary.metrics, `${name} mappings`).toHaveLength(6);
    expect(summary.metrics.map((m) => m.metric).sort(), `${name} metrics`).toEqual([...METRICS].sort());
  }

  await page.goto(`/assets/${ids.get("LVP05")}`);
  await expect(page.getByRole("heading", { name: "LVP05" })).toBeVisible();
  await expect(page.getByText("live", { exact: true })).toBeVisible({ timeout: 30_000 });
  const power = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "active_power_kw", exact: true }) });
  await expect(power.getByRole("cell").nth(1)).toHaveText(/^-?\d+\.\d{2}$/, { timeout: 30_000 });

  // 8. The audit log: the scope, the scan and ten accepted mappings. The page shows only the newest 50 rows and every
  // sign-in adds one, so the counts are read from the API instead.
  await page.getByRole("link", { name: "Audit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  await expect(page.getByRole("row").nth(1)).toBeVisible(); // the header row and at least one entry
  const auditCounts = async () => {
    const body = (await (await page.request.get("/api/audit?limit=200")).json()) as { items: { action: string }[] };
    const wanted = ["scope.created", "scan.started", "scan.finished", "discovery.accepted"];
    return Object.fromEntries(wanted.map((name) => [name, body.items.filter((e) => e.action === name).length]));
  };
  await expect.poll(auditCounts, { message: "audit counts" }).toEqual({
    "scope.created": 1,
    "scan.started": 1,
    "scan.finished": 1,
    "discovery.accepted": 10,
  });
});
