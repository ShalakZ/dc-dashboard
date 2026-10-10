import { screen, waitFor, within } from "@testing-library/react";
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

describe("SourcePointsPage sorting, filtering and search", () => {
  const page = () => renderWithProviders(<SourcePointsPage />, { route: "/sources/2/points", path: "/sources/:id/points" });
  const point = (id: number, address: string, name: string, extra: Record<string, unknown> = {}) =>
    ({ id, address, name, data_type: "float", unit_hint: null, mapping: null, ...extra });
  const mapping = (id: number, metric: string) => ({ id, asset_id: 4, metric, scale: 1, interval_seconds: 60, custom_unit: null });
  /** The addresses in the table body, top to bottom. */
  const shown = () => screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent);
  const withPoints = (list: unknown[]) => ({ ...routes, "GET /api/sources/2/points": { body: list } });

  it("lists the points in natural address order, with the Address column marked as the sort", async () => {
    mockFetch(withPoints([point(1, "4:1", "c"), point(2, "3:10", "b"), point(3, "3:2", "a")]));
    page();
    await screen.findByText("3:10");
    expect(shown()).toEqual(["3:2", "3:10", "4:1"]);
    expect(screen.getByRole("columnheader", { name: "Address" })).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByRole("columnheader", { name: "Name" })).not.toHaveAttribute("aria-sort");
  });

  it("re-orders the rows from the header buttons: a new column ascending, the same column again descending", async () => {
    mockFetch(withPoints([point(1, "a1", "Pump"), point(2, "a2", "Boiler"), point(3, "a3", "Fan", { unit_hint: "kW" })]));
    page();
    await screen.findByText("a1");
    await userEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(shown()).toEqual(["a2", "a3", "a1"]);
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByRole("columnheader", { name: "Address" })).not.toHaveAttribute("aria-sort");
    await userEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(shown()).toEqual(["a1", "a3", "a2"]);
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "descending");
    await userEvent.click(screen.getByRole("button", { name: "Unit hint" }));
    expect(shown()).toEqual(["a1", "a2", "a3"]); // blank hints first, then kW
    await userEvent.click(screen.getByRole("button", { name: "Type" }));
    expect(screen.getByRole("columnheader", { name: "Type" })).toHaveAttribute("aria-sort", "ascending");
    await userEvent.click(screen.getByRole("button", { name: "Mapped to" }));
    expect(screen.getByRole("columnheader", { name: "Mapped to" })).toHaveAttribute("aria-sort", "ascending");
  });

  it("shows only the unmapped points with the Unmapped only box", async () => {
    mockFetch(withPoints([point(1, "a1", "x", { mapping: mapping(5, "energy_kwh") }), point(2, "a2", "y"), point(3, "a3", "z")]));
    page();
    await screen.findByText("a1");
    await userEvent.click(screen.getByRole("checkbox", { name: "Unmapped only" }));
    expect(shown()).toEqual(["a2", "a3"]);
    await userEvent.click(screen.getByRole("checkbox", { name: "Unmapped only" }));
    expect(shown()).toEqual(["a1", "a2", "a3"]);
  });

  it("filters by the Search points box and counts what is shown out of all the points", async () => {
    const many = Array.from({ length: 60 }, (_, i) => point(i + 1, `3:${i + 1}`, i < 3 ? `Pump ${i + 1}` : `Sensor ${i + 1}`));
    mockFetch(withPoints(many));
    page();
    await screen.findByText("3:1");
    expect(screen.getByText("Showing 60 of 60 points")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search points" }), "pump");
    expect(shown()).toEqual(["3:1", "3:2", "3:3"]);
    expect(screen.getByText("Showing 3 of 60 points")).toBeInTheDocument();
  });

  it("searches the mapped asset's label and the metric too", async () => {
    mockFetch(withPoints([point(1, "a1", "x", { mapping: mapping(5, "energy_kwh") }), point(2, "a2", "y")]));
    page();
    await screen.findByText("a1");
    const search = screen.getByRole("searchbox", { name: "Search points" });
    await userEvent.type(search, "panel 1");
    expect(shown()).toEqual(["a1"]);
    await userEvent.clear(search);
    await userEvent.type(search, "energy_kwh");
    expect(shown()).toEqual(["a1"]);
  });

  it("says when the filters match nothing, without the no-points-yet line", async () => {
    mockFetch(withPoints([point(1, "a1", "x"), point(2, "a2", "y")]));
    page();
    await screen.findByText("a1");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search points" }), "zzz");
    expect(screen.getByText("No points match the filters.")).toBeInTheDocument();
    expect(screen.queryByText(/No points yet/)).not.toBeInTheDocument();
    expect(screen.getByText("Showing 0 of 2 points")).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("searchbox", { name: "Search points" }));
    expect(screen.queryByText("No points match the filters.")).not.toBeInTheDocument();
  });

  it("says no points match when Unmapped only and a search leave nothing", async () => {
    mockFetch(withPoints([point(1, "a1", "pump", { mapping: mapping(5, "energy_kwh") }), point(2, "a2", "fan")]));
    page();
    await screen.findByText("a1");
    await userEvent.click(screen.getByRole("checkbox", { name: "Unmapped only" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search points" }), "pump");
    expect(screen.getByText("No points match the filters.")).toBeInTheDocument();
    expect(screen.queryByText(/No points yet/)).not.toBeInTheDocument();
  });

  it("with no points at all shows only the no-points-yet line", async () => {
    mockFetch(withPoints([]));
    page();
    expect(await screen.findByText(/No points yet\. Browse the source to discover them\./)).toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
    expect(screen.queryByText("No points match the filters.")).not.toBeInTheDocument();
  });

  it("keeps the table and an open mapping form when a later refetch fails, and shows the error as a banner", async () => {
    let answers = 0;
    mockFetch({
      ...routes,
      "GET /api/sources/2/points": () => (answers++ === 0 ? { body: points } : { status: 500, body: { detail: "database is down" } }),
    });
    page();
    await userEvent.click(await screen.findByRole("button", { name: "Browse points" }));
    const row = (await screen.findByText("panel1/power")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Map" }));
    expect(screen.getByRole("heading", { name: "Map panel1/power" })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Refresh list" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("database is down");
    expect(screen.getByText("panel1/power")).toBeInTheDocument();
    expect(screen.getByText("panel1/energy")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Map panel1/power" })).toBeInTheDocument();
    expect(screen.getByLabelText("Asset")).toBeInTheDocument();
  });

  it("shows the error alone when the very first load fails", async () => {
    mockFetch({ ...routes, "GET /api/sources/2/points": { status: 500, body: { detail: "database is down" } } });
    page();
    expect(await screen.findByRole("alert")).toHaveTextContent("database is down");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("keeps the filters and the sort after a point is mapped", async () => {
    let mapped = false;
    mockFetch({
      ...routes,
      "GET /api/sources/2/points": () => ({ body: [
        point(7, "panel1/power", "Panel 1 power", mapped ? { mapping: mapping(3, "active_power_kw") } : {}),
        point(8, "panel1/energy", "Panel 1 energy", { mapping: mapping(2, "energy_kwh") }),
        point(9, "panel2/power", "Panel 2 power"),
      ] }),
      "POST /api/mappings": () => { mapped = true; return { status: 201, body: { id: 3 } }; },
    });
    page();
    await screen.findByText("panel1/power");
    await userEvent.click(screen.getByRole("checkbox", { name: "Unmapped only" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search points" }), "power");
    await userEvent.click(screen.getByRole("button", { name: "Name" }));
    await userEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(shown()).toEqual(["panel2/power", "panel1/power"]);
    await userEvent.click(within(screen.getByText("panel1/power").closest("tr")!).getByRole("button", { name: "Map" }));
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByText("panel1/power")).not.toBeInTheDocument()); // now mapped, so filtered out
    expect(shown()).toEqual(["panel2/power"]);
    expect(screen.getByRole("checkbox", { name: "Unmapped only" })).toBeChecked();
    expect(screen.getByRole("searchbox", { name: "Search points" })).toHaveValue("power");
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByText("Showing 1 of 3 points")).toBeInTheDocument();
  });

  it("keeps the filters after a point is unmapped", async () => {
    let unmapped = false;
    mockFetch({
      ...routes,
      "GET /api/sources/2/points": () => ({ body: [
        point(7, "panel1/power", "Panel 1 power"),
        point(8, "panel1/energy", "Panel 1 energy", unmapped ? {} : { mapping: mapping(2, "energy_kwh") }),
      ] }),
      "DELETE /api/mappings/2": () => { unmapped = true; return { status: 204 }; },
    });
    page();
    await screen.findByText("panel1/energy");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search points" }), "energy");
    expect(shown()).toEqual(["panel1/energy"]);
    await userEvent.click(screen.getByRole("button", { name: "Unmap" }));
    expect(await screen.findByText("unmapped")).toBeInTheDocument();
    expect(shown()).toEqual(["panel1/energy"]);
    expect(screen.getByRole("searchbox", { name: "Search points" })).toHaveValue("energy");
  });

  it("keeps the filters and the sort when the list is refreshed after a Browse", async () => {
    let browsed = false;
    mockFetch({
      ...routes,
      "GET /api/sources/2/points": () => ({ body: [
        point(7, "panel1/power", "Panel 1 power"),
        point(8, "panel1/energy", "Panel 1 energy"),
        ...(browsed ? [point(9, "panel9/power", "Panel 9 power")] : []),
      ] }),
      "POST /api/sources/2/browse": () => { browsed = true; return { status: 202, body: { job_id: 11 } }; },
    });
    page();
    await screen.findByText("panel1/power");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search points" }), "power");
    await userEvent.click(screen.getByRole("button", { name: "Name" }));
    await userEvent.click(screen.getByRole("button", { name: "Name" }));
    await userEvent.click(screen.getByRole("button", { name: "Browse points" }));
    await userEvent.click(await screen.findByRole("button", { name: "Refresh list" }));
    expect(await screen.findByText("panel9/power")).toBeInTheDocument();
    expect(shown()).toEqual(["panel9/power", "panel1/power"]);
    expect(screen.getByRole("searchbox", { name: "Search points" })).toHaveValue("power");
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "descending");
  });
});

describe("SourcePointsPage mapping dialog", () => {
  const page = () => renderWithProviders(<SourcePointsPage />, { route: "/sources/2/points", path: "/sources/:id/points" });
  const rowOf = async (address: string) => (await screen.findByText(address)).closest("tr")!;

  it("opens Map as a dialog titled Map <address>, and not inline below the table", async () => {
    mockFetch(routes);
    page();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(within(await rowOf("panel1/power")).getByRole("button", { name: "Map" }));
    const dialog = screen.getByRole("dialog", { name: "Map panel1/power" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("heading", { name: "Map panel1/power" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Asset")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(within(screen.getByRole("table")).queryByLabelText("Asset")).not.toBeInTheDocument();
  });

  it("opens Edit as a dialog titled Edit mapping <address>, prefilled from the mapping", async () => {
    mockFetch(routes);
    page();
    await userEvent.click(within(await rowOf("panel1/energy")).getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit mapping panel1/energy" });
    expect(within(dialog).getByLabelText("Asset")).toHaveValue("4");
    expect(within(dialog).getByLabelText("Metric")).toHaveValue("energy_kwh");
  });

  it("closes the dialog and refreshes the list when Save succeeds", async () => {
    const calls = mockFetch(routes);
    page();
    await userEvent.click(within(await rowOf("panel1/power")).getByRole("button", { name: "Map" }));
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "4");
    const loads = () => calls.filter((c) => c.method === "GET" && c.path === "/api/sources/2/points").length;
    const before = loads();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(loads()).toBeGreaterThan(before));
  });

  it("keeps the dialog open and shows the error when Save fails", async () => {
    mockFetch({ ...routes, "POST /api/mappings": { status: 409, body: { detail: "this point is already mapped" } } });
    page();
    await userEvent.click(within(await rowOf("panel1/power")).getByRole("button", { name: "Map" }));
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("already mapped");
  });

  it("closes the dialog on Cancel without a request, and returns focus to the row's button", async () => {
    const calls = mockFetch(routes);
    page();
    const map = within(await rowOf("panel1/power")).getByRole("button", { name: "Map" });
    await userEvent.click(map);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(map).toHaveFocus();
    expect(calls.some((c) => c.method === "POST" || c.method === "PATCH")).toBe(false);
  });

  it("closes the dialog on Escape", async () => {
    mockFetch(routes);
    page();
    await userEvent.click(within(await rowOf("panel1/power")).getByRole("button", { name: "Map" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("gives the dialog the row's unit hint: a V point warns on the default power metric, a kWh point on energy_kwh does not", async () => {
    mockFetch({
      ...routes,
      "GET /api/sources/2/points": { body: [
        { id: 7, address: "bus/volts", name: "Bus voltage", data_type: "float", unit_hint: "V", mapping: null },
        points[1],
      ] },
    });
    page();
    await userEvent.click(within(await rowOf("bus/volts")).getByRole("button", { name: "Map" }));
    expect(within(screen.getByRole("dialog")).getByRole("status")).toHaveTextContent(`unit hint is "V"`);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(within(await rowOf("panel1/energy")).getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("starts the form afresh when another row is mapped after the first dialog was closed", async () => {
    mockFetch(routes);
    page();
    await userEvent.click(within(await rowOf("panel1/power")).getByRole("button", { name: "Map" }));
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(within(await rowOf("panel1/energy")).getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog", { name: "Edit mapping panel1/energy" })).toBeInTheDocument();
    expect(screen.getByLabelText("Metric")).toHaveValue("energy_kwh");
  });
});
