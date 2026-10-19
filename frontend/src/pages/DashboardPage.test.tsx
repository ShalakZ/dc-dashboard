import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useDefaultDashboard } from "../api/queries";
import type { Asset, DataWidgetType } from "../api/types";
import { downloadCsv } from "../lib/download";
import { progress } from "../lib/progress";
import { authed, config, dashboard, dataFor, textWidget, valueRow, valuesData, widget, widgetDataRoute } from "../test/dashboardFixtures";
import { mockFetch, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithDataRouter, renderWithProviders } from "../test/render";
import { userFor } from "../test/users";
import { DashboardPage } from "./DashboardPage";

// What the chart did: how often each kind was rendered, and which distinct option objects it was handed. The real
// echarts-for-react calls setOption(option, { notMerge: true }) whenever the option is not deep-equal to the last one
// (functions only by reference), which resets a legend selection and tears down an open tooltip.
const chart = vi.hoisted(() => ({ renders: {} as Record<string, number>, options: {} as Record<string, Set<object>> }));
vi.mock("echarts-for-react", () => ({
  default: (props: { option: { series?: { type?: string }[] } }) => {
    const kind = props.option.series?.[0]?.type ?? "?";
    chart.renders[kind] = (chart.renders[kind] ?? 0) + 1;
    (chart.options[kind] ??= new Set()).add(props.option);
    return <pre data-testid="chart" data-kind={kind}>{JSON.stringify(props.option)}</pre>;
  },
}));
vi.mock("../lib/download", () => ({ downloadCsv: vi.fn() }));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CLOSED = 2;
  static get open() { return FakeEventSource.instances.filter((s) => !s.closed); }
  readyState = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; this.readyState = 2; }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent); }
}

beforeEach(() => {
  chart.renders = {};
  chart.options = {};
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.mocked(downloadCsv).mockReset();
  vi.mocked(downloadCsv).mockResolvedValue(undefined);
});

const trend = widget(1, "timeseries", { title: "Power trend", x: 0, y: 0, w: 6, h: 4 });
const energy = widget(2, "bar", { title: "Energy by asset", config: config({ source: "energy", metric: null, aggregation: "sum" }), x: 6, y: 0, w: 6, h: 4 });
const current = widget(3, "stat", { title: "Current power", config: config({ aggregation: "last" }), x: 0, y: 4, w: 3, h: 2 });
const load = widget(4, "gauge", { title: "Load", config: config({ aggregation: "last", min: 0, max: 200 }), x: 3, y: 4, w: 3, h: 3 });
const assets = widget(5, "table", { title: "Assets", config: config({ assets: [5, 6], range: "30d" }), x: 6, y: 4, w: 6, h: 3 });
// Deliberately not in reading order.
const widgets = [assets, current, trend, load, energy];

/** `hold` keeps back the requests it matches until `release()` (installed before the page mounts, so none gets through). */
function open(role: string = "viewer", over: Routes = {}, hold?: (method: string, path: string) => boolean) {
  const calls = mockFetch({
    ...authed(role),
    "GET /api/dashboards/3": { body: dashboard({ widgets }) },
    "POST /api/widget-data": widgetDataRoute,
    ...over,
  });
  const held = hold ? holdFetch(hold) : { release: () => {} };
  renderWithProviders(<DashboardPage />, { route: "/dashboards/3", path: "/dashboards/:id" });
  return Object.assign(calls, { release: held.release });
}
const region = (name: string) => screen.findByRole("region", { name });
const dataRequests = (calls: { method: string; path: string; body: unknown }[]) =>
  calls.filter((c) => c.method === "POST" && c.path === "/api/widget-data").map((c) => c.body as { type: string; range: string });

