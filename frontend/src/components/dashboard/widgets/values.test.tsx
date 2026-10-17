import { render, screen } from "@testing-library/react";
import { MUTED_FIGURE } from "../../../lib/widgetFormat";
import { config, valueRow, valuesData } from "../../../test/dashboardFixtures";
import { LiveValuesContext } from "../LiveValuesContext";
import { GaugeWidget, gaugeOption } from "./GaugeWidget";
import { StatWidget } from "./StatWidget";
import { TableWidget } from "./TableWidget";

vi.mock("echarts-for-react", () => ({
  default: (props: { option: { series?: { type?: string }[] } }) => (
    <pre data-testid="chart" data-kind={props.option.series?.[0]?.type}>{JSON.stringify(props.option)}</pre>
  ),
}));

const stream = (value: number | null, quality = 0, connected = true, ts = "2026-10-08T06:00:00.000Z") => ({
  values: new Map([[7, { ts, value, quality }]]), connected, register: () => {},
});
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe("gauge", () => {
  type GaugeOpt = { series: { type: string; min: number; max: number; pointer: { show: boolean }; progress: { show: boolean }; data: { value: number }[]; detail: { formatter: () => string; color?: string; offsetCenter: [number, string] }; title: { show: boolean; offsetCenter: [number, string] } }[] };
  const gauge = (args: Partial<Parameters<typeof gaugeOption>[0]> = {}) =>
    gaugeOption({ value: 12.5, min: 0, max: 100, unit: "kW", name: "LV Panel 1", ...args }) as unknown as GaugeOpt;

  it("uses the configured range, the unit and the markers of the figure", () => {
    const option = gauge();
    expect(option.series[0]).toMatchObject({ type: "gauge", min: 0, max: 100, data: [{ value: 12.5 }], pointer: { show: true }, progress: { show: true } });
    expect(option.series[0].detail.formatter()).toBe("12.50 kW");
    expect(gauge({ estimated: true, partial: true }).series[0].detail.formatter()).toBe("~12.50* kW");
  });

  it("positions the asset name (the series title) below the value, not at the default centre over the needle", () => {
    const { title, detail } = gauge().series[0];
    expect(title.show).toBe(true);
    expect(Array.isArray(title.offsetCenter)).toBe(true);
    expect(parseFloat(title.offsetCenter[1])).toBeGreaterThan(parseFloat(detail.offsetCenter[1])); // 70 % for the value
  });

  it("draws no needle and no progress for a missing figure, only a dash, never a zero", () => {
    const empty = gauge({ value: null, min: 10, max: 20 });
    expect(empty.series[0].pointer.show).toBe(false);
    expect(empty.series[0].progress.show).toBe(false);
    expect(empty.series[0].detail.formatter()).toBe("—");
    expect(gauge({ value: null, noData: true }).series[0].detail.formatter()).toBe("no data");
    expect(empty.series[0].data[0].value).toBe(10); // parked at the scale's start so the dash still has a place to show
  });

  it("dims the figure when it is stale or recorded nothing", () => {
    expect(gauge().series[0].detail.color).toBeUndefined();
    expect(gauge({ muted: true }).series[0].detail.color).toBe(MUTED_FIGURE); // the stat's muted colour, which reads at 4.5:1
  });

  it("renders the fetched value, a live value for a live gauge, and ignores the stream when not live", () => {
    const cfg = config({ aggregation: "last", min: 0, max: 200 });
    const data = valuesData({ type: "gauge" });
    const { unmount } = render(<GaugeWidget data={data} config={cfg} live={false} />);
    expect(screen.getByTestId("chart").textContent).toContain('"value":10.5');
    unmount();
    render(<LiveValuesContext.Provider value={stream(33.5)}><GaugeWidget data={data} config={cfg} live /></LiveValuesContext.Provider>);
    expect(screen.getByTestId("chart").textContent).toContain('"value":33.5');
    expect(screen.getByTestId("chart").textContent).toContain('"max":200');
  });

  it("goes back to the fetched value when the stream has dropped, and draws no needle when the live reading went bad", () => {
    const cfg = config({ aggregation: "last", min: 0, max: 200 });
    const data = valuesData({ type: "gauge" });
    const { unmount } = render(<LiveValuesContext.Provider value={stream(33.5, 0, false)}><GaugeWidget data={data} config={cfg} live /></LiveValuesContext.Provider>);
    expect(screen.getByTestId("chart").textContent).toContain('"value":10.5');
    unmount();
    render(<LiveValuesContext.Provider value={stream(7, 1)}><GaugeWidget data={data} config={cfg} live /></LiveValuesContext.Provider>);
    expect(screen.getByTestId("chart").textContent).toContain('"pointer":{"show":false}');
  });

  it("says how old a stale reading is", () => {
    const cfg = config({ aggregation: "last" });
    render(<GaugeWidget data={valuesData({ type: "gauge", values: [valueRow({ ts: minutesAgo(12), stale: true })] })} config={cfg} live={false} />);
    expect(screen.getByText("12 min ago")).toBeInTheDocument();
  });
});

