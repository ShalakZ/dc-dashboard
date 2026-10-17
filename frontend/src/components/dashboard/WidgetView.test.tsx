import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import type { WidgetData } from "../../api/types";
import { downloadCsv } from "../../lib/download";
import { config, dataFor, seriesData, seriesPoint, valueRow, valuesData } from "../../test/dashboardFixtures";
import { mockFetch } from "../../test/fetchMock";
import { WidgetView, type WidgetViewProps } from "./WidgetView";

// Only the Details drawer asks who is signed in (and only when it is open); the card and the other cases need neither.
const held = { ids: new Set<string>(["assets.view"]) };
vi.mock("../../auth/AuthProvider", () => ({ useAuth: () => ({ can: (id: string) => held.ids.has(id) }) }));
vi.mock("../../lib/download", () => ({ downloadCsv: vi.fn() }));

vi.mock("echarts-for-react", () => ({
  default: (props: { option: { series?: { type?: string }[] } }) => (
    <pre data-testid="chart" data-kind={props.option.series?.[0]?.type}>{JSON.stringify(props.option)}</pre>
  ),
}));

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
const props = (over: Partial<WidgetViewProps> = {}): WidgetViewProps => ({
  widgetKey: "w1", type: "table", title: "Hall", config: config({ assets: [5, 6] }), dashboardRange: "24h", timezone: "Asia/Qatar", ...over,
});
const show = (over: Partial<WidgetViewProps> = {}) => render(<WidgetView {...props(over)} />, { wrapper });

beforeEach(() => {
  client.clear();
  held.ids = new Set(["assets.view"]);
  vi.mocked(downloadCsv).mockReset();
  vi.mocked(downloadCsv).mockResolvedValue(undefined);
});

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

  it("explains the dash of a cost bar per asset whose only unpriced asset also recorded nothing", async () => {
    mockFetch({ "POST /api/widget-data": { body: valuesData({
      type: "bar", source: "cost", metric: null, unit: "QAR",
      values: [valueRow({ value: 4 }), valueRow({ asset_id: 6, name: "Quiet", value: null, no_data: true })],
    }) } });
    show({ type: "bar", config: config({ source: "cost", metric: null }) });
    expect(await screen.findByText("— no rate")).toBeInTheDocument();
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

  it("does not draw the old widget's data while a changed type loads (editor preview), only the new type's skeleton", async () => {
    // The bar answer is held back so the frame between the two types can be looked at.
    let release: (data: WidgetData) => void = () => {};
    const bar = new Promise<WidgetData>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { type } = JSON.parse(String(init?.body)) as { type: "timeseries" | "bar" };
      const body = type === "bar" ? await bar : dataFor("timeseries");
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const { rerender } = show({ type: "timeseries", config: config({ aggregation: "last" }) });
    await waitFor(() => expect(screen.getByTestId("chart")).toHaveAttribute("data-kind", "line"));
    rerender(<WidgetView {...props({ type: "bar", config: config({ aggregation: "last" }) })} />);
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("Loading Hall");
    expect(region).toHaveAttribute("data-type", "bar");
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
    release(dataFor("bar"));
    await waitFor(() => expect(screen.getByTestId("chart")).toHaveAttribute("data-kind", "bar"));
    expect(within(screen.getByRole("region", { name: "Hall" })).queryByRole("status")).not.toBeInTheDocument();
  });

  it("draws the card's skeleton in one region named for the widget while the first answer is held, then the figures and no region", async () => {
    let release: (data: WidgetData) => void = () => {};
    const held = new Promise<WidgetData>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(await held), { status: 200, headers: { "content-type": "application/json" } })));
    show({ type: "stat" });
    expect(screen.getByRole("heading", { name: "Hall", level: 2 })).toBeInTheDocument(); // the title is there at once
    const region = screen.getByRole("status");
    expect(region).toHaveClass("widget-sk");
    expect(region).toHaveAttribute("data-type", "stat");
    expect(region).toHaveTextContent(/^Loading Hall$/);
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    release(dataFor("stat"));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(document.querySelector(".widget-sk")).toBeNull();
    expect(document.querySelector(".stat")).not.toBeNull();
  });

  it("keeps the footer line's room for a rolling energy widget while it loads, and not for a metric or a calendar range", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const { container, unmount } = show({ type: "stat", config: config({ source: "energy", metric: null, aggregation: "sum" }), dashboardRange: "1h" });
    expect(container.querySelector(".widget-foot")).toHaveAttribute("aria-hidden", "true");
    unmount();
    client.clear();
    const metric = show({ type: "stat", config: config({ aggregation: "last" }), dashboardRange: "1h" });
    expect(metric.container.querySelector(".widget-foot")).toBeNull();
    metric.unmount();
    client.clear();
    const calendar = show({ type: "stat", config: config({ source: "energy", metric: null, aggregation: "sum" }), dashboardRange: "today" });
    expect(calendar.container.querySelector(".widget-foot")).toBeNull();
  });

  it("explains a missing rate in the footer for a stat, a table and a chart alike (the footer is the one place for the hint)", async () => {
    const noRate = valuesData({ type: "stat", source: "cost", metric: null, unit: "QAR", values: [valueRow({ value: null })] });
    mockFetch({ "POST /api/widget-data": { body: noRate } });
    const stat = show({ type: "stat", config: config({ source: "cost", metric: null, aggregation: "sum" }) });
    const note = await screen.findByText("— no rate");
    expect(note).toHaveClass("widget-hint");
    expect(note.parentElement).toHaveClass("widget-foot");
    stat.unmount();
    client.clear();
    mockFetch({ "POST /api/widget-data": { body: { ...noRate, type: "table" } } });
    show({ type: "table", config: config({ source: "cost", metric: null, aggregation: "sum" }) });
    expect((await screen.findByText("— no rate")).parentElement).toHaveClass("widget-foot");
  });
});

