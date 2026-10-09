import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { SourcePointsPage } from "./SourcePointsPage";

const points = [
  { id: 7, address: "panel1/power", name: "Panel 1 power", data_type: "float", unit_hint: "kW", mapping: null },
  { id: 8, address: "panel1/energy", name: "Panel 1 energy", data_type: "float", unit_hint: "kWh",
    mapping: { id: 2, asset_id: 4, metric: "energy_kwh", scale: 1, interval_seconds: 60, custom_unit: null } },
];
const routes = {
  "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "a", role: "admin" } },
  "GET /api/assets": { body: [{ id: 4, parent_id: null, name: "Panel 1", kind: "panel", sort_order: 0 }] },
  "GET /api/sources": { body: [{ id: 2, name: "sim", connector_type: "simulator", config: {}, enabled: true, status: "online", last_seen: null, last_error: null, has_secret: false }] },
  "GET /api/sources/2/points": { body: points },
  "POST /api/sources/2/browse": { status: 202, body: { job_id: 11 } },
  "GET /api/jobs/11": { body: { id: 11, kind: "browse_source", status: "done", result: { count: 2 }, created_at: "t", finished_at: "t" } },
  "POST /api/mappings": { status: 201, body: { id: 3, point_id: 7, asset_id: 4, metric: "active_power_kw", scale: 1, interval_seconds: 5, custom_unit: null } },
  "DELETE /api/mappings/2": { status: 204 },
};

describe("SourcePointsPage", () => {
  it("browses, then maps an unmapped point", async () => {
    const calls = mockFetch(routes);
    renderWithProviders(<SourcePointsPage />, { route: "/sources/2/points", path: "/sources/:id/points" });
    await userEvent.click(await screen.findByRole("button", { name: "Browse points" }));
    expect(await screen.findByText("/ sim")).toBeInTheDocument();
    expect(await screen.findByText("found 2 points")).toBeInTheDocument();
    const row = (await screen.findByText("panel1/power")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Map" }));
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "4");
    await userEvent.selectOptions(screen.getByLabelText("Metric"), "active_power_kw");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(calls.find((c) => c.path === "/api/mappings")?.body).toEqual({
      point_id: 7, asset_id: 4, metric: "active_power_kw", scale: 1, interval_seconds: null, custom_unit: null,
    });
  });

  it("shows the existing mapping and unmaps it", async () => {
    const calls = mockFetch(routes);
    renderWithProviders(<SourcePointsPage />, { route: "/sources/2/points", path: "/sources/:id/points" });
    const row = (await screen.findByText("panel1/energy")).closest("tr")!;
    expect(within(row).getByText(/Panel 1 · energy_kwh/)).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Unmap" }));
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/mappings/2")).toBe(true);
  });

  it("shows the API conflict message", async () => {
    mockFetch({ ...routes, "POST /api/mappings": { status: 409, body: { detail: "this point is already mapped, or the asset already has this metric" } } });
    renderWithProviders(<SourcePointsPage />, { route: "/sources/2/points", path: "/sources/:id/points" });
    const row = (await screen.findByText("panel1/power")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Map" }));
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already mapped");
  });

  it("tells two assets with one name apart: in the Map form's Asset list and in a mapped row's Mapped to cell", async () => {
    mockFetch({
      ...routes,
      "GET /api/assets": { body: [
        { id: 1, parent_id: null, name: "Room 1", kind: "room", sort_order: 0 },
        { id: 2, parent_id: null, name: "Room 2", kind: "room", sort_order: 1 },
        { id: 3, parent_id: 1, name: "LV Panel", kind: "panel", sort_order: 0 },
        { id: 4, parent_id: 2, name: "LV Panel", kind: "panel", sort_order: 0 },
      ] },
    });
    renderWithProviders(<SourcePointsPage />, { route: "/sources/2/points", path: "/sources/:id/points" });
    const mapped = (await screen.findByText("panel1/energy")).closest("tr")!;
    expect(await within(mapped).findByText(/^LV Panel \(Room 2\) · energy_kwh/)).toBeInTheDocument();
    const row = screen.getByText("panel1/power").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Map" }));
    const texts = within(screen.getByLabelText("Asset")).getAllByRole("option").map((o) => o.textContent!.replace(/\u00a0/g, "").trim());
    expect(texts).toEqual(["(choose)", "Room 1", "LV Panel (Room 1)", "Room 2", "LV Panel (Room 2)"]);
  });
});
