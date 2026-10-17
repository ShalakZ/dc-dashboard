import { render, screen } from "@testing-library/react";
import { config, valueRow, valuesData } from "../../../test/dashboardFixtures";
import { LiveValuesContext } from "../LiveValuesContext";
import { GaugeWidget, gaugeFillPath } from "./GaugeWidget";
import { StatWidget } from "./StatWidget";
import { TableWidget } from "./TableWidget";

const stream = (value: number | null, quality = 0, connected = true, ts = "2026-10-08T06:00:00.000Z") => ({
  values: new Map([[7, { ts, value, quality }]]), connected, register: () => {},
});
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const bigOf = (text: string) => screen.getByText(text).closest(".big")!; // the figure sits in span.stat-num inside div.big

// The gauge's own cases (the arc, the meter attributes, the no-data words) are in GaugeWidget.test.tsx; these are the ones that go through the stream.
describe("gauge", () => {
  const cfg = config({ aggregation: "last", min: 0, max: 200 });
  const reading = () => screen.getByRole("meter");
  const fillOf = (container: HTMLElement) => container.querySelector("path.gauge-fill")?.getAttribute("d");

  it("renders the fetched value, a live value for a live gauge, and ignores the stream when not live", () => {
    const data = valuesData({ type: "gauge" });
    const { unmount } = render(<GaugeWidget data={data} config={cfg} live={false} />);
    expect(reading()).toHaveAttribute("aria-valuenow", "10.5");
    expect(screen.getByText("10.50")).toBeInTheDocument();
    unmount();
    const live = render(<LiveValuesContext.Provider value={stream(33.5)}><GaugeWidget data={data} config={cfg} live /></LiveValuesContext.Provider>);
    expect(reading()).toHaveAttribute("aria-valuenow", "33.5");
    expect(reading()).toHaveAttribute("aria-valuemax", "200");
    expect(screen.getByText("33.50")).toBeInTheDocument();
    expect(fillOf(live.container)).toBe(gaugeFillPath(33.5 / 200));
    live.unmount();
    render(<LiveValuesContext.Provider value={stream(33.5)}><GaugeWidget data={data} config={cfg} live={false} /></LiveValuesContext.Provider>);
    expect(reading()).toHaveAttribute("aria-valuenow", "10.5");
  });

  it("goes back to the fetched value when the stream has dropped, and draws no fill when the live reading went bad", () => {
    const data = valuesData({ type: "gauge" });
    const { unmount } = render(<LiveValuesContext.Provider value={stream(33.5, 0, false)}><GaugeWidget data={data} config={cfg} live /></LiveValuesContext.Provider>);
    expect(reading()).toHaveAttribute("aria-valuenow", "10.5");
    unmount();
    const bad = render(<LiveValuesContext.Provider value={stream(7, 1)}><GaugeWidget data={data} config={cfg} live /></LiveValuesContext.Provider>);
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(bad.container.querySelector("path.gauge-fill")).toBeNull();
  });

  it("says how old a stale reading is", () => {
    render(<GaugeWidget data={valuesData({ type: "gauge", values: [valueRow({ ts: minutesAgo(12), stale: true })] })} config={config({ aggregation: "last" })} live={false} />);
    expect(screen.getByText("12 min ago")).toBeInTheDocument();
  });
});

