import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultSize, nextPosition, toDrafts } from "../lib/layout";
import { assetList, authed, config, dashboard, widget, widgetDataRoute } from "../test/dashboardFixtures";
import { FakeEventSource } from "../test/fakeEventSource";
import { mockFetch, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { model, point, source } from "../test/graphFixtures";
import { renderWithDataRouter } from "../test/render";
import { accountKnown, SignedIn } from "../test/signedIn";
import { spyToasts } from "../test/toasts";
import { userFor } from "../test/users";
import type { ToastApi } from "../components/Toasts";
import type { PermissionId } from "../lib/permissions";
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

function open(role: string, entry: string | { pathname: string; state?: unknown } = "/dashboards/3", over: Routes = {}, toasts?: ToastApi, hold?: (method: string, path: string) => boolean) {
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
  const held = hold ? holdFetch(hold) : { release: () => {} };
  const view = renderWithDataRouter(<><DashboardPage /><SignedIn /></>, { route: entry, path: "/dashboards/:id", toasts });
  return { calls, ...view, release: held.release };
}
const add = () => screen.getByRole("button", { name: "Add widget" });
const saveButton = () => screen.getByRole("button", { name: "Save" });
/** The browser coming back online: React Query refetches the stale queries (refetchOnReconnect), the dashboard among them. */
const reconnect = () => act(() => {
  window.dispatchEvent(new Event("offline"));
  window.dispatchEvent(new Event("online"));
});
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

  /** A role called "custom" that holds `permissions`. */
  const custom = (permissions: PermissionId[]): Routes => ({ "GET /api/me": { body: userFor("custom", { permissions }) } });

  it("never shows edit mode to a role with dashboards.view alone, even when asked for through the router state", async () => {
    open("custom", { pathname: "/dashboards/3", state: { edit: true } }, custom(["dashboards.view"]));
    expect(await screen.findByRole("heading", { name: "Hall A" })).toBeInTheDocument();
    await accountKnown();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Dashboard name")).not.toBeInTheDocument();
  });

  it("shows the Edit button to a role with dashboards.edit, and its Save sends the dashboard", async () => {
    const { calls } = open("custom", "/dashboards/3", custom(["dashboards.view", "dashboards.edit", "assets.view"]));
    await startEditing();
    await userEvent.clear(screen.getByLabelText("Dashboard name"));
    await userEvent.type(screen.getByLabelText("Dashboard name"), "Hall Z");
    await userEvent.click(saveButton());
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
  });

  it("dashboards.default alone is not the right to edit: no Edit button", async () => {
    open("custom", "/dashboards/3", custom(["dashboards.view", "dashboards.default"]));
    expect(await screen.findByRole("heading", { name: "Hall A" })).toBeInTheDocument();
    await accountKnown();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
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
    const toasts = spyToasts();
    const { calls } = open("operator", "/dashboards/3", {}, toasts.api);
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
    expect(toasts.calls).toEqual([]); // leaving without saving says nothing
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
    const toasts = spyToasts();
    const { calls } = open("operator", "/dashboards/3", {}, toasts.api);
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
    // Leaving edit mode is not an obvious "saved" (R16), so one toast says it: after the request, once, and only for a save.
    expect(toasts.calls).toEqual([{ kind: "success", text: "Dashboard saved" }]);
  });

  it("offers a metric widget only the assets mapped to that metric, taken from the discovery graph", async () => {
    open("operator");
    await startEditing();
    await userEvent.click(add());
    expect(screen.getAllByRole("checkbox").map((box) => box.parentElement?.textContent)).toEqual(["LV Panel 1", "LV Panel 2"]);
    await userEvent.selectOptions(screen.getByLabelText("Metric"), "voltage_v");
    expect(screen.getAllByRole("checkbox").map((box) => box.parentElement?.textContent)).toEqual(["MV2"]);
    await userEvent.selectOptions(screen.getByLabelText("Source"), "energy");
    // (the comparison box is a checkbox too: count the picker's)
    expect(within(screen.getByRole("group", { name: "Assets" })).getAllByRole("checkbox")).toHaveLength(4);
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

  it("dresses a card in edit mode with a grab header and two icon buttons, and no Details or CSV button", async () => {
    open("operator");
    await startEditing();
    const card = within(screen.getByRole("region", { name: "Current power" }));
    const edit = card.getByRole("button", { name: "Edit Current power" });
    const del = card.getByRole("button", { name: "Delete Current power" });
    expect(edit).toHaveClass("icon-btn");
    expect(edit).toHaveAttribute("title", "Edit Current power");
    expect(edit.querySelector("svg")).not.toBeNull(); // the pencil: no word on the button any more
    expect(edit).toHaveTextContent("");
    expect(del).toHaveClass("icon-btn", "trash-btn");
    expect(del).toHaveTextContent("");
    expect(edit.parentElement).toHaveClass("widget-actions"); // the grid's drag exclusion (`cancel`) names this class
    expect(del.parentElement).toBe(edit.parentElement);
    const head = screen.getByRole("region", { name: "Current power" }).querySelector("header")!;
    expect(head).toHaveClass("widget-head", "widget-drag-handle");
    expect(head.querySelector(".widget-grip")).not.toBeNull();
    expect(card.queryByRole("button", { name: /^Details for/ })).not.toBeInTheDocument();
    expect(card.queryByRole("button", { name: /^Download CSV/ })).not.toBeInTheDocument();
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
    // The stand-in drops the widget at y 7 with nothing above it, so closing up puts it at the top (its x 4 + w 9 is the stand-in's own doing).
    expect((putBody(calls) as { widgets: unknown[] }).widgets).toEqual([{ type: "stat", title: "Current power", config: now.config, x: 4, y: 0, w: 9, h: 5 }]);
  });

  describe("a text widget", () => {
    const widgetDataPosts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/widget-data");
    /** The types the data requests asked about, once each: the stat card is the only data widget here, so a request of any other type would be a text widget's. */
    const askedAbout = (calls: Call[]) => [...new Set(widgetDataPosts(calls).map((c) => (c.body as { type: string }).type))];
    /** Add a text widget of `style` through the dialog (the Type select, then Style and Text), and press Save widget. */
    async function addText(style: "heading" | "paragraph" | "divider", words: string) {
      await userEvent.click(add());
      await userEvent.selectOptions(screen.getByLabelText("Type"), "text");
      await userEvent.selectOptions(screen.getByLabelText("Style"), style);
      if (style !== "divider") {
        await userEvent.click(screen.getByLabelText("Text"));
        await userEvent.paste(words);
      }
      await userEvent.click(screen.getByRole("button", { name: "Save widget" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    }

    it("adds a heading through the dialog with the default size, names its Edit and Delete buttons by the title, and saves type text", async () => {
      const { calls } = open("operator");
      await startEditing();
      await waitFor(() => expect(widgetDataPosts(calls).length).toBeGreaterThan(0)); // the stat card's own requests (the viewer's, then the editor's)
      await addText("heading", "Cooling plant");
      const card = within(await screen.findByRole("region", { name: "Cooling plant" }));
      expect(card.getByRole("button", { name: "Edit Cooling plant" })).toBeInTheDocument();
      expect(card.getByRole("button", { name: "Delete Cooling plant" })).toBeInTheDocument();
      expect(card.getByRole("heading", { level: 2, name: "Cooling plant" })).toHaveClass("widget-title"); // the title; the heading text is a styled div
      await userEvent.click(saveButton());
      const size = defaultSize("text", "heading");
      expect(size).toEqual({ w: 6, h: 2 });
      expect((putBody(calls) as { widgets: unknown[] }).widgets).toEqual([
        { type: "stat", title: "Current power", config: now.config, x: 0, y: 0, w: 3, h: 2 },
        { type: "text", title: "Cooling plant", config: { style: "heading", text: "Cooling plant" }, ...nextPosition(toDrafts(base.widgets), size), ...size },
      ]);
      expect(askedAbout(calls)).toEqual(["stat"]); // adding and saving a text widget asked for no data
    });

    it("adds a divider 12 wide and 1 high, with no text", async () => {
      const { calls } = open("operator");
      await startEditing();
      await addText("divider", "");
      expect(await screen.findByRole("region", { name: "Divider" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Edit Divider" })).toBeInTheDocument();
      await userEvent.click(saveButton());
      const size = defaultSize("text", "divider");
      expect(size).toEqual({ w: 12, h: 1 });
      expect((putBody(calls) as { widgets: unknown[] }).widgets[1]).toEqual({
        type: "text", title: "Divider", config: { style: "divider", text: "" }, ...nextPosition(toDrafts(base.widgets), size), ...size,
      });
    });

    it("numbers a second automatic title, edits a text widget in place, and deletes it", async () => {
      const { calls } = open("operator");
      await startEditing();
      await addText("divider", "");
      await addText("divider", "");
      expect(screen.getByRole("button", { name: "Edit Divider" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Edit Divider 2" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Edit Divider 2" })); // opening it must not offer its own title as taken
      expect(screen.getByRole("dialog", { name: "Edit widget" })).toBeInTheDocument();
      expect(screen.getByLabelText("Title")).toHaveValue("Divider 2");
      await userEvent.selectOptions(screen.getByLabelText("Style"), "paragraph");
      expect(screen.getByLabelText("Title")).toHaveValue("Divider 2"); // an existing title is never prefilled
      await userEvent.click(screen.getByLabelText("Text"));
      await userEvent.paste("Some words");
      await userEvent.click(screen.getByRole("button", { name: "Save widget" }));
      await userEvent.click(screen.getByRole("button", { name: "Delete Divider" }));
      expect(screen.queryByRole("region", { name: "Divider" })).not.toBeInTheDocument();
      await userEvent.click(saveButton());
      const widgets = (putBody(calls) as { widgets: { type: string; title: string; config: unknown }[] }).widgets;
      expect(widgets.map((w) => w.title)).toEqual(["Current power", "Divider 2"]);
      expect(widgets[1]).toMatchObject({ type: "text", config: { style: "paragraph", text: "Some words" } });
    });

    it("sends a request for the stat card only: the text cards ask for no data", async () => {
      const { calls } = open("operator");
      await startEditing();
      await addText("paragraph", "Line one\nline two");
      await addText("heading", "Plant");
      await screen.findByRole("region", { name: "Plant" });
      await new Promise((resolve) => setTimeout(resolve, 350)); // past the data preview's delay
      expect(askedAbout(calls)).toEqual(["stat"]);
    });
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

describe("undo after a delete", () => {
  const three = dashboard({
    widgets: [
      widget(1, "stat", { title: "A", config: config({ aggregation: "last" }), x: 0, y: 0, w: 3, h: 2 }),
      widget(2, "stat", { title: "B", config: config({ aggregation: "last" }), x: 3, y: 0, w: 3, h: 2 }),
      widget(3, "stat", { title: "C", config: config({ aggregation: "last" }), x: 6, y: 0, w: 3, h: 2 }),
    ],
  });
  const openThree = async () => {
    open("operator", "/dashboards/3", { "GET /api/dashboards/3": { body: three } });
    await startEditing();
  };

  it("offers Undo after a delete and puts the widget back where it was", async () => {
    await openThree();
    // Each loading widget draws its own skeleton region (role "status"): wait for those to go, so the Undo notice is the one status left.
    await waitFor(() => expect(document.querySelector(".widget-sk")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Delete B" }));
    expect(screen.queryByRole("button", { name: "Edit B" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Removed “B”");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Edit B" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    // the editor is clean again: Save is disabled because nothing differs from what was loaded
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("only the last delete can be undone", async () => {
    await openThree();
    await userEvent.click(screen.getByRole("button", { name: "Delete A" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete B" }));
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Edit B" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit A" })).not.toBeInTheDocument();
  });

  it("deleting the only widget works and can be undone", async () => {
    open("operator"); // the file's own dashboard: one widget, "Current power"
    await startEditing();
    await userEvent.click(screen.getByRole("button", { name: "Delete Current power" }));
    expect(screen.getByText("No widgets yet. Use Add widget.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Edit Current power" })).toBeInTheDocument();
  });

  it("adding a widget retires the Undo offer", async () => {
    await openThree();
    await userEvent.click(screen.getByRole("button", { name: "Delete C" }));
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    // add a widget through the dialog, with the steps of 'adds a widget, saves the exact body'
    await userEvent.click(add());
    await userEvent.type(screen.getByLabelText("Title"), "Hall power");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Save widget" }));
    expect(await screen.findByRole("region", { name: "Hall power" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("dragging another widget (into the gap) retires the Undo offer, so Undo can never stack two widgets", async () => {
    await openThree();
    await userEvent.click(screen.getByRole("button", { name: "Delete B" }));
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("move-1")); // the stand-in plays a finished drag of widget A
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });
});

describe("before the mappings are known", () => {
  /** The pencil waits with aria-disabled, never a native disabled (it stays in the Tab order and keeps focus), and a click on it opens nothing. */
  async function expectEditWaits() {
    const pencil = screen.getByRole("button", { name: "Edit Current power" });
    expect(pencil).toHaveAttribute("aria-disabled", "true");
    expect(pencil).not.toBeDisabled();
    await userEvent.click(pencil);
    expect(screen.queryByRole("dialog", { name: "Edit widget" })).not.toBeInTheDocument();
    expect(pencil, "it keeps the focus the click gave it").toHaveFocus();
  }

  it("keeps Add widget and every Edit button off, and says why, when the metric mappings cannot be loaded", async () => {
    open("operator", "/dashboards/3", { "GET /api/discovery/graph": { status: 500, body: { detail: "graph unavailable" } } });
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(await screen.findByText("Could not load the metric mappings: graph unavailable")).toBeInTheDocument();
    expect(add()).toBeDisabled();
    await expectEditWaits();
    expect(screen.getByRole("button", { name: "Delete Current power" })).toBeEnabled();
  });

  it("keeps Add widget off, and says why, when the assets cannot be loaded", async () => {
    open("operator", "/dashboards/3", { "GET /api/assets": { status: 500, body: { detail: "assets unavailable" } } });
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(await screen.findByText("Could not load the assets: assets unavailable")).toBeInTheDocument();
    expect(add()).toBeDisabled();
    await expectEditWaits();
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
    // until the user chooses Reload, their edit is still on screen (neither theirs nor Sam's version is lost silently)
    expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall A mine");
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall A (Sam)"));
    expect(screen.queryByText("This dashboard was changed by someone else")).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled(); // reloaded: nothing to save, and nothing was sent behind the user's back
    expect(puts(calls)).toHaveLength(1);
  });

  it("shows the server's message, not the reload banner, when the name is taken", async () => {
    const toasts = spyToasts();
    open("operator", "/dashboards/3", { "PUT /api/dashboards/3": { status: 409, body: { detail: "a dashboard with this name already exists" } } }, toasts.api);
    await startEditing();
    await userEvent.type(screen.getByLabelText("Dashboard name"), "2");
    await userEvent.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall A2");
    expect(saveButton()).toBeEnabled(); // not a conflict: the user can pick another name and save again
    expect(toasts.calls).toEqual([]); // a refused save keeps its error line and raises no toast
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

describe("when the page cannot refresh its data", () => {
  it("keeps the editor and the unsaved edits when a background refetch of the dashboard fails, and says so", async () => {
    let reads = 0;
    open("operator", "/dashboards/3", {
      "GET /api/dashboards/3": () => (reads++ === 0 ? { body: base } : { status: 500, body: { detail: "dashboard unavailable" } }),
    });
    await startEditing();
    await userEvent.type(screen.getByLabelText("Dashboard name"), " edited");
    await reconnect();
    expect(await screen.findByText("Could not refresh this page: dashboard unavailable")).toBeInTheDocument();
    expect(reads).toBeGreaterThan(1); // the refetch really happened and failed
    expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall A edited");
    expect(screen.getByRole("region", { name: "Current power" })).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it("keeps the editor when Reload fails, and a second Reload can still succeed", async () => {
    let reads = 0;
    const newer = dashboard({ name: "Hall A (Sam)", updated_at: "2026-10-08T06:30:00+00:00", widgets: [now] });
    open("operator", "/dashboards/3", {
      "GET /api/dashboards/3": () => {
        const n = reads++;
        return n === 0 ? { body: base } : n === 1 ? { status: 500, body: { detail: "api restarting" } } : { body: newer };
      },
      "PUT /api/dashboards/3": { status: 409, body: { detail: "dashboard changed since you loaded it" } },
    });
    await startEditing();
    await userEvent.type(screen.getByLabelText("Dashboard name"), " mine");
    await userEvent.click(saveButton());
    await userEvent.click(await screen.findByRole("button", { name: "Reload" }));
    expect((await screen.findAllByText(/api restarting/)).length).toBeGreaterThan(0);
    expect(screen.getByText("This dashboard was changed by someone else")).toBeInTheDocument();
    expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall A mine"); // the draft is still there
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall A (Sam)"));
    expect(screen.queryByText(/Could not refresh this page/)).not.toBeInTheDocument();
  });
});

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

  it("puts the prompt on top of an open widget dialog, with the focus in it, and returns to that dialog on Keep editing", async () => {
    const { router } = open("operator");
    await startEditing();
    await userEvent.type(screen.getByLabelText("Dashboard name"), " edited");
    await userEvent.click(add());
    const widgetDialog = await screen.findByRole("dialog", { name: "Add widget" });
    const titleInput = within(widgetDialog).getByLabelText("Title");
    await userEvent.type(titleInput, "Draft");
    expect(titleInput).toHaveFocus();
    // an in-app navigation (here the breadcrumb link) that the blocker catches while the widget dialog is open
    await leaveByLink();
    const prompt = await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    expect(router.state.location.pathname).toBe("/dashboards/3");
    // both backdrops share a z-index, so the one later in the document paints on top: it must be the prompt's
    const backdrops = [...document.querySelectorAll(".dialog-backdrop")];
    expect(backdrops).toHaveLength(2);
    expect(backdrops[0]).toContainElement(widgetDialog);
    expect(backdrops[1]).toContainElement(prompt);
    // and the prompt, not the widget dialog under it, holds the focus
    expect(prompt).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).toHaveTextContent("Keep editing");
    await userEvent.click(titleInput);
    expect(prompt).toContainElement(document.activeElement as HTMLElement);
    await userEvent.click(within(prompt).getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Add widget" })).toBe(widgetDialog);
    expect(titleInput).toHaveValue("Draft");
    expect(widgetDialog).toContainElement(document.activeElement as HTMLElement); // focus is back in the dialog it left
    await userEvent.type(titleInput, "!");
    expect(titleInput).toHaveValue("Draft!"); // typing works again
    // a second attempt: Leave drops the edits and goes
    await leaveByLink();
    await userEvent.click(await screen.findByRole("button", { name: "Leave and discard changes" }));
    expect(await screen.findByText("dashboards page")).toBeInTheDocument();
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

describe("closing up (vertical compaction)", () => {
  const stat = (id: number, title: string, x: number, y: number, w = 3, h = 2) =>
    widget(id, "stat", { title, config: config({ aggregation: "last" }), x, y, w, h });
  const withWidgets = (...widgets: ReturnType<typeof stat>[]) => ({ "GET /api/dashboards/3": { body: dashboard({ widgets }) } });
  const bodyPositions = (calls: Call[]) =>
    (putBody(calls) as { widgets: { title: string; x: number; y: number }[] }).widgets.map(({ title, x, y }) => ({ title, x, y }));

  it("opens a dashboard that was saved with a gap as it looks, and it is not an unsaved change", async () => {
    const { calls } = open("operator", "/dashboards/3", withWidgets(stat(1, "A", 0, 0), stat(2, "B", 0, 5)));
    await startEditing();
    expect(saveButton()).toBeDisabled();
    expect(screen.queryByText("Not saved yet")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(puts(calls)).toHaveLength(0);
  });

  it("saves the closed-up positions with the first real change", async () => {
    const { calls } = open("operator", "/dashboards/3", withWidgets(stat(1, "A", 0, 0), stat(2, "B", 0, 5)));
    await startEditing();
    await userEvent.type(screen.getByLabelText("Dashboard name"), "2");
    await userEvent.click(saveButton());
    expect(bodyPositions(calls)).toEqual([{ title: "A", x: 0, y: 0 }, { title: "B", x: 0, y: 2 }]);
  });

  it("closes the gap a delete leaves: the next widget moves up to the top", async () => {
    const { calls } = open("operator", "/dashboards/3", withWidgets(stat(1, "A", 0, 0), stat(2, "B", 0, 2)));
    await startEditing();
    await userEvent.click(screen.getByRole("button", { name: "Delete A" }));
    await userEvent.click(saveButton());
    expect(bodyPositions(calls)).toEqual([{ title: "B", x: 0, y: 0 }]);
  });

  it.each([
    ["the first of two stacked ones", [stat(1, "A", 0, 0), stat(2, "B", 0, 2)], "A"],
    ["the left of two side-by-side widgets", [stat(1, "A", 0, 0, 6), stat(2, "B", 6, 0, 6)], "A"],
    ["the middle of three stacked ones", [stat(1, "A", 0, 0), stat(2, "B", 0, 2), stat(3, "C", 0, 4)], "B"],
    ["a widget with another at a different x below it", [stat(1, "A", 0, 0), stat(2, "B", 2, 2, 6), stat(3, "C", 0, 4, 4)], "B"],
  ])("Undo restores exactly where everything was after deleting %s", async (_name, widgets, victim) => {
    open("operator", "/dashboards/3", withWidgets(...widgets));
    await startEditing();
    await userEvent.click(screen.getByRole("button", { name: `Delete ${victim}` }));
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: `Edit ${victim}` })).toBeInTheDocument();
    expect(saveButton()).toBeDisabled(); // every position equals what was loaded
  });

  it("Undo does not swap two widgets when a drag made the array order differ from the reading order", async () => {
    const { calls } = open("operator", "/dashboards/3", withWidgets(stat(1, "A", 4, 0), stat(2, "B", 4, 2)));
    await startEditing();
    await userEvent.click(screen.getByTestId("move-1")); // A is dropped at (4, 7), below B: B closes up to the top, A sits under it
    await userEvent.click(screen.getByRole("button", { name: "Delete B" }));
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await userEvent.click(saveButton());
    expect(bodyPositions(calls)).toEqual([{ title: "A", x: 4, y: 2 }, { title: "B", x: 4, y: 0 }]);
  });

  it("closes a new widget up into free space: the saved rectangles never overlap", async () => {
    const { calls } = open("operator", "/dashboards/3", withWidgets(stat(1, "A", 0, 0), stat(2, "B", 6, 0, 6, 4)));
    await startEditing();
    await userEvent.click(add());
    await userEvent.type(screen.getByLabelText("Title"), "Hall power");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Save widget" }));
    await userEvent.click(saveButton());
    const saved = (putBody(calls) as { widgets: { title: string; x: number; y: number; w: number; h: number }[] }).widgets;
    expect(saved.find((w) => w.title === "Hall power")).toMatchObject({ x: 0, y: 2 }); // not below B (y 4): under A, which is only 2 high, in the free space
    const overlap = (a: (typeof saved)[number], b: (typeof saved)[number]) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    expect(saved.some((a, i) => saved.slice(i + 1).some((b) => overlap(a, b)))).toBe(false);
  });
});

describe("a focus asset in edit mode", () => {
  /** The assets are one Site over MV2 over two panels: with ONE top-level asset the trail leaves Site out. */
  const line = (name: string) => `Widgets that follow the focus show ${name}.`;
  const trail = () => screen.getByRole("navigation", { name: "Breadcrumb" });
  const crumbs = () => within(trail()).getAllByRole("listitem").map((li) => (li.textContent ?? "").replace(/^\//, ""));
  const where = (router: { state: { location: { pathname: string; search: string } } }) => router.state.location.pathname + router.state.location.search;

  it("says nothing about a focus when there is none", async () => {
    open("operator", "/dashboards/3");
    await startEditing();
    expect(screen.queryByText(/Widgets that follow the focus/)).not.toBeInTheDocument();
  });

  it("with a focus: the line names the asset, the header has no Focus button and no Open page link, and the trail extends", async () => {
    open("operator", "/dashboards/3?asset=5");
    await startEditing();
    const text = await screen.findByText(line("LV Panel 1"));
    expect(text.tagName).toBe("P");
    expect(text).toHaveClass("muted");
    expect(text).not.toHaveAttribute("role");
    expect(text.closest(".dash-head")).toBeNull(); // below the header
    expect(screen.queryByRole("button", { name: "Focus" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Open .* page$/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Dashboard name")).toBeInTheDocument();
    await waitFor(() => expect(crumbs()).toEqual(["Dashboards", "Hall A", "MV2", "LV Panel 1"]));
  });

  it("says Asset #id while the list is not here, then the name, in the same line", async () => {
    const page = open("operator", "/dashboards/3?asset=5", {}, undefined, (_method, path) => path === "/api/assets");
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const text = await screen.findByText(line("Asset #5"));
    page.release();
    expect(await screen.findByText(line("LV Panel 1"))).toBe(text);
  });

  it("a crumb that only changes ?asset= keeps the editor and the unsaved edits, and the leave prompt does not appear", async () => {
    const { router } = open("operator", "/dashboards/3?asset=5");
    await startEditing();
    await waitFor(() => expect(crumbs()).toEqual(["Dashboards", "Hall A", "MV2", "LV Panel 1"]));
    const name = screen.getByLabelText("Dashboard name");
    await userEvent.type(name, "x");
    expect(screen.getByText("Not saved yet")).toBeInTheDocument();

    await userEvent.click(within(trail()).getByRole("link", { name: "MV2" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(where(router)).toBe("/dashboards/3?asset=2");
    expect(router.state.historyAction).toBe("PUSH");
    expect(screen.getByLabelText("Dashboard name")).toBe(name); // the same input: the editor was not remounted
    expect(name).toHaveValue("Hall Ax");
    expect(await screen.findByText(line("MV2"))).toBeInTheDocument();
    expect(crumbs()).toEqual(["Dashboards", "Hall A", "MV2"]);

    await userEvent.click(within(trail()).getByRole("link", { name: "Hall A" })); // the dashboard's name: the whole site
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(where(router)).toBe("/dashboards/3");
    expect(name).toHaveValue("Hall Ax");
    expect(screen.queryByText(/Widgets that follow the focus/)).not.toBeInTheDocument();

    await act(async () => { await router.navigate(-1); }); // Back works in edit mode too
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(where(router)).toBe("/dashboards/3?asset=2");
    expect(name).toHaveValue("Hall Ax");

    await userEvent.click(within(trail()).getByRole("link", { name: "Dashboards" })); // another path still asks
    expect(await screen.findByRole("alertdialog", { name: "Unsaved changes" })).toBeInTheDocument();
    expect(where(router)).toBe("/dashboards/3?asset=2");
  });

  it("leaving edit mode with a focus keeps it: the viewer has the Focus button and the Open page link", async () => {
    const { router } = open("operator", "/dashboards/3?asset=5");
    await startEditing();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Focus" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Open LV Panel 1 page" })).toBeInTheDocument();
    expect(where(router)).toBe("/dashboards/3?asset=5");
  });
});
