import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Role } from "../api/types";
import { defaultSize, nextPosition, toDrafts } from "../lib/layout";
import { assetList, authed, config, dashboard, widget, widgetDataRoute } from "../test/dashboardFixtures";
import { FakeEventSource } from "../test/fakeEventSource";
import { mockFetch, type Routes } from "../test/fetchMock";
import { model, point, source } from "../test/graphFixtures";
import { renderWithDataRouter } from "../test/render";
import { DashboardPage } from "./DashboardPage";

vi.mock("echarts-for-react", () => ({ default: (props: { option: unknown }) => <pre data-testid="chart">{JSON.stringify(props.option)}</pre> }));

// Same stand-in for the grid as DashboardGrid.test.tsx: `move-{key}` and `resize-{key}` play a finished drag or resize.
vi.mock("react-grid-layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-grid-layout")>();
  return {
    ...actual,
    default: (props: Record<string, any>) => (
      <div data-testid="rgl">
        {props.children}
        {props.layout.map((item: { i: string }) => (
          <span key={item.i}>
            <button data-testid={`move-${item.i}`} onClick={() => props.onDragStop(props.layout.map((l: any) => (l.i === item.i ? { ...l, x: 4, y: 7 } : l)))} />
            <button data-testid={`resize-${item.i}`} onClick={() => props.onResizeStop(props.layout.map((l: any) => (l.i === item.i ? { ...l, w: 9, h: 5 } : l)))} />
          </span>
        ))}
      </div>
    ),
    useContainerWidth: () => ({ width: 1000, mounted: true, containerRef: { current: null }, measureWidth: () => {} }),
  };
});

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
});

type Call = { method: string; path: string; body: unknown };
const now = widget(1, "stat", { title: "Current power", config: config({ aggregation: "last" }), x: 0, y: 0, w: 3, h: 2 });
const base = dashboard({ widgets: [now] });
/** The discovery graph: assets 5 and 6 are mapped to active power, asset 2 to voltage, and nothing else to anything. */
const graph = model({
  sources: [source(1, {
    clusters: [{ key: "LV", points: [
      point(1, "LV1 kW", { asset_id: 5, mapping_id: 1, mapped_metric: "active_power_kw" }),
      point(2, "LV2 kW", { asset_id: 6, mapping_id: 2, mapped_metric: "active_power_kw" }),
    ] }],
    ungrouped: [point(3, "MV2 V", { asset_id: 2, mapping_id: 3, mapped_metric: "voltage_v" })],
  })],
});
const putBody = (calls: Call[]) => calls.find((c) => c.method === "PUT")?.body;
const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT");

function open(role: Role, entry: string | { pathname: string; state?: unknown } = "/dashboards/3", over: Routes = {}) {
  const calls = mockFetch({
    ...authed(role),
    "GET /api/dashboards/3": { body: base },
    "GET /api/assets": { body: assetList },
    "GET /api/discovery/graph": { body: graph },
    "POST /api/widget-data": widgetDataRoute,
    // The server's answer to a save: the sent dashboard with new widget ids and a later updated_at.
    "PUT /api/dashboards/3": ({ body }) => {
      const sent = body as { name: string; range: string; widgets: object[] };
      return { body: { ...base, name: sent.name, range: sent.range, updated_at: "2026-10-08T07:00:00+00:00", widgets: sent.widgets.map((w, i) => ({ id: 100 + i, ...w })) } };
    },
    ...over,
  });
  const view = renderWithDataRouter(<DashboardPage />, { route: entry, path: "/dashboards/:id" });
  return { calls, ...view };
}
const add = () => screen.getByRole("button", { name: "Add widget" });
const saveButton = () => screen.getByRole("button", { name: "Save" });
async function startEditing() {
  await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
  await screen.findByLabelText("Dashboard name");
  await waitFor(() => expect(add()).toBeEnabled()); // the asset list and the metric mappings have arrived
}

