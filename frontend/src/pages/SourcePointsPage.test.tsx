import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import type { PermissionId } from "../lib/permissions";
import { renderWithProviders } from "../test/render";
import { accountKnown, SignedIn } from "../test/signedIn";
import { spyToasts } from "../test/toasts";
import { userFor } from "../test/users";
import { SourcePointsPage } from "./SourcePointsPage";

const points = [
  { id: 7, address: "panel1/power", name: "Panel 1 power", data_type: "float", unit_hint: "kW", mapping: null },
  { id: 8, address: "panel1/energy", name: "Panel 1 energy", data_type: "float", unit_hint: "kWh",
    mapping: { id: 2, asset_id: 4, metric: "energy_kwh", scale: 1, interval_seconds: 60, custom_unit: null } },
];
/** Opens a row's three-dot menu (named `Actions for <point name>`) and chooses an item. Items are in the DOM only while the menu is open. */
async function choose(row: HTMLElement, item: string) {
  await userEvent.click(within(row).getByRole("button", { name: /^Actions for / }));
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}
/** Unmap… opens a confirmation (W12a): this answers it. */
const confirmUnmap = async () => userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Unmap" }));
const routes = {
  "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: userFor("admin", { username: "a" }) },
  "GET /api/assets": { body: [{ id: 4, parent_id: null, name: "Panel 1", kind: "panel", sort_order: 0 }] },
  "GET /api/sources": { body: [{ id: 2, name: "sim", connector_type: "simulator", config: {}, enabled: true, status: "online", last_seen: null, last_error: null, has_secret: false }] },
  "GET /api/sources/2/points": { body: points },
  "POST /api/sources/2/browse": { status: 202, body: { job_id: 11 } },
  "GET /api/jobs/11": { body: { id: 11, kind: "browse_source", status: "done", result: { count: 2 }, created_at: "t", finished_at: "t" } },
  "POST /api/mappings": { status: 201, body: { id: 3, point_id: 7, asset_id: 4, metric: "active_power_kw", scale: 1, interval_seconds: 5, custom_unit: null } },
  "GET /api/mappings/2": { body: { id: 2, point_id: 8, asset_id: 4, metric: "energy_kwh", scale: 1, interval_seconds: 60, custom_unit: null } }, // what the module reads before it deletes
  "DELETE /api/mappings/2": { status: 204 },
};

