import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WidgetData } from "../../api/types";
import { config, dataFor, seriesData, seriesPoint, valueRow, valuesData } from "../../test/dashboardFixtures";
import { mockFetch } from "../../test/fetchMock";
import { WidgetView, type WidgetViewProps } from "./WidgetView";

vi.mock("echarts-for-react", () => ({
  default: (props: { option: { series?: { type?: string }[] } }) => (
    <pre data-testid="chart" data-kind={props.option.series?.[0]?.type}>{JSON.stringify(props.option)}</pre>
  ),
}));

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
const props = (over: Partial<WidgetViewProps> = {}): WidgetViewProps => ({
  widgetKey: "w1", type: "table", title: "Hall", config: config({ assets: [5, 6] }), dashboardRange: "24h", timezone: "Asia/Qatar", ...over,
});
const show = (over: Partial<WidgetViewProps> = {}) => render(<WidgetView {...props(over)} />, { wrapper });

beforeEach(() => client.clear());

describe("WidgetView", () => {
  it("asks for the widget's own range, else the dashboard's", async () => {
    const calls = mockFetch({ "POST /api/widget-data": ({ body }) => ({ body: dataFor((body as { type: "table" }).type) }) });
    const { unmount } = show();
    await screen.findByRole("table");
    expect(calls.map((c) => (c.body as { range: string }).range)).toEqual(["24h"]);
    unmount();
    show({ config: config({ range: "30d" }) });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect((calls[1].body as { range: string }).range).toBe("30d");
  });

  it("shows a chip for removed assets and one for assets without the metric, and still draws the rest", async () => {
    mockFetch({ "POST /api/widget-data": { body: valuesData({ type: "table", missing: [99], no_metric: [6, 7] }) } });
    show();
    expect(await screen.findByText("1 asset removed")).toBeInTheDocument();
    expect(screen.getByText("2 assets without this metric")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("shows the window a rolling energy widget really covers, from the response's range.start", async () => {
    const energy = valuesData({
      type: "table", source: "energy", metric: null, unit: "kWh",
      range: { preset: "1h", start: "2026-10-08T10:00:00+03:00", end: "2026-10-08T10:30:00+03:00" },
    });
    mockFetch({ "POST /api/widget-data": { body: energy } });
    show({ config: config({ source: "energy", metric: null, aggregation: "sum", assets: [5] }), dashboardRange: "1h" });
    expect(await screen.findByText("since 10:00")).toBeInTheDocument();
  });

  it("shows no window for a calendar range or a metric", async () => {
    const calendar = valuesData({
      type: "table", source: "energy", metric: null, unit: "kWh",
      range: { preset: "today", start: "2026-10-08T00:00:00+03:00", end: "2026-10-08T10:30:00+03:00" },
    });
    mockFetch({ "POST /api/widget-data": { body: calendar } });
    show({ config: config({ source: "energy", metric: null, aggregation: "sum" }), dashboardRange: "today" });
    await screen.findByRole("table");
    expect(screen.queryByText(/^since/)).not.toBeInTheDocument();
  });

  it("explains the markers of a chart in the frame, whatever the chart's legend shows, and a table only once", async () => {
    const cost = seriesData({
      type: "timeseries", source: "cost", metric: null, unit: "QAR", bucket: "hour", tier: null,
      series: [{ asset_id: 5, name: "A", estimated: true, partial: true, points: [seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 1, estimated: true, partial: true })] }],
    });
    mockFetch({ "POST /api/widget-data": { body: cost } });
    const { unmount } = show({ type: "timeseries" });
    expect(await screen.findByText("~ estimated, * partial, some hours have no rate")).toBeInTheDocument();
    unmount();
    mockFetch({ "POST /api/widget-data": { body: valuesData({ type: "table", values: [valueRow({ estimated: true })] }) } });
    show({ type: "table" });
    await screen.findByRole("table");
    expect(screen.getAllByText("~ estimated")).toHaveLength(1);
  });

  it("says in the frame what the dash means when a cost chart has buckets without a rate, even if no bucket has a figure", async () => {
    const hours = ["2026-10-08T00:00:00+00:00", "2026-10-08T01:00:00+00:00"];
    const cost = (points: ReturnType<typeof seriesPoint>[]) => seriesData({
      type: "timeseries", source: "cost", metric: null, unit: "QAR", bucket: "hour", tier: null,
      series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points }],
    });
    mockFetch({ "POST /api/widget-data": { body: cost(hours.map((ts) => seriesPoint({ ts, value: null }))) } });
    const { unmount } = show({ type: "timeseries", config: config({ source: "cost", metric: null }) });
    expect(await screen.findByText("— no rate")).toBeInTheDocument();
    unmount();
    // a bar chart of costs per asset, one of them without a rate
    mockFetch({ "POST /api/widget-data": { body: valuesData({ type: "bar", source: "cost", metric: null, unit: "QAR", values: [valueRow({ value: 4 }), valueRow({ asset_id: 6, value: null })] }) } });
    const bars = show({ type: "bar", config: config({ source: "cost", metric: null }) });
    expect(await screen.findByText("— no rate")).toBeInTheDocument();
    bars.unmount();
    // fully priced: nothing to explain
    client.clear(); // the first answer is cached under the same key
    mockFetch({ "POST /api/widget-data": { body: cost(hours.map((ts) => seriesPoint({ ts, value: 1.5 }))) } });
    show({ type: "timeseries", config: config({ source: "cost", metric: null }) });
    expect((await screen.findByTestId("chart")).textContent).toContain("1.5"); // the priced figures are what is drawn
    expect(screen.queryByText(/no rate/)).not.toBeInTheDocument();
  });

  it("offers the CSV download unless told not to", async () => {
    mockFetch({ "POST /api/widget-data": { body: valuesData({ type: "table" }) } });
    const { unmount } = show();
    await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "Download CSV for Hall" })).toBeInTheDocument();
    unmount();
    show({ csv: false });
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: /CSV/ })).not.toBeInTheDocument();
  });

  it("does not draw the old widget's data while a changed type loads (editor preview)", async () => {
    // The gauge answer is held back so the frame between the two types can be looked at.
    let release: (data: WidgetData) => void = () => {};
    const gauge = new Promise<WidgetData>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { type } = JSON.parse(String(init?.body)) as { type: "timeseries" | "gauge" };
      const body = type === "gauge" ? await gauge : dataFor("timeseries");
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const { rerender } = show({ type: "timeseries", config: config({ aggregation: "last" }) });
    await waitFor(() => expect(screen.getByTestId("chart")).toHaveAttribute("data-kind", "line"));
    rerender(<WidgetView {...props({ type: "gauge", config: config({ aggregation: "last" }) })} />);
    expect(screen.getByText("loading…")).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
    release(dataFor("gauge"));
    await waitFor(() => expect(screen.getByTestId("chart")).toHaveAttribute("data-kind", "gauge"));
    expect(within(screen.getByRole("region", { name: "Hall" })).queryByText("loading…")).not.toBeInTheDocument();
  });
});