describe("stat", () => {
  it("shows the figure, its unit and the asset", () => {
    render(<StatWidget data={valuesData()} live={false} />);
    expect(screen.getByText("10.50")).toBeInTheDocument();
    expect(screen.getByText("kW")).toBeInTheDocument();
    expect(screen.getByText("LV Panel 1")).toBeInTheDocument();
    expect(screen.getByText("10.50")).not.toHaveClass("muted");
  });

  it("marks estimated (~) and partial (*) figures and says what the markers mean", () => {
    const row = valueRow({ value: 12.3, estimated: true, partial: true, point_id: null });
    render(<StatWidget data={valuesData({ source: "cost", unit: "QAR", values: [row] })} live={false} />);
    expect(screen.getByText("~12.30*")).toBeInTheDocument();
    expect(screen.getByText("QAR")).toBeInTheDocument();
    expect(screen.getByText("~ estimated, * partial, some hours have no rate")).toBeInTheDocument();
  });

  it("shows a dash when there is no figure or no asset", () => {
    const row = valueRow({ value: null, estimated: true, point_id: null });
    const { unmount } = render(<StatWidget data={valuesData({ values: [row] })} live={false} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    unmount();
    render(<StatWidget data={valuesData({ values: [] })} live={false} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("mutes a figure that recorded nothing, and says so in its title", () => {
    render(<StatWidget data={valuesData({ source: "energy", metric: null, unit: "kWh", values: [valueRow({ value: 0, no_data: true, point_id: null })] })} live={false} />);
    expect(screen.getByText("0.00")).toHaveClass("muted");
    expect(screen.getByText("0.00")).toHaveAttribute("title", "no data");
  });

  it("says 'no data' for a metric with no reading, not the dash that means a missing rate", () => {
    render(<StatWidget data={valuesData({ values: [valueRow({ value: null, no_data: true, point_id: null })] })} live={false} />);
    const big = screen.getByTitle("no data");
    expect(big).toHaveClass("muted");
    expect(big).toHaveTextContent(/^no data$/);
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("keeps the muted dash for a cost without a rate that also recorded nothing, as Billing does, and titles it", () => {
    render(<StatWidget data={valuesData({ source: "cost", metric: null, unit: "QAR", values: [valueRow({ value: null, no_data: true, point_id: null })] })} live={false} />);
    const big = screen.getByTitle("no data");
    expect(big).toHaveClass("muted");
    expect(big).toHaveTextContent("—");
  });

  it("gives a measured figure no title", () => {
    render(<StatWidget data={valuesData()} live={false} />);
    expect(screen.getByText("10.50")).not.toHaveAttribute("title");
  });

  it("dims a stale reading and says how old it is", () => {
    render(<StatWidget data={valuesData({ values: [valueRow({ ts: minutesAgo(12), stale: true })] })} live={false} />);
    expect(screen.getByText("10.50")).toHaveClass("muted");
    expect(screen.getByText("12 min ago")).toBeInTheDocument();
  });

  it("shows no age for a fresh reading", () => {
    render(<StatWidget data={valuesData({ values: [valueRow({ ts: minutesAgo(0), stale: false })] })} live={false} />);
    expect(screen.queryByText(/ago|just now/)).not.toBeInTheDocument();
  });

  it("follows the stream only when live", () => {
    const { unmount } = render(<LiveValuesContext.Provider value={stream(11.25)}><StatWidget data={valuesData()} live /></LiveValuesContext.Provider>);
    expect(screen.getByText("11.25")).toBeInTheDocument();
    unmount();
    render(<LiveValuesContext.Provider value={stream(11.25)}><StatWidget data={valuesData()} live={false} /></LiveValuesContext.Provider>);
    expect(screen.getByText("10.50")).toBeInTheDocument();
  });

  it("says 'no data' when the live reading is bad, exactly as for a fetched row that recorded nothing", () => {
    const silent = valuesData({ values: [valueRow({ value: null, no_data: true })] });
    const fetched = render(<StatWidget data={silent} live={false} />);
    const before = screen.getByTitle("no data");
    const shown = { text: before.textContent, muted: before.classList.contains("muted") };
    fetched.unmount();
    // a good fetch, then a bad stream sample: the meter's reads are failing
    render(<LiveValuesContext.Provider value={stream(7, 1)}><StatWidget data={valuesData()} live /></LiveValuesContext.Provider>);
    const after = screen.getByTitle("no data");
    expect(after.textContent).toBe("no data");
    expect({ text: after.textContent, muted: after.classList.contains("muted") }).toEqual(shown);
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("goes back to the fetched figure when the stream has dropped", () => {
    render(<LiveValuesContext.Provider value={stream(11.25, 0, false)}><StatWidget data={valuesData()} live /></LiveValuesContext.Provider>);
    expect(screen.getByText("10.50")).toBeInTheDocument();
  });

  it("treats a streamed value as fresh and takes its age from the stream, whatever the fetched row says", () => {
    const row = valueRow({ ts: "2026-10-08T10:20:00.000000+03:00", stale: true, no_data: false });
    render(<LiveValuesContext.Provider value={stream(11.25, 0, true, "2026-10-08T07:30:00.000Z")}><StatWidget data={valuesData({ values: [row] })} live /></LiveValuesContext.Provider>);
    expect(screen.getByText("11.25")).not.toHaveClass("muted");
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument();
  });

  it("keeps the fetched, newer reading and its staleness when the stream entry is older", () => {
    const row = valueRow({ ts: "2026-10-08T10:20:00.000000+03:00", stale: true });
    render(<LiveValuesContext.Provider value={stream(11.25, 0, true, "2026-10-08T07:10:00.000Z")}><StatWidget data={valuesData({ values: [row] })} live /></LiveValuesContext.Provider>);
    expect(screen.getByText("10.50")).toHaveClass("muted");
    expect(screen.getByText(/ago/)).toBeInTheDocument();
  });
});

describe("table", () => {
  it("lists one row per asset with markers and dashes", () => {
    const data = valuesData({ type: "table", unit: "kWh", source: "energy", metric: null, values: [
      valueRow({ name: "LV Panel 1", value: 10.5, point_id: null }),
      valueRow({ asset_id: 6, name: "LV Panel 2", value: 4.25, estimated: true, point_id: null }),
      valueRow({ asset_id: 7, name: "LV Panel 3", value: null, point_id: null }),
    ] });
    render(<TableWidget data={data} />);
    expect(screen.getByRole("columnheader", { name: "Value (kWh)" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /LV Panel 1/ })).toHaveTextContent("10.50");
    expect(screen.getByRole("row", { name: /LV Panel 2/ })).toHaveTextContent("~4.25");
    expect(screen.getByRole("row", { name: /LV Panel 3/ })).toHaveTextContent("—");
    expect(screen.getByText("~ estimated")).toBeInTheDocument();
  });

  it("mutes the figure of an asset that recorded nothing and dims a stale reading with its age", () => {
    const data = valuesData({ type: "table", values: [
      valueRow({ name: "Quiet", value: 0, no_data: true, point_id: null }),
      valueRow({ asset_id: 6, name: "Old", value: 3, ts: minutesAgo(12), stale: true }),
      valueRow({ asset_id: 7, name: "Fresh", value: 4 }),
    ] });
    render(<TableWidget data={data} />);
    expect(screen.getByRole("row", { name: /Quiet/ }).lastElementChild).toHaveClass("muted");
    expect(screen.getByRole("row", { name: /Old/ }).lastElementChild).toHaveClass("muted");
    expect(screen.getByRole("row", { name: /Old/ })).toHaveTextContent("12 min ago");
    expect(screen.getByRole("row", { name: /Fresh/ }).lastElementChild).not.toHaveClass("muted");
  });

  it("says 'no data' with a title for a metric with no reading, and titles a muted zero", () => {
    const rows = [
      valueRow({ name: "Silent", value: null, no_data: true, point_id: null }),
      valueRow({ asset_id: 6, name: "Zero", value: 0, no_data: true, point_id: null }),
      valueRow({ asset_id: 7, name: "Fine", value: 4, point_id: null }),
    ];
    render(<TableWidget data={valuesData({ type: "table", values: rows })} />);
    const cell = (name: RegExp) => screen.getByRole("row", { name }).lastElementChild!;
    expect(cell(/Silent/)).toHaveTextContent(/^no data$/);
    expect(cell(/Silent/)).toHaveClass("muted");
    expect(cell(/Silent/)).toHaveAttribute("title", "no data");
    expect(cell(/Zero/)).toHaveTextContent("0.00");
    expect(cell(/Zero/)).toHaveAttribute("title", "no data");
    expect(cell(/Fine/)).not.toHaveAttribute("title");
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("keeps the muted dash, titled, for a cost without a rate that also recorded nothing", () => {
    const rows = [valueRow({ name: "Unpriced", value: null, no_data: true, point_id: null })];
    render(<TableWidget data={valuesData({ type: "table", source: "cost", metric: null, unit: "QAR", values: rows })} />);
    const cell = screen.getByRole("row", { name: /Unpriced/ }).lastElementChild!;
    expect(cell).toHaveTextContent("—");
    expect(cell).toHaveClass("muted");
    expect(cell).toHaveAttribute("title", "no data");
  });

  it("says so when there are no assets", () => {
    render(<TableWidget data={valuesData({ type: "table", values: [] })} />);
    expect(screen.getByText("No assets.")).toBeInTheDocument();
  });
});