describe("SourcePointsPage", () => {
  it("browses, then maps an unmapped point", async () => {
    const calls = mockFetch(routes);
    renderWithProviders(<SourcePointsPage />, { route: "/sources/2/points", path: "/sources/:id/points" });
    await userEvent.click(await screen.findByRole("button", { name: "Browse points" }));
    expect(await screen.findByText("sim", { selector: "[aria-current]" })).toBeInTheDocument();
    expect(await screen.findByText("found 2 points")).toBeInTheDocument();
    const row = (await screen.findByText("panel1/power")).closest("tr")!;
    await choose(row, "Map");
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
    expect(await within(row).findByText(/Panel 1 · energy_kwh/)).toBeInTheDocument(); // the asset names wait for the account (assets.view)
    await choose(row, "Unmap…");
    await confirmUnmap();
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/mappings/2")).toBe(true));
  });

  it("shows the API conflict message", async () => {
    mockFetch({ ...routes, "POST /api/mappings": { status: 409, body: { detail: "this point is already mapped, or the asset already has this metric" } } });
    renderWithProviders(<SourcePointsPage />, { route: "/sources/2/points", path: "/sources/:id/points" });
    const row = (await screen.findByText("panel1/power")).closest("tr")!;
    await choose(row, "Map");
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
    await choose(row, "Map");
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
    await choose(row, "Map");
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
    await choose(screen.getByText("panel1/power").closest("tr")!, "Map");
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
    await choose(screen.getByText("panel1/energy").closest("tr")!, "Unmap…");
    await confirmUnmap();
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
    await choose(await rowOf("panel1/power"), "Map");
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
    await choose(await rowOf("panel1/energy"), "Edit");
    const dialog = screen.getByRole("dialog", { name: "Edit mapping panel1/energy" });
    expect(within(dialog).getByLabelText("Asset")).toHaveValue("4");
    expect(within(dialog).getByLabelText("Metric")).toHaveValue("energy_kwh");
  });

  it("closes the dialog and refreshes the list when Save succeeds", async () => {
    const calls = mockFetch(routes);
    page();
    await choose(await rowOf("panel1/power"), "Map");
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
    await choose(await rowOf("panel1/power"), "Map");
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("already mapped");
  });

  it("ignores Escape and Cancel while Save is in flight, so the refusal that comes back is still on screen", async () => {
    const calls = mockFetch({ ...routes, "POST /api/mappings": { status: 409, body: { detail: "this point is already mapped" } } });
    const hold = holdFetch((method, path) => method === "POST" && path === "/api/mappings");
    page();
    await choose(await rowOf("panel1/power"), "Map");
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    hold.release();
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("already mapped");
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" })).toBeEnabled();
    expect(calls.filter((c) => c.method === "POST" && c.path === "/api/mappings")).toHaveLength(1);
    await userEvent.keyboard("{Escape}"); // the save is over: Escape closes the dialog again
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the dialog on Cancel without a request, and returns focus to the row's menu button", async () => {
    const calls = mockFetch(routes);
    page();
    const row = await rowOf("panel1/power");
    await choose(row, "Map");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Actions for Panel 1 power" })).toHaveFocus();
    expect(calls.some((c) => c.method === "POST" || c.method === "PATCH")).toBe(false);
  });

  it("closes the dialog on Escape", async () => {
    mockFetch(routes);
    page();
    await choose(await rowOf("panel1/power"), "Map");
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
    await choose(await rowOf("bus/volts"), "Map");
    expect(within(screen.getByRole("dialog")).getByRole("status")).toHaveTextContent(`unit hint is "V"`);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await choose(await rowOf("panel1/energy"), "Edit");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("starts the form afresh when another row is mapped after the first dialog was closed", async () => {
    mockFetch(routes);
    page();
    await choose(await rowOf("panel1/power"), "Map");
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await choose(await rowOf("panel1/energy"), "Edit");
    expect(screen.getByRole("dialog", { name: "Edit mapping panel1/energy" })).toBeInTheDocument();
    expect(screen.getByLabelText("Metric")).toHaveValue("energy_kwh");
  });
});

describe("SourcePointsPage look (W6)", () => {
  const page = () => renderWithProviders(<SourcePointsPage />, { route: "/sources/2/points", path: "/sources/:id/points" });

  it("shows the trail Sources / sim: Sources links to the list, the source is the current page, one h1 Points, Browse points the primary action", async () => {
    mockFetch(routes);
    page();
    const nav = await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(nav).toHaveClass("crumbs");
    expect(within(nav).getByRole("link", { name: "Sources" })).toHaveAttribute("href", "/sources");
    const current = within(nav).getByText("sim");
    expect(current).toHaveAttribute("aria-current", "page");
    expect(within(nav).getAllByRole("link")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Browse points" })).toHaveClass("primary");
  });

  it("shows an unmapped point with a shape and the word, and a mapped one as plain text", async () => {
    mockFetch(routes);
    page();
    const unmapped = within((await screen.findByText("panel1/power")).closest("tr")!).getByText("unmapped");
    expect(unmapped).toHaveClass("muted", "st", "st-off");
    expect(within(screen.getByText("panel1/energy").closest("tr")!).queryByText("unmapped")).not.toBeInTheDocument();
  });

  it("gives each row a menu: Map for an unmapped point, Edit and a danger-toned Unmap… for a mapped one, which asks first", async () => {
    const calls = mockFetch(routes);
    const confirm = vi.spyOn(window, "confirm");
    page();
    const unmapped = (await screen.findByText("panel1/power")).closest("tr")!;
    await userEvent.click(within(unmapped).getByRole("button", { name: "Actions for Panel 1 power" }));
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Map"]);
    await userEvent.keyboard("{Escape}");
    const mapped = screen.getByText("panel1/energy").closest("tr")!;
    expect(within(mapped).getByRole("button", { name: "Actions for Panel 1 energy" }).closest("td")).toHaveClass("row-actions");
    await userEvent.click(within(mapped).getByRole("button", { name: "Actions for Panel 1 energy" }));
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Edit", "Unmap…"]);
    expect(screen.getByRole("menuitem", { name: "Unmap…" })).toHaveClass("danger-item");
    expect(screen.getByRole("menuitem", { name: "Edit" })).not.toHaveClass("danger-item");
    await userEvent.click(screen.getByRole("menuitem", { name: "Unmap…" }));
    // the page's own dialog (never the browser's) asks, and nothing is sent until it is answered
    const dialog = await screen.findByRole("dialog", { name: 'Unmap "Panel 1 energy" from Panel 1?' });
    expect(dialog).toHaveTextContent("Billing for months that are still open is recalculated without it; closed months keep their billed figures.");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(within(mapped).getByRole("button", { name: "Actions for Panel 1 energy" })).toHaveFocus(); // the dialog gives the focus back
  });

  it("Unmap… reads the mapping, deletes it, toasts with an Undo, and puts the focus on the row's menu button (the point stays in the list, now unmapped)", async () => {
    let unmapped = false;
    const calls = mockFetch({
      ...routes,
      "GET /api/sources/2/points": () => ({ body: [
        points[0],
        unmapped ? { ...points[1], mapping: null } : { ...points[1], mapping: { ...points[1].mapping!, scale: 0.001, interval_seconds: 5 } },
      ] }),
      "GET /api/mappings/2": { body: { id: 2, point_id: 8, asset_id: 4, metric: "energy_kwh", scale: 0.001, interval_seconds: 5, custom_unit: null } },
      "DELETE /api/mappings/2": () => { unmapped = true; return { status: 204 }; },
    });
    const spy = spyToasts();
    renderWithProviders(<SourcePointsPage />, { route: "/sources/2/points", path: "/sources/:id/points", toasts: spy.api });
    const row = (await screen.findByText("panel1/energy")).closest("tr")!;
    await choose(row, "Unmap…");
    await confirmUnmap();
    await waitFor(() => expect(spy.calls).toHaveLength(1));
    expect(calls.filter((c) => c.path === "/api/mappings/2").map((c) => c.method)).toEqual(["GET", "DELETE"]);
    expect(spy.calls[0]).toMatchObject({ kind: "success", text: "Unmapped 1 point from Panel 1.", options: { durationMs: 10_000, action: { label: "Undo" } } });
    expect(await within(row).findByText("unmapped")).toBeInTheDocument();
    await waitFor(() => expect(within(row).getByRole("button", { name: "Actions for Panel 1 energy" })).toHaveFocus());
    act(() => spy.calls[0].options!.action!.onAction());
    await waitFor(() => expect(spy.calls).toHaveLength(2));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/mappings")?.body).toEqual({
      point_id: 8, asset_id: 4, metric: "energy_kwh", scale: 0.001, interval_seconds: 5, custom_unit: null,
    });
  });

  it("after the toast's Undo the focus is on the row's menu button again, not the body (the Undo button left with its toast)", async () => {
    let unmapped = false;
    mockFetch({
      ...routes,
      "GET /api/sources/2/points": () => ({ body: [points[0], unmapped ? { ...points[1], mapping: null } : points[1]] }),
      "DELETE /api/mappings/2": () => { unmapped = true; return { status: 204 }; },
      "POST /api/mappings": () => { unmapped = false; return { status: 201, body: { id: 5, point_id: 8, asset_id: 4, metric: "energy_kwh", scale: 1, interval_seconds: 60, custom_unit: null } }; },
    });
    const spy = spyToasts();
    renderWithProviders(<SourcePointsPage />, { route: "/sources/2/points", path: "/sources/:id/points", toasts: spy.api });
    const row = (await screen.findByText("panel1/energy")).closest("tr")!;
    await choose(row, "Unmap…");
    await confirmUnmap();
    await waitFor(() => expect(spy.calls).toHaveLength(1));
    await waitFor(() => expect(within(row).getByRole("button", { name: "Actions for Panel 1 energy" })).toHaveFocus());
    // Pressed from the toast, whose button holds the focus and goes away with the toast.
    const toastButton = document.body.appendChild(document.createElement("div")).appendChild(document.createElement("button"));
    toastButton.parentElement!.className = "toast-stack";
    toastButton.focus();
    act(() => spy.calls[0].options!.action!.onAction());
    toastButton.parentElement!.remove();
    expect(document.activeElement).toBe(document.body);
    await waitFor(() => expect(spy.calls).toHaveLength(2));
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(within(row).getByRole("button", { name: "Actions for Panel 1 energy" })).toHaveFocus();
  });

  it("when the filter drops the row once it is unmapped, the focus goes to the search box (the row's button is gone)", async () => {
    let unmapped = false;
    mockFetch({
      ...routes,
      "GET /api/sources/2/points": () => ({ body: [points[0], unmapped ? { ...points[1], mapping: null } : points[1]] }),
      "DELETE /api/mappings/2": () => { unmapped = true; return { status: 204 }; },
    });
    renderWithProviders(<SourcePointsPage />, { route: "/sources/2/points", path: "/sources/:id/points", toasts: spyToasts().api });
    await screen.findByText("panel1/energy");
    const search = screen.getByRole("searchbox", { name: "Search points" });
    await userEvent.type(search, "energy_kwh"); // matches the mapped row by its metric only
    await choose(screen.getByText("panel1/energy").closest("tr")!, "Unmap…");
    await confirmUnmap();
    await waitFor(() => expect(screen.queryByText("panel1/energy")).not.toBeInTheDocument());
    await waitFor(() => expect(search).toHaveFocus());
  });

  it("a delete the server refuses is an error toast, and the row keeps its mapping and the focus", async () => {
    mockFetch({ ...routes, "DELETE /api/mappings/2": { status: 500, body: { detail: "database is busy" } } });
    const spy = spyToasts();
    renderWithProviders(<SourcePointsPage />, { route: "/sources/2/points", path: "/sources/:id/points", toasts: spy.api });
    const row = (await screen.findByText("panel1/energy")).closest("tr")!;
    await choose(row, "Unmap…");
    await confirmUnmap();
    await waitFor(() => expect(spy.calls).toHaveLength(1));
    expect(spy.calls[0]).toEqual({ kind: "error", text: '"Panel 1 energy" could not be unmapped: Database is busy.' });
    expect(within(row).queryByText("unmapped")).not.toBeInTheDocument();
    await waitFor(() => expect(within(row).getByRole("button", { name: "Actions for Panel 1 energy" })).toHaveFocus());
  });

  it("a sort header is a quiet button inside the th, and only the sorted one draws the arrow", async () => {
    mockFetch(routes);
    page();
    await screen.findByText("panel1/power");
    const address = screen.getByRole("button", { name: "Address" });
    expect(address).toHaveClass("th-sort");
    expect(address.querySelector("svg.sort-mark")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Name" }).querySelector("svg")).toBeNull();
    expect(address.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("with no points, shows the empty look instead of an empty table", async () => {
    mockFetch({ ...routes, "GET /api/sources/2/points": { body: [] } });
    page();
    const empty = await screen.findByText(/No points yet/);
    expect(empty.closest(".empty")).not.toBeNull();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("SourcePointsPage while the points load (W7f)", () => {
  const LABEL = "Loading points";
  const page = () => renderWithProviders(<SourcePointsPage />, { route: "/sources/2/points", path: "/sources/:id/points" });
  const heldPoints = () => holdFetch((_method, path) => path === "/api/sources/2/points");

  it("shows one region around a header, a toolbar and a table placeholder while the points are held, with nothing to read or press, then the table", async () => {
    mockFetch(routes);
    const held = heldPoints();
    page();
    const region = screen.getByText(LABEL).parentElement!;
    expect(region).toHaveAttribute("role", "status");
    expect(region.querySelector("header.page-head .crumbs")).not.toBeNull(); // the title and the trail depend on data: both are placeholders
    expect(region.querySelector("header.page-head .actions")).not.toBeNull();
    expect(region.querySelectorAll(".sk-table thead th")).toHaveLength(6); // five sortable columns and the row menu's
    expect(region.querySelector(".row.toolbar")).not.toBeNull(); // the real table sits under the real toolbar
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/No points yet/)).not.toBeInTheDocument();
    held.release();
    expect(await screen.findByText("panel1/power")).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Points" })).toBeInTheDocument();
  });

  it("ends with the empty state for a source with no points, and no region", async () => {
    mockFetch({ ...routes, "GET /api/sources/2/points": { body: [] } });
    page();
    expect(await screen.findByText(/No points yet/)).toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
  });

  it("ends with the error alone when the first fetch fails, and no region", async () => {
    mockFetch({ ...routes, "GET /api/sources/2/points": { status: 500, body: { detail: "the source is gone" } } });
    page();
    expect(await screen.findByRole("alert")).toHaveTextContent("the source is gone");
    expect(document.querySelector(".sk-region")).toBeNull();
  });
});

describe("SourcePointsPage controls follow the permissions of the role (a custom role)", () => {
  /** A role called "custom" that holds `permissions` (the page itself needs sources.edit); the table and the account are in when this returns. */
  const show = async (permissions: PermissionId[]) => {
    const calls = mockFetch({ ...routes, "GET /api/me": { body: userFor("custom", { permissions: ["sources.edit", "sources.view", ...permissions] }) } });
    renderWithProviders(<><SourcePointsPage /><SignedIn /></>, { route: "/sources/2/points", path: "/sources/:id/points" });
    await screen.findByText("panel1/energy");
    await accountKnown();
    return calls;
  };

  it("sources.edit alone: Browse points, and no Map, Edit or Unmap menu on any row", async () => {
    const calls = await show([]);
    expect(screen.getByRole("button", { name: "Browse points" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/assets")).toBe(false); // without assets.view the asset list is not asked for
    expect(screen.getByText(/#4 · energy_kwh/)).toBeInTheDocument(); // and the mapped row names the asset by its id
  });

  it("assets.edit without assets.view: still no menu (the form picks the asset from the list that role cannot read)", async () => {
    await show(["assets.edit"]);
    expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument();
  });

  it("assets.view without assets.edit: asset names, and no menu", async () => {
    await show(["assets.view"]);
    expect(await screen.findByText(/Panel 1 · energy_kwh/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument();
  });

  it("assets.edit and assets.view: Map on an unmapped point, Edit and Unmap on a mapped one", async () => {
    const calls = await show(["assets.edit", "assets.view"]);
    const unmapped = (await screen.findByText("panel1/power")).closest("tr")!;
    await userEvent.click(within(unmapped).getByRole("button", { name: /^Actions for / }));
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Map"]);
    await userEvent.keyboard("{Escape}");
    const mapped = screen.getByText("panel1/energy").closest("tr")!;
    await userEvent.click(within(mapped).getByRole("button", { name: /^Actions for / }));
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Edit", "Unmap…"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Unmap…" }));
    await confirmUnmap();
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/mappings/2")).toBe(true));
  });
});