describe("stat", () => {
  it("shows the figure, its unit and the asset", () => {
    render(<StatWidget data={valuesData()} live={false} />);
    expect(screen.getByText("10.50")).toBeInTheDocument();
    expect(screen.getByText("kW")).toBeInTheDocument();
    expect(screen.getByText("LV Panel 1")).toBeInTheDocument();
    expect(bigOf("10.50")).not.toHaveClass("muted");
  });

  it("draws the figure, the unit and the name in the classes of the stylesheet", () => {
    const { container } = render(<StatWidget data={valuesData()} live={false} />);
    expect(container.querySelector(".stat > .big > .stat-num")).toHaveTextContent("10.50");
    expect(container.querySelector(".stat > .big > small.stat-unit")).toHaveTextContent("kW");
    expect(container.querySelector(".stat > .stat-name")).toHaveTextContent("LV Panel 1");
    expect(container.querySelector(".big")).toHaveTextContent("10.50 kW");
    expect(container.querySelector(".stat-age")).toBeNull();
  });

  it("marks estimated (~) and partial (*) figures; the hint that explains them is the frame's footer, not drawn here", () => {
    const row = valueRow({ value: 12.3, estimated: true, partial: true, point_id: null });
    render(<StatWidget data={valuesData({ source: "cost", unit: "QAR", values: [row] })} live={false} />);
    expect(screen.getByText("~12.30*")).toBeInTheDocument();
    expect(screen.getByText("QAR")).toBeInTheDocument();
    expect(screen.queryByText(/estimated|partial|no rate/)).not.toBeInTheDocument();
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
    expect(bigOf("0.00")).toHaveClass("muted");
    expect(bigOf("0.00")).toHaveAttribute("title", "no data");
  });

  it("says 'no data' for a metric with no reading, not the dash that means a missing rate", () => {
    render(<StatWidget data={valuesData({ values: [valueRow({ value: null, no_data: true, point_id: null })] })} live={false} />);
    const big = screen.getByTitle("no data");
    expect(big).toHaveClass("muted", "none"); // words, not a measurement: the stylesheet draws them small
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
    expect(bigOf("10.50")).not.toHaveAttribute("title");
  });

  it("dims a stale reading and says how old it is", () => {
    render(<StatWidget data={valuesData({ values: [valueRow({ ts: minutesAgo(12), stale: true })] })} live={false} />);
    expect(bigOf("10.50")).toHaveClass("muted");
    expect(bigOf("10.50")).not.toHaveClass("none");
    expect(screen.getByText("12 min ago")).toBeInTheDocument();
  });

  it("puts the age of a stale reading on its own line, behind a clock", () => {
    const { container } = render(<StatWidget data={valuesData({ values: [valueRow({ ts: minutesAgo(12), stale: true })] })} live={false} />);
    const age = container.querySelector(".stat > .stat-age")!;
    expect(age).toHaveTextContent("12 min ago");
    expect(age.querySelector("svg.i")).toHaveAttribute("aria-hidden", "true");
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
    expect(bigOf("11.25")).not.toHaveClass("muted");
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument();
  });

  it("keeps the fetched, newer reading and its staleness when the stream entry is older", () => {
    const row = valueRow({ ts: "2026-10-08T10:20:00.000000+03:00", stale: true });
    render(<LiveValuesContext.Provider value={stream(11.25, 0, true, "2026-10-08T07:10:00.000Z")}><StatWidget data={valuesData({ values: [row] })} live /></LiveValuesContext.Provider>);
    expect(bigOf("10.50")).toHaveClass("muted");
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
    expect(screen.queryByText(/estimated/)).not.toBeInTheDocument(); // the hint is the frame's footer now
  });

  it("is a widget table with the value column, head and cells, right aligned", () => {
    const { container } = render(<TableWidget data={valuesData({ type: "table", unit: "kW" })} />);
    expect(container.querySelector("table.widget-table")).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "Asset" })).not.toHaveClass("num");
    expect(screen.getByRole("columnheader", { name: "Value (kW)" })).toHaveClass("num");
    const row = screen.getByRole("row", { name: /LV Panel 1/ });
    expect(row.firstElementChild).not.toHaveClass("num");
    expect(row.lastElementChild).toHaveClass("num");
    expect(container.querySelector("p")).toBeNull(); // no hint paragraph under the table
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
    expect(screen.getByRole("row", { name: /Old/ }).querySelector("td .cell-age")).toHaveTextContent("12 min ago");
    expect(screen.getByRole("row", { name: /Fresh/ }).querySelector(".cell-age")).toBeNull();
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