describe("DashboardPage (view)", () => {
  it("renders one widget of each type, in reading order", async () => {
    open();
    await region("Power trend");
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Power trend", "Energy by asset", "Current power", "Load", "Assets"]);
    await waitFor(() => expect(screen.getAllByTestId("chart")).toHaveLength(2)); // the gauge is an SVG arc now, not an ECharts canvas
    expect(screen.getAllByTestId("chart").map((c) => c.getAttribute("data-kind")).sort()).toEqual(["bar", "line"]);
    const meter = await within(await region("Load")).findByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "10.5");
    expect(meter).toHaveAttribute("aria-valuemax", "200");
    expect(await within(await region("Current power")).findByText("10.50")).toBeInTheDocument();
    const table = within(await region("Assets"));
    expect(await table.findByText("LV Panel 2")).toBeInTheDocument();
    expect(table.getByText("~4.25")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hall A" })).toBeInTheDocument();
  });

  it("draws text widgets beside a data widget with exactly one data request, and the stream is the data widget's alone", async () => {
    const mixed = [
      textWidget(10, "heading", "Cooling plant", { title: "Plant heading", x: 0, y: 0, w: 12, h: 1 }),
      current,
      textWidget(11, "paragraph", "Chillers 1 and 2\nrun in duty and standby.", { title: "Plant notes", x: 3, y: 1, w: 9, h: 2 }),
      textWidget(12, "divider", "", { title: "Divider", x: 0, y: 3, w: 12, h: 1 }),
    ];
    const calls = open("viewer", { "GET /api/dashboards/3": { body: dashboard({ widgets: mixed }) } });
    await within(await region("Current power")).findByText("10.50");
    // A text heading is an h2 of its own, like the data card's title; the paragraph is a named region and the divider a separator with no name.
    expect(screen.getAllByRole("heading").map((h) => `${h.tagName.toLowerCase()}:${h.textContent}`)).toEqual(["h1:Hall A", "h2:Cooling plant", "h2:Current power"]);
    expect(screen.getByRole("region", { name: "Plant notes" })).toHaveTextContent(/Chillers 1 and 2\s*run in duty and standby\./);
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label")).sort()).toEqual(["Current power", "Plant notes"]); // the heading and the divider are no regions
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Details for (Plant|Divider)/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download CSV for (Plant|Divider)/ })).not.toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.open).toHaveLength(1)); // the stat's stream
    expect(dataRequests(calls).map((r) => r.type)).toEqual(["stat"]); // exactly one request: the text widgets asked for nothing
  });

  it("shows the trail Dashboards / Hall A above the page: the list is a link, the dashboard is the current page", async () => {
    open();
    await region("Power trend");
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).getByRole("link", { name: "Dashboards" })).toHaveAttribute("href", "/dashboards");
    expect(within(nav).getByText("Hall A")).toHaveAttribute("aria-current", "page");
    expect(within(nav).getAllByRole("link")).toHaveLength(1);
  });

  it("draws a dashboard saved with a gap closed up, and sends no save on a view-only visit", async () => {
    const gap = [
      widget(1, "stat", { title: "Upper", config: config({ aggregation: "last" }), x: 0, y: 0, w: 3, h: 2 }),
      widget(2, "stat", { title: "Lower", config: config({ aggregation: "last" }), x: 0, y: 5, w: 3, h: 2 }),
    ];
    const calls = open("viewer", { "GET /api/dashboards/3": { body: dashboard({ widgets: gap }) } });
    const lower = (await region("Lower")).closest<HTMLElement>(".dash-cell")!;
    expect(lower.style.gridRow).toBe("3 / span 2"); // directly under Upper (rows 1-2), not at row 6
    await waitFor(() => expect(dataRequests(calls).length).toBeGreaterThan(0)); // the widgets have loaded
    // Opening a dashboard changes nothing on the server: the only non-GET request is the widget data query, a read.
    expect(calls.filter((c) => c.method !== "GET" && c.path !== "/api/widget-data")).toEqual([]);
  });

  it("changes the range for widgets that inherit it, keeps overrides, and saves nothing", async () => {
    const calls = open();
    await waitFor(() => expect(dataRequests(calls)).toHaveLength(5));
    expect(dataRequests(calls).map((r) => r.range).sort()).toEqual(["24h", "24h", "24h", "24h", "30d"]);
    await userEvent.selectOptions(screen.getByLabelText("Dashboard range"), "7d");
    await waitFor(() => expect(dataRequests(calls).filter((r) => r.range === "7d")).toHaveLength(4));
    expect(dataRequests(calls).filter((r) => r.range === "7d").map((r) => r.type).sort()).toEqual(["bar", "gauge", "stat", "timeseries"]);
    expect(dataRequests(calls).filter((r) => r.type === "table")).toHaveLength(1); // its own 30d override is not refetched
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(screen.getByText(/this visit only/)).toBeInTheDocument();
  });

  it("lets one stream override the live widgets' figures, and nothing else", async () => {
    open();
    const stat = within(await region("Current power"));
    expect(await stat.findByText("10.50")).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.open).toHaveLength(1)); // stat and gauge share ONE EventSource
    expect(FakeEventSource.open[0].url).toBe("/api/stream");
    act(() => FakeEventSource.open[0].onopen?.());
    expect(screen.getByText("live")).toBeInTheDocument();
    act(() => FakeEventSource.open[0].emit([[7, 1_760_000_000, 11.25, 0], [8, 1_760_000_000, 99, 0], [99, 1_760_000_000, 1, 0]]));
    expect(stat.getByText("11.25")).toBeInTheDocument();
    expect(stat.queryByText("10.50")).not.toBeInTheDocument();
    const load = within(await region("Load")); // the gauge sits on point 7 here, so it follows the stream like the stat
    await waitFor(() => expect(load.getByRole("meter")).toHaveAttribute("aria-valuenow", "11.25"));
    expect(load.getByText("11.25")).toBeInTheDocument();
    const table = within(await region("Assets"));
    expect(await table.findByText("10.50")).toBeInTheDocument(); // a table is not live
    expect(table.queryByText("99.00")).not.toBeInTheDocument();
    act(() => FakeEventSource.open[0].emit([[7, 1_760_000_001, 5, 1]]));
    expect(stat.getByText("no data")).toBeInTheDocument(); // bad quality: no data (muted), not the old figure
    expect(stat.queryByText("—")).not.toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("goes back to the fetched figures when the stream drops, and to the stream when it is back", async () => {
    open();
    const stat = within(await region("Current power"));
    await stat.findByText("10.50");
    await waitFor(() => expect(FakeEventSource.open).toHaveLength(1));
    act(() => FakeEventSource.open[0].onopen?.());
    act(() => FakeEventSource.open[0].emit([[7, 1_760_000_000, 11.25, 0]]));
    expect(stat.getByText("11.25")).toBeInTheDocument();
    act(() => FakeEventSource.open[0].onerror?.()); // the browser is reconnecting by itself (readyState 0)
    expect(stat.getByText("10.50")).toBeInTheDocument();
    expect(screen.queryByText("live")).not.toBeInTheDocument();
    act(() => FakeEventSource.open[0].onopen?.());
    expect(stat.getByText("11.25")).toBeInTheDocument();
  });

  it("opens ONE stream for the union of the live widgets, even though they finish loading one after the other", async () => {
    const stats = [11, 12, 13].map((id, i) => widget(id, "stat", { title: `Stat ${id}`, config: config({ assets: [id], aggregation: "last" }), x: i * 3, y: 0, w: 3, h: 2 }));
    open("viewer", {
      "GET /api/dashboards/3": { body: dashboard({ widgets: stats }) },
      "POST /api/widget-data": ({ body }) => {
        const asset = (body as { config: { assets: number[] } }).config.assets[0];
        return { body: valuesData({ values: [valueRow({ asset_id: asset, name: `Asset ${asset}`, point_id: asset * 10, value: asset })] }) };
      },
    });
    for (const id of [11, 12, 13]) await within(await region(`Stat ${id}`)).findByText(`${id}.00`);
    await waitFor(() => expect(FakeEventSource.open).toHaveLength(1));
    act(() => FakeEventSource.open[0].onopen?.());
    act(() => FakeEventSource.open[0].emit([[110, 1_760_000_000, 1.5, 0], [120, 1_760_000_000, 2.5, 0], [130, 1_760_000_000, 3.5, 0]]));
    expect(within(await region("Stat 11")).getByText("1.50")).toBeInTheDocument();
    expect(within(await region("Stat 12")).getByText("2.50")).toBeInTheDocument();
    expect(within(await region("Stat 13")).getByText("3.50")).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(1); // never closed and re-opened for a late widget
  });

  it("does not re-render or re-set a chart when a stream batch arrives; only the live figures move", async () => {
    // A time series and a bar chart (neither live) next to a live stat on point 7 and a live gauge on point 8.
    const stat = widget(3, "stat", { title: "Current power", config: config({ aggregation: "last" }), x: 0, y: 4, w: 3, h: 2 });
    const gauge = widget(4, "gauge", { title: "Load", config: config({ assets: [6], aggregation: "last", min: 0, max: 200 }), x: 3, y: 4, w: 3, h: 3 });
    open("viewer", {
      "GET /api/dashboards/3": { body: dashboard({ widgets: [trend, energy, stat, gauge] }) },
      "POST /api/widget-data": ({ body }) => {
        const { type } = body as { type: DataWidgetType };
        return { body: type === "gauge" ? valuesData({ type: "gauge", values: [valueRow({ asset_id: 6, name: "LV Panel 2", value: 4, point_id: 8 })] }) : dataFor(type) };
      },
    });
    const power = within(await region("Current power"));
    await power.findByText("10.50");
    const load = within(await region("Load"));
    await load.findByRole("meter");
    await waitFor(() => expect(screen.getAllByTestId("chart")).toHaveLength(2)); // the gauge is an SVG arc, not a canvas
    await waitFor(() => expect(FakeEventSource.open).toHaveLength(1));
    act(() => FakeEventSource.open[0].onopen?.());
    act(() => FakeEventSource.open[0].emit([[7, 1_760_000_000, 11, 0], [8, 1_760_000_000, 5, 0]])); // everything now holds a stream entry
    expect(power.getByText("11.00")).toBeInTheDocument();
    expect(load.getByRole("meter")).toHaveAttribute("aria-valuenow", "5");
    const lineRenders = chart.renders.line;
    const barRenders = chart.renders.bar;
    const lineOptions = chart.options.line.size;
    expect(lineRenders).toBeGreaterThan(0);
    // A batch that moves only the stat's point.
    act(() => FakeEventSource.open[0].emit([[7, 1_760_000_001, 12.5, 0]]));
    expect(power.getByText("12.50")).toBeInTheDocument();
    expect(load.getByText("5.00")).toBeInTheDocument(); // the gauge sits on point 8: it did not move
    expect(chart.renders.line).toBe(lineRenders); // the time series was not even rendered again
    expect(chart.renders.bar).toBe(barRenders); // nor the bar chart
    expect(chart.options.line.size).toBe(lineOptions);
    // A batch that moves the gauge's point does reach the gauge.
    act(() => FakeEventSource.open[0].emit([[8, 1_760_000_002, 6, 0]]));
    await waitFor(() => expect(load.getByRole("meter")).toHaveAttribute("aria-valuenow", "6"));
    expect(load.getByText("6.00")).toBeInTheDocument();
    expect(chart.renders.line).toBe(lineRenders);
    expect(chart.renders.bar).toBe(barRenders);
  });

  it("shows a warning chip for removed assets and still draws the rest (Review Focus 5, UI side)", async () => {
    open("viewer", {
      "POST /api/widget-data": ({ body }) => {
        const type = (body as { type: DataWidgetType }).type;
        return { body: type === "stat" ? valuesData({ missing: [99] }) : dataFor(type) };
      },
    });
    const stat = within(await region("Current power"));
    expect(await stat.findByText("1 asset removed")).toBeInTheDocument();
    expect(stat.getByText("10.50")).toBeInTheDocument();
    expect(within(await region("Assets")).queryByText(/removed/)).not.toBeInTheDocument();
  });

  it("shows a failing widget's error inside that widget only", async () => {
    open("viewer", {
      "POST /api/widget-data": ({ body }) => {
        const type = (body as { type: DataWidgetType }).type;
        return type === "table" ? { status: 500, body: { detail: "query failed" } } : { body: dataFor(type) };
      },
    });
    expect(await within(await region("Assets")).findByRole("alert")).toHaveTextContent("query failed");
    const stat = within(await region("Current power"));
    await stat.findByText("10.50");
    expect(stat.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("exports a widget as CSV through the shared download helper", async () => {
    open();
    const stat = within(await region("Current power"));
    await stat.findByText("10.50");
    await userEvent.click(stat.getByRole("button", { name: "Download CSV for Current power" }));
    expect(downloadCsv).toHaveBeenCalledWith("/api/widget-data/csv", { method: "POST", body: { type: "stat", config: current.config, range: "24h" } });
  });

  it("says so when the dashboard has no widgets", async () => {
    open("viewer", { "GET /api/dashboards/3": { body: dashboard({ widgets: [] }) } });
    expect(await screen.findByText("This dashboard has no widgets yet.")).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("keeps showing the dashboard, with a notice, when a background refetch fails", async () => {
    let reads = 0;
    open("viewer", {
      "GET /api/dashboards/3": () => (reads++ === 0 ? { body: dashboard({ widgets }) } : { status: 500, body: { detail: "dashboard unavailable" } }),
    });
    await region("Power trend");
    await act(async () => {
      window.dispatchEvent(new Event("offline")); // the browser coming back online refetches the stale dashboard
      window.dispatchEvent(new Event("online"));
    });
    expect(await screen.findByText("Could not refresh this page: dashboard unavailable")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hall A" })).toBeInTheDocument();
    expect(screen.getAllByRole("region")).toHaveLength(5);
  });

  it("shows the API error when the dashboard cannot be loaded", async () => {
    open("viewer", { "GET /api/dashboards/3": { status: 404, body: { detail: "dashboard not found" } } });
    expect(await screen.findByRole("alert")).toHaveTextContent("dashboard not found");
  });

  it("asks again which dashboard is the default when its page answers 404, so the sidebar stops pointing here", async () => {
    // What the sidebar link reads. The server's first answer is the old default; once asked again it says there is none.
    const Probe = () => <p data-testid="default">{String(useDefaultDashboard().data?.dashboard_id)}</p>;
    let asked = 0;
    const calls = mockFetch({
      ...authed("viewer"),
      "GET /api/dashboards/3": { status: 404, body: { detail: "dashboard not found" } },
      "GET /api/dashboards/default": () => ({ body: { dashboard_id: ++asked === 1 ? 3 : null } }),
    });
    renderWithProviders(<><DashboardPage /><Probe /></>, { route: "/dashboards/3", path: "/dashboards/:id" });
    expect(await screen.findByRole("alert")).toHaveTextContent("dashboard not found");
    await waitFor(() => expect(screen.getByTestId("default")).toHaveTextContent("null"));
    expect(calls.filter((c) => c.path === "/api/dashboards/default")).toHaveLength(2);
  });
});

describe("DashboardPage while it loads", () => {
  const LABEL = "Loading the dashboard";
  const pause = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); }); // lets /api/me and the answers that are not held arrive

  it("shows the skeleton region and none of the page with the dashboard held, then the page and no region", async () => {
    const page = open("viewer", {}, (_method, path) => path === "/api/dashboards/3");
    expect(screen.getByText(LABEL).parentElement).toHaveAttribute("role", "status");
    expect(document.querySelector(".sk-region .row.dash-head")).not.toBeNull();
    expect(document.querySelectorAll(".sk-quad > .sk-block")).toHaveLength(4);
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument(); // the real title is not there yet, and the placeholder is no heading
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Dashboard range")).not.toBeInTheDocument();
    expect(progress.getCount("pending")).toBe(0); // a query's own wait is counted by the bar through React Query; Pending belongs to Suspense fallbacks
    page.release();
    expect(await screen.findByRole("heading", { name: "Hall A" })).toBeInTheDocument();
    expect(await region("Power trend")).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    // The page's own skeleton is gone; each widget draws its own `.widget-sk` region until its data lands, so those are waited out.
    expect(document.querySelector(".sk-region:not(.widget-sk)")).toBeNull();
    await waitFor(() => expect(document.querySelector(".widget-sk")).toBeNull());
    expect(document.querySelector(".sk-region")).toBeNull();
  });

  it("stays a skeleton until the site zone is in as well (the widgets need it)", async () => {
    const page = open("viewer", {}, (_method, path) => path === "/api/site");
    await waitFor(() => expect(screen.getByText(LABEL)).toBeInTheDocument());
    await pause(); // the dashboard itself has answered by now
    expect(screen.getByText(LABEL)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Hall A" })).not.toBeInTheDocument();
    page.release();
    expect(await screen.findByRole("heading", { name: "Hall A" })).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
  });

  it("gives someone who can edit the Edit button's block in the head row, after the select's and the Focus button's, and a viewer not", async () => {
    const operator = open("operator", {}, (_method, path) => path === "/api/dashboards/3");
    await waitFor(() => expect(document.querySelectorAll(".dash-head > .sk-block")).toHaveLength(3)); // (the role arrives with /api/me, a moment after the first render)
    operator.release();
    await screen.findByRole("heading", { name: "Hall A" });
  });

  it("has the select's block and the Focus button's for a viewer (it can open assets)", async () => {
    const page = open("viewer", {}, (_method, path) => path === "/api/dashboards/3");
    await pause(); // /api/me has answered
    expect(document.querySelectorAll(".dash-head > .sk-block")).toHaveLength(2);
    page.release();
    await screen.findByRole("heading", { name: "Hall A" });
  });

  it("has only the select's block for a role that cannot open assets", async () => {
    const page = open("custom", { "GET /api/me": { body: userFor("custom", { permissions: ["dashboards.view"] }) } }, (_method, path) => path === "/api/dashboards/3");
    await pause();
    expect(document.querySelectorAll(".dash-head > .sk-block")).toHaveLength(1);
    page.release();
    await screen.findByRole("heading", { name: "Hall A" });
  });

  it("ends in the error, with no region left, when the dashboard cannot be loaded", async () => {
    open("viewer", { "GET /api/dashboards/3": { status: 404, body: { detail: "dashboard not found" } } });
    expect(await screen.findByRole("alert")).toHaveTextContent("dashboard not found");
    expect(document.querySelector(".sk-region")).toBeNull();
  });
});

describe("DashboardPage with a focus asset (the header)", () => {
  const node = (id: number, parent_id: number | null, name: string, sort_order = 0): Asset => ({ id, parent_id, name, kind: "generic", sort_order });
  /** One top-level asset (Site) over Hall 1 > Row 2 > Rack 5, and Hall 2 beside Hall 1. */
  const deep = [node(1, null, "Site"), node(2, 1, "Hall 1"), node(3, 2, "Row 2"), node(4, 3, "Rack 5"), node(5, 1, "Hall 2", 1)];
  /** Two top-level assets: Site A over Hall 1 > Row 2, and Site B. */
  const forest = [node(1, null, "Site A"), node(2, 1, "Hall 1"), node(3, 2, "Row 2"), node(9, null, "Site B", 1)];

  /** A data router, so a test can read the address, see how it changed and go back. One fixed stat widget: it never follows a focus. */
  function openAt(entry: string, { role = "viewer", assets = deep, over = {}, hold }: { role?: string; assets?: Asset[]; over?: Routes; hold?: (method: string, path: string) => boolean } = {}) {
    const calls = mockFetch({
      ...authed(role),
      "GET /api/dashboards/3": { body: dashboard({ widgets: [current] }) },
      "GET /api/assets": { body: assets },
      "POST /api/widget-data": widgetDataRoute,
      ...over,
    });
    const held = hold ? holdFetch(hold) : { release: () => {} };
    const view = renderWithDataRouter(<DashboardPage />, { route: entry, path: "/dashboards/:id" });
    return { calls, ...view, release: held.release, where: () => view.router.state.location.pathname + view.router.state.location.search };
  }
  const trail = () => screen.getByRole("navigation", { name: "Breadcrumb" });
  const crumbs = () => within(trail()).getAllByRole("listitem").map((li) => (li.textContent ?? "").replace(/^\//, ""));
  const listRequests = (calls: { path: string }[]) => calls.filter((c) => c.path === "/api/assets");
  const only = (names: string[]) => ({ "GET /api/me": { body: userFor("custom", { permissions: names as never }) } });

  describe("the trail", () => {
    it("without a focus is today's trail and asks for no asset list", async () => {
      const { calls } = openAt("/dashboards/3");
      await screen.findByRole("heading", { name: "Hall A" });
      await screen.findByRole("button", { name: "Focus" }); // the account is known
      expect(crumbs()).toEqual(["Dashboards", "Hall A"]);
      expect(within(trail()).getByText("Hall A")).toHaveAttribute("aria-current", "page");
      expect(within(trail()).getAllByRole("link")).toHaveLength(1);
      expect(listRequests(calls)).toHaveLength(0);
    });

    it("with a focus one level down goes on through it: the dashboard's name links to the whole site and the focus asset is the current page", async () => {
      openAt("/dashboards/3?asset=2&range=7d", { assets: forest });
      await waitFor(() => expect(crumbs()).toEqual(["Dashboards", "Hall A", "Site A", "Hall 1"]));
      const links = within(trail()).getAllByRole("link");
      expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
        ["Dashboards", "/dashboards"], ["Hall A", "/dashboards/3?range=7d"], ["Site A", "/dashboards/3?asset=1&range=7d"],
      ]);
      expect(within(trail()).getByText("Hall 1")).toHaveAttribute("aria-current", "page");
      expect(screen.getAllByRole("navigation", { name: /breadcrumb/i })).toHaveLength(1);
    });

    it("with a deep focus lists the ancestors root first, each a link to the dashboard at that asset, and leaves out the only top-level asset", async () => {
      openAt("/dashboards/3?asset=4");
      await waitFor(() => expect(crumbs()).toEqual(["Dashboards", "Hall A", "Hall 1", "Row 2", "Rack 5"]));
      expect(within(trail()).getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual([
        "/dashboards", "/dashboards/3", "/dashboards/3?asset=2", "/dashboards/3?asset=3",
      ]);
      expect(within(trail()).getByText("Rack 5")).toHaveAttribute("aria-current", "page");
    });

    it("keeps several top-level assets in the trail", async () => {
      openAt("/dashboards/3?asset=3", { assets: forest });
      await waitFor(() => expect(crumbs()).toEqual(["Dashboards", "Hall A", "Site A", "Hall 1", "Row 2"]));
    });

    it("a focus that is the only top-level asset is cleared by the provider and the trail is today's", async () => {
      const { where } = openAt("/dashboards/3?asset=1");
      await waitFor(() => expect(where()).toBe("/dashboards/3"));
      expect(crumbs()).toEqual(["Dashboards", "Hall A"]);
      expect(screen.queryByRole("link", { name: /^Open .* page$/ })).not.toBeInTheDocument();
    });

    it("until the asset list is here it is today's trail (the name is the current page), then it extends", async () => {
      const page = openAt("/dashboards/3?asset=4", { hold: (_method, path) => path === "/api/assets" });
      await screen.findByRole("heading", { name: "Hall A" });
      await screen.findByRole("button", { name: "Focus" });
      expect(crumbs()).toEqual(["Dashboards", "Hall A"]);
      expect(within(trail()).getByText("Hall A")).toHaveAttribute("aria-current", "page");
      expect(within(trail()).getAllByRole("link")).toHaveLength(1);
      page.release();
      await waitFor(() => expect(crumbs()).toEqual(["Dashboards", "Hall A", "Hall 1", "Row 2", "Rack 5"]));
      expect(within(trail()).getByText("Hall A")).not.toHaveAttribute("aria-current");
    });

    it("an asset that is not in the list leaves today's trail (the provider drops the focus)", async () => {
      const { where } = openAt("/dashboards/3?asset=77");
      await waitFor(() => expect(where()).toBe("/dashboards/3"));
      expect(crumbs()).toEqual(["Dashboards", "Hall A"]);
    });

    it("a crumb pushes: Back walks back, one step at a time", async () => {
      const { where, router } = openAt("/dashboards/3?asset=4");
      await waitFor(() => expect(crumbs()).toEqual(["Dashboards", "Hall A", "Hall 1", "Row 2", "Rack 5"]));
      await userEvent.click(within(trail()).getByRole("link", { name: "Hall 1" }));
      expect(where()).toBe("/dashboards/3?asset=2");
      expect(router.state.historyAction).toBe("PUSH");
      expect(crumbs()).toEqual(["Dashboards", "Hall A", "Hall 1"]);
      await userEvent.click(within(trail()).getByRole("link", { name: "Hall A" }));
      expect(where()).toBe("/dashboards/3");
      expect(router.state.historyAction).toBe("PUSH");
      expect(crumbs()).toEqual(["Dashboards", "Hall A"]);
      await act(async () => { await router.navigate(-1); });
      expect(where()).toBe("/dashboards/3?asset=2");
      expect(crumbs()).toEqual(["Dashboards", "Hall A", "Hall 1"]);
      await act(async () => { await router.navigate(-1); });
      expect(where()).toBe("/dashboards/3?asset=4");
      expect(crumbs()).toEqual(["Dashboards", "Hall A", "Hall 1", "Row 2", "Rack 5"]);
    });
  });

  describe("the Focus button and the link to the asset's page", () => {
    const focusButton = () => screen.findByRole("button", { name: "Focus" });

    it("is a button with a dialog behind it, after the range select and before Edit", async () => {
      openAt("/dashboards/3", { role: "operator" });
      const button = await focusButton();
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveAttribute("aria-haspopup", "dialog");
      const select = screen.getByLabelText("Dashboard range");
      const edit = await screen.findByRole("button", { name: "Edit" });
      expect(select.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(button.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.queryByRole("link", { name: /^Open .* page$/ })).not.toBeInTheDocument(); // no focus, no link
    });

    it("is not there for a role that cannot open assets, with or without a focus in the address", async () => {
      openAt("/dashboards/3?asset=2", { role: "custom", over: only(["dashboards.view"]) });
      await screen.findByRole("heading", { name: "Hall A" });
      expect(await screen.findByText(/Your role cannot open assets/)).toBeInTheDocument(); // the account is known, and the link was refused
      expect(screen.queryByRole("button", { name: "Focus" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /^Open .* page$/ })).not.toBeInTheDocument();
      expect(crumbs()).toEqual(["Dashboards", "Hall A"]);
    });

    it("with a focus adds a link styled as a button to the asset's page, named for the asset, and keeps it in place when the name arrives", async () => {
      const page = openAt("/dashboards/3?asset=2", { hold: (_method, path) => path === "/api/assets" });
      const waiting = await screen.findByRole("link", { name: "Open Asset #2 page" });
      expect(waiting).toHaveAttribute("href", "/assets/2");
      page.release();
      const link = await screen.findByRole("link", { name: "Open Hall 1 page" });
      expect(link).toBe(waiting); // the same element, only its words changed
      expect(link).toHaveAttribute("href", "/assets/2");
      expect(link).toHaveClass("focus-open");
      const focus = await focusButton();
      expect(focus.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("opens the dialog; Show pushes the chosen asset, the trail and the link follow, the focus returns, Back undoes it, and a fixed widget asks for nothing new", async () => {
      const { calls, where, router } = openAt("/dashboards/3");
      await within(await region("Current power")).findByText("10.50");
      expect(dataRequests(calls)).toHaveLength(1);
      const button = await focusButton();
      await userEvent.click(button);
      const dialog = await screen.findByRole("dialog", { name: "Choose a focus" });
      await userEvent.click(await within(dialog).findByRole("radio", { name: "Hall 2" }));
      expect(where()).toBe("/dashboards/3"); // a draft so far
      await userEvent.click(within(dialog).getByRole("button", { name: "Show" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(where()).toBe("/dashboards/3?asset=5");
      expect(router.state.historyAction).toBe("PUSH");
      expect(crumbs()).toEqual(["Dashboards", "Hall A", "Hall 2"]);
      expect(await screen.findByRole("link", { name: "Open Hall 2 page" })).toHaveAttribute("href", "/assets/5");
      expect(button).toHaveFocus();
      expect(dataRequests(calls)).toHaveLength(1); // the stat does not follow the focus
      await act(async () => { await router.navigate(-1); });
      expect(where()).toBe("/dashboards/3");
      expect(crumbs()).toEqual(["Dashboards", "Hall A"]);
      expect(screen.queryByRole("link", { name: /^Open .* page$/ })).not.toBeInTheDocument();
    });

    it("a change of focus through the dialog costs a widget with its own assets no request, and a widget that follows the focus exactly one", async () => {
      const followed = widget(7, "table", { title: "Hall figures", config: config({ assets: [], source: "energy", metric: null, aggregation: "sum", scope: "focus" }), x: 6, y: 0, w: 6, h: 3 });
      const { calls, where } = openAt("/dashboards/3", { over: { "GET /api/dashboards/3": { body: dashboard({ widgets: [current, followed] }) } } });
      await within(await region("Current power")).findByText("10.50");
      const table = within(await region("Hall figures"));
      await table.findByText("LV Panel 2");
      const asked = (type: string) => (dataRequests(calls) as { type: string; focus?: number }[]).filter((r) => r.type === type);
      expect(asked("stat")).toHaveLength(1);
      expect(asked("table")).toHaveLength(1);
      expect(asked("table")[0].focus).toBeUndefined();
      await userEvent.click(await focusButton());
      const dialog = await screen.findByRole("dialog", { name: "Choose a focus" });
      await userEvent.click(await within(dialog).findByRole("radio", { name: "Hall 2" }));
      await userEvent.click(within(dialog).getByRole("button", { name: "Show" }));
      expect(where()).toBe("/dashboards/3?asset=5");
      await waitFor(() => expect(asked("table")).toHaveLength(2));
      expect(asked("table")[1].focus).toBe(5);
      // The fixed widget has seen the new focus (its footer names it) and the following one has its answer: nothing more is on its way.
      await within(await region("Current power")).findByText("Its own assets, not Hall 2");
      await waitFor(() => expect(document.querySelector(".widget-body[aria-busy]")).toBeNull());
      expect(asked("table")).toHaveLength(2);
      expect(asked("stat")).toHaveLength(1);
      expect(asked("stat")[0].focus).toBeUndefined();
    });

    it("Cancel leaves the address and the trail alone", async () => {
      const { where, router } = openAt("/dashboards/3?asset=2");
      await userEvent.click(await focusButton());
      const dialog = await screen.findByRole("dialog", { name: "Choose a focus" });
      await userEvent.click(await within(dialog).findByRole("radio", { name: "Hall 2" }));
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(where()).toBe("/dashboards/3?asset=2");
      expect(router.state.historyAction).toBe("POP");
      expect(await focusButton()).toHaveFocus();
    });

    it("does not add a second landmark or a second element named breadcrumb", async () => {
      openAt("/dashboards/3?asset=4");
      await waitFor(() => expect(crumbs()).toHaveLength(5));
      expect(screen.getAllByRole("navigation")).toHaveLength(1);
      expect(document.querySelectorAll("[aria-label*='readcrumb' i]")).toHaveLength(1);
    });
  });
});