describe("WidgetView: Details", () => {
  const stat = () => valuesData({ type: "stat", values: [valueRow({ ts: new Date(Date.now() - 9000).toISOString() })] });
  const detailsButton = () => screen.getByRole("button", { name: "Details for Hall" });

  it("opens a dialog from the data the card already has (one fetch), and Escape closes it with focus back on the button", async () => {
    const calls = mockFetch({ "POST /api/widget-data": { body: stat() } });
    show({ type: "stat", config: config({ aggregation: "last" }) });
    await screen.findByText("10.50");
    const button = detailsButton();
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    await userEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Details: Hall" });
    expect(within(dialog).getByRole("link", { name: "LV Panel 1" })).toBeInTheDocument();
    expect(within(dialog).getByText(/^Last reading \d\d:\d\d:\d\d \(\d+ s ago\)$/)).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("opens with Enter and with Space on the focused button", async () => {
    mockFetch({ "POST /api/widget-data": { body: stat() } });
    show({ type: "stat", config: config({ aggregation: "last" }) });
    await screen.findByText("10.50");
    detailsButton().focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Details: Hall" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(detailsButton()).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(screen.getByRole("dialog", { name: "Details: Hall" })).toBeInTheDocument();
  });

  it("closes with the Close button and gives focus back to the Details button", async () => {
    mockFetch({ "POST /api/widget-data": { body: stat() } });
    show({ type: "stat" });
    await screen.findByText("10.50");
    await userEvent.click(detailsButton());
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(detailsButton()).toHaveFocus();
  });

  it("holds the button back while the first answer loads (aria-disabled, never disabled) and opens nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    show({ type: "stat" });
    const button = detailsButton();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    await userEvent.click(button);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("has no Details button when told not to (the editor preview, edit mode), and none when the answer failed", async () => {
    mockFetch({ "POST /api/widget-data": { body: stat() } });
    const { unmount } = show({ type: "stat", details: false });
    await screen.findByText("10.50");
    expect(screen.queryByRole("button", { name: /Details/ })).not.toBeInTheDocument();
    unmount();
    client.clear();
    mockFetch({ "POST /api/widget-data": { status: 500, body: { detail: "broken" } } });
    show({ type: "stat" });
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: /Details/ })).not.toBeInTheDocument();
  });

  it("links the asset names to their pages for a role that may open them, and writes plain names for one that may not", async () => {
    mockFetch({ "POST /api/widget-data": { body: stat() } });
    const first = show({ type: "stat" });
    await screen.findByText("10.50");
    await userEvent.click(detailsButton());
    expect(within(screen.getByRole("dialog")).getByRole("link", { name: "LV Panel 1" })).toHaveAttribute("href", "/assets/5");
    first.unmount();
    client.clear();
    held.ids = new Set();
    show({ type: "stat" });
    await screen.findByText("10.50");
    await userEvent.click(detailsButton());
    expect(within(screen.getByRole("dialog")).queryByRole("link")).not.toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByText("LV Panel 1", { selector: "li" })).toBeInTheDocument();
  });

  it("gives the same CSV as the card's button, from the drawer's footer, and says no 'average' for a series total", async () => {
    const energy = seriesData({
      type: "bar", source: "energy", metric: null, unit: "kWh", bucket: "hour", tier: null,
      series: [{ asset_id: 5, name: "LV Panel 1", estimated: false, partial: false, points: [seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 2 }), seriesPoint({ ts: "2026-10-08T01:00:00+00:00", value: 3 })] }],
    });
    mockFetch({ "POST /api/widget-data": { body: energy } });
    const energyConfig = config({ source: "energy", metric: null, aggregation: "sum", bars: "time" });
    show({ type: "bar", config: energyConfig });
    await screen.findByTestId("chart");
    await userEvent.click(screen.getByRole("button", { name: "Download CSV for Hall" }));
    await userEvent.click(detailsButton());
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).not.toMatch(/average/i);
    expect(within(dialog).getByText("5.00 kWh")).toBeInTheDocument(); // the total of the two hours
    await userEvent.click(within(dialog).getByRole("button", { name: "Download CSV" }));
    expect(downloadCsv).toHaveBeenCalledTimes(2);
    const [card, drawer] = vi.mocked(downloadCsv).mock.calls;
    expect(drawer).toEqual(card);
    expect(drawer[1]).toEqual({ method: "POST", body: { type: "bar", config: energyConfig, range: "24h" } });
  });
});