describe("who can edit", () => {
  it("never shows edit mode to a viewer, even when asked for through the router state", async () => {
    open("viewer", { pathname: "/dashboards/3", state: { edit: true } });
    expect(await screen.findByRole("heading", { name: "Hall A" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Dashboard name")).not.toBeInTheDocument();
  });

  it("lets an operator enter edit mode and cancel back to the view without being asked when nothing changed", async () => {
    const { calls } = open("operator");
    await startEditing();
    expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall A");
    expect(screen.getByLabelText("Dashboard range")).toHaveValue("24h");
    expect(saveButton()).toBeDisabled(); // nothing changed yet
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("heading", { name: "Hall A" })).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(puts(calls)).toHaveLength(0);
  });

  it("asks before Cancel throws edits away: Keep editing stays with them, Leave discards them and saves nothing", async () => {
    const { calls } = open("operator");
    await startEditing();
    await userEvent.type(screen.getByLabelText("Dashboard name"), " renamed");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const prompt = await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    await userEvent.click(within(prompt).getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall A renamed");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(await screen.findByRole("button", { name: "Leave and discard changes" }));
    expect(await screen.findByRole("heading", { name: "Hall A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(puts(calls)).toHaveLength(0);
  });

  it("forgets the router state without a second prompt when the edits are discarded or saved (the blocker ignores a same-page replace)", async () => {
    const created = { pathname: "/dashboards/3", state: { edit: true } };
    const first = open("operator", created);
    await screen.findByLabelText("Dashboard name");
    await userEvent.type(screen.getByLabelText("Dashboard name"), " x");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(await screen.findByRole("button", { name: "Leave and discard changes" }));
    await screen.findByRole("button", { name: "Edit" });
    await waitFor(() => expect(first.router.state.location.state).toBeNull());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    first.unmount();

    const second = open("operator", created);
    await screen.findByLabelText("Dashboard name");
    await userEvent.type(screen.getByLabelText("Dashboard name"), " y");
    await userEvent.click(saveButton());
    await screen.findByRole("heading", { name: "Hall A y" });
    await waitFor(() => expect(second.router.state.location.state).toBeNull());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("opens straight in edit mode after a dashboard was just created, and forgets the router state when it leaves", async () => {
    const { router } = open("operator", { pathname: "/dashboards/3", state: { edit: true } });
    await screen.findByLabelText("Dashboard name");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("button", { name: "Edit" });
    await waitFor(() => expect(router.state.location.state).toBeNull());
  });
});

describe("editing", () => {
  it("adds a widget, saves the exact body, and returns to the view with the server's dashboard", async () => {
    const { calls } = open("operator");
    await startEditing();
    await userEvent.click(add());
    await userEvent.type(screen.getByLabelText("Title"), "Hall power");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Save widget" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Hall power" })).toBeInTheDocument();
    await userEvent.click(saveButton());
    const size = defaultSize("timeseries");
    expect(putBody(calls)).toEqual({
      name: "Hall A", range: "24h", updated_at: "2026-10-08T06:00:00+00:00",
      widgets: [
        { type: "stat", title: "Current power", config: now.config, x: 0, y: 0, w: 3, h: 2 },
        {
          type: "timeseries", title: "Hall power",
          config: { assets: [5], source: "metric", metric: "active_power_kw", aggregation: "avg", range: null, bars: "asset", min: 0, max: null },
          ...nextPosition(toDrafts(base.widgets), size), ...size,
        },
      ],
    });
    expect(await screen.findByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Hall power" })).toBeInTheDocument();
  });

  it("offers a metric widget only the assets mapped to that metric, taken from the discovery graph", async () => {
    open("operator");
    await startEditing();
    await userEvent.click(add());
    expect(screen.getAllByRole("checkbox").map((box) => box.parentElement?.textContent)).toEqual(["LV Panel 1", "LV Panel 2"]);
    await userEvent.selectOptions(screen.getByLabelText("Metric"), "voltage_v");
    expect(screen.getAllByRole("checkbox").map((box) => box.parentElement?.textContent)).toEqual(["MV2"]);
    await userEvent.selectOptions(screen.getByLabelText("Source"), "energy");
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
  });

  it("edits a widget in place", async () => {
    const { calls } = open("operator");
    await startEditing();
    await userEvent.click(screen.getByRole("button", { name: "Edit Current power" }));
    expect(screen.getByRole("dialog", { name: "Edit widget" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "LV Panel 1" })).toBeChecked();
    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), "Now");
    await userEvent.click(screen.getByRole("button", { name: "Save widget" }));
    await userEvent.click(saveButton());
    expect((putBody(calls) as { widgets: unknown[] }).widgets).toEqual([{ type: "stat", title: "Now", config: now.config, x: 0, y: 0, w: 3, h: 2 }]);
  });

  it("deletes a widget from the draft and saves the empty list", async () => {
    const { calls } = open("operator");
    await startEditing();
    await userEvent.click(screen.getByRole("button", { name: "Delete Current power" }));
    expect(screen.queryByRole("region", { name: "Current power" })).not.toBeInTheDocument();
    expect(screen.getByText("No widgets yet. Use Add widget.")).toBeInTheDocument();
    await userEvent.click(saveButton());
    expect((putBody(calls) as { widgets: unknown[] }).widgets).toEqual([]);
  });

  it("saves a new name and range", async () => {
    const { calls } = open("operator");
    await startEditing();
    const name = screen.getByLabelText("Dashboard name");
    await userEvent.clear(name);
    await userEvent.type(name, "  Hall A2 ");
    await userEvent.selectOptions(screen.getByLabelText("Dashboard range"), "7d");
    await userEvent.click(saveButton());
    expect(putBody(calls)).toMatchObject({ name: "Hall A2", range: "7d", updated_at: "2026-10-08T06:00:00+00:00" });
    expect(await screen.findByRole("heading", { name: "Hall A2" })).toBeInTheDocument(); // the server's copy, although GET still answers the old one
    expect(screen.getByLabelText("Dashboard range")).toHaveValue("7d");
  });

  it("saves the position and size a drag and a resize produced", async () => {
    const { calls } = open("operator");
    await startEditing();
    await userEvent.click(await screen.findByTestId(/^move-/));
    await userEvent.click(screen.getByTestId(/^resize-/));
    await userEvent.click(saveButton());
    expect((putBody(calls) as { widgets: unknown[] }).widgets).toEqual([{ type: "stat", title: "Current power", config: now.config, x: 4, y: 7, w: 9, h: 5 }]);
  });

  it("will not add a 25th widget", async () => {
    const full = dashboard({ widgets: Array.from({ length: 24 }, (_, i) => widget(i + 1, "stat", { title: `W${i + 1}`, x: 0, y: i * 2, w: 3, h: 2 })) });
    open("operator", "/dashboards/3", { "GET /api/dashboards/3": { body: full } });
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByLabelText("Dashboard name");
    await waitFor(() => expect(screen.getByText("A dashboard can have at most 24 widgets.")).toBeInTheDocument());
    expect(add()).toBeDisabled();
  });
});

describe("before the mappings are known", () => {
  it("keeps Add widget and every Edit button off, and says why, when the metric mappings cannot be loaded", async () => {
    open("operator", "/dashboards/3", { "GET /api/discovery/graph": { status: 500, body: { detail: "graph unavailable" } } });
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(await screen.findByText("Could not load the metric mappings: graph unavailable")).toBeInTheDocument();
    expect(add()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit Current power" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Current power" })).toBeEnabled();
  });

  it("keeps Add widget off, and says why, when the assets cannot be loaded", async () => {
    open("operator", "/dashboards/3", { "GET /api/assets": { status: 500, body: { detail: "assets unavailable" } } });
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(await screen.findByText("Could not load the assets: assets unavailable")).toBeInTheDocument();
    expect(add()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit Current power" })).toBeDisabled();
  });
});

describe("saving that fails", () => {
  it("never overwrites a dashboard someone else saved: it says so and offers Reload (Review Focus 4, UI side)", async () => {
    let reads = 0;
    const newer = dashboard({ name: "Hall A (Sam)", updated_at: "2026-10-08T06:30:00+00:00", widgets: [now] });
    const { calls } = open("operator", "/dashboards/3", {
      "GET /api/dashboards/3": () => ({ body: reads++ === 0 ? base : newer }),
      "PUT /api/dashboards/3": { status: 409, body: { detail: "dashboard changed since you loaded it" } },
    });
    await startEditing();
    await userEvent.type(screen.getByLabelText("Dashboard name"), " mine");
    await userEvent.click(saveButton());
    expect(await screen.findByText("This dashboard was changed by someone else")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(puts(calls)).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall A (Sam)"));
    expect(screen.queryByText("This dashboard was changed by someone else")).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled(); // reloaded: nothing to save, and nothing was sent behind the user's back
    expect(puts(calls)).toHaveLength(1);
  });

  it("shows the server's message, not the reload banner, when the name is taken", async () => {
    open("operator", "/dashboards/3", { "PUT /api/dashboards/3": { status: 409, body: { detail: "a dashboard with this name already exists" } } });
    await startEditing();
    await userEvent.type(screen.getByLabelText("Dashboard name"), "2");
    await userEvent.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall A2");
  });

  it("keeps the edits and shows the message when the API refuses the dashboard", async () => {
    open("operator", "/dashboards/3", { "PUT /api/dashboards/3": { status: 422, body: { detail: 'widget 1 ("Current power"): assets: at most 20 assets' } } });
    await startEditing();
    await userEvent.type(screen.getByLabelText("Dashboard name"), "x");
    await userEvent.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent('widget 1 ("Current power"): assets: at most 20 assets');
    expect(saveButton()).toBeEnabled();
    expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall Ax");
  });

  it("shows the list form of a 422 as readably as the string form", async () => {
    open("operator", "/dashboards/3", {
      "PUT /api/dashboards/3": {
        status: 422,
        body: { detail: [{ type: "string_too_long", loc: ["body", "widgets", 0, "title"], msg: "String should have at most 100 characters" }] },
      },
    });
    await startEditing();
    await userEvent.type(screen.getByLabelText("Dashboard name"), "x");
    await userEvent.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("widgets.0.title: String should have at most 100 characters");
    expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall Ax");
  });
});

/** Click the "Dashboards" breadcrumb: an in-app link, as a user would leave the editor. */
const leaveByLink = () => userEvent.click(screen.getByRole("link", { name: "Dashboards" }));

describe("leaving with unsaved changes", () => {
  it("asks before in-app navigation: Keep editing stays with the edits, Leave discards them", async () => {
    const { router } = open("operator");
    await startEditing();
    await userEvent.type(screen.getByLabelText("Dashboard name"), " edited");
    await leaveByLink();
    const prompt = await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    expect(router.state.location.pathname).toBe("/dashboards/3");
    await userEvent.click(within(prompt).getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall A edited");
    await leaveByLink();
    await userEvent.click(await screen.findByRole("button", { name: "Leave and discard changes" }));
    expect(await screen.findByText("dashboards page")).toBeInTheDocument();
  });

  it("treats Escape in the prompt as Keep editing", async () => {
    const { router } = open("operator");
    await startEditing();
    await userEvent.type(screen.getByLabelText("Dashboard name"), "x");
    await leaveByLink();
    await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/dashboards/3");
  });

  it("lets a clean editor leave without asking", async () => {
    open("operator");
    await startEditing();
    await leaveByLink();
    expect(await screen.findByText("dashboards page")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("warns on page close only while there are unsaved changes", async () => {
    open("operator");
    await startEditing();
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    await userEvent.type(screen.getByLabelText("Dashboard name"), "x");
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});
