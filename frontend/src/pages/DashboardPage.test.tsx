import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Role, WidgetType } from "../api/types";
import { downloadCsv } from "../lib/download";
import { authed, config, dashboard, dataFor, valueRow, valuesData, widget, widgetDataRoute } from "../test/dashboardFixtures";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
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

function open(role: Role = "viewer", over: Routes = {}) {
  const calls = mockFetch({
    ...authed(role),
    "GET /api/dashboards/3": { body: dashboard({ widgets }) },
    "POST /api/widget-data": widgetDataRoute,
    ...over,
  });
  renderWithProviders(<DashboardPage />, { route: "/dashboards/3", path: "/dashboards/:id" });
  return calls;
}
const region = (name: string) => screen.findByRole("region", { name });
const dataRequests = (calls: { method: string; path: string; body: unknown }[]) =>
  calls.filter((c) => c.method === "POST" && c.path === "/api/widget-data").map((c) => c.body as { type: string; range: string });

describe("DashboardPage (view)", () => {
  it("renders one widget of each type, in reading order", async () => {
    open();
    await region("Power trend");
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Power trend", "Energy by asset", "Current power", "Load", "Assets"]);
    await waitFor(() => expect(screen.getAllByTestId("chart")).toHaveLength(3));
    expect(screen.getAllByTestId("chart").map((c) => c.getAttribute("data-kind")).sort()).toEqual(["bar", "gauge", "line"]);
    expect(await within(await region("Current power")).findByText("10.50")).toBeInTheDocument();
    const table = within(await region("Assets"));
    expect(await table.findByText("LV Panel 2")).toBeInTheDocument();
    expect(table.getByText("~4.25")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hall A" })).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getAllByTestId("chart").some((c) => c.textContent?.includes('"value":11.25'))).toBe(true));
    const table = within(await region("Assets"));
    expect(await table.findByText("10.50")).toBeInTheDocument(); // a table is not live
    expect(table.queryByText("99.00")).not.toBeInTheDocument();
    act(() => FakeEventSource.open[0].emit([[7, 1_760_000_001, 5, 1]]));
    expect(stat.getByText("—")).toBeInTheDocument(); // bad quality: a dash, not the old figure
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
        const { type } = body as { type: WidgetType };
        return { body: type === "gauge" ? valuesData({ type: "gauge", values: [valueRow({ asset_id: 6, name: "LV Panel 2", value: 4, point_id: 8 })] }) : dataFor(type) };
      },
    });
    const power = within(await region("Current power"));
    await power.findByText("10.50");
    await waitFor(() => expect(screen.getAllByTestId("chart")).toHaveLength(3));
    await waitFor(() => expect(FakeEventSource.open).toHaveLength(1));
    act(() => FakeEventSource.open[0].onopen?.());
    act(() => FakeEventSource.open[0].emit([[7, 1_760_000_000, 11, 0], [8, 1_760_000_000, 5, 0]])); // everything now holds a stream entry
    expect(power.getByText("11.00")).toBeInTheDocument();
    const lineRenders = chart.renders.line;
    const barRenders = chart.renders.bar;
    const lineOptions = chart.options.line.size;
    const gaugeOptions = chart.options.gauge.size;
    expect(lineRenders).toBeGreaterThan(0);
    // A batch that moves only the stat's point.
    act(() => FakeEventSource.open[0].emit([[7, 1_760_000_001, 12.5, 0]]));
    expect(power.getByText("12.50")).toBeInTheDocument();
    expect(chart.renders.line).toBe(lineRenders); // the time series was not even rendered again
    expect(chart.renders.bar).toBe(barRenders); // nor the bar chart
    expect(chart.options.line.size).toBe(lineOptions);
    expect(chart.options.gauge.size).toBe(gaugeOptions); // the gauge re-renders, but with the very same option: no setOption
    // A batch that moves the gauge's point does reach the gauge.
    act(() => FakeEventSource.open[0].emit([[8, 1_760_000_002, 6, 0]]));
    await waitFor(() => expect(chart.options.gauge.size).toBe(gaugeOptions + 1));
    expect(chart.renders.line).toBe(lineRenders);
    expect(chart.renders.bar).toBe(barRenders);
  });

  it("shows a warning chip for removed assets and still draws the rest (Review Focus 5, UI side)", async () => {
    open("viewer", {
      "POST /api/widget-data": ({ body }) => {
        const type = (body as { type: WidgetType }).type;
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
        const type = (body as { type: WidgetType }).type;
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

  it("shows the API error when the dashboard cannot be loaded", async () => {
    open("viewer", { "GET /api/dashboards/3": { status: 404, body: { detail: "dashboard not found" } } });
    expect(await screen.findByRole("alert")).toHaveTextContent("dashboard not found");
  });
});
