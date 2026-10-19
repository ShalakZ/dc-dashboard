import { render, screen } from "@testing-library/react";
import {
  compareAsset, compareBlock, compareChange, compareSide, compareStatData, config, valueRow, valuesData,
} from "../../../test/dashboardFixtures";
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

describe("stat, compared with the same days of last month (w24)", () => {
  const show = (data = compareStatData()) => render(<StatWidget data={data} live={false} />);
  const text = (container: HTMLElement, selector: string) => container.querySelector(selector)?.textContent;
  const withAsset = (over: Parameters<typeof compareAsset>[0], block: Parameters<typeof compareBlock>[0] = {}, data: Parameters<typeof compareStatData>[0] = {}) =>
    compareStatData({ compare: compareBlock({ ...block, assets: [compareAsset(over)] }), ...data });

  it("draws the headline as before, then the window, last month's same days with their window, the change and an empty reserved note line", () => {
    const { container } = show();
    expect(container.querySelector(".stat.stat-compare > .big > .stat-num")).toHaveTextContent("1500.00");
    expect(container.querySelector(".big")).toHaveTextContent("1500.00 kWh");
    expect(container.querySelector(".stat-name")).toHaveTextContent("LV Panel 1");
    const windows = [...container.querySelectorAll(".stat-window")].map((el) => el.textContent);
    expect(windows).toEqual(["1 to 17 Oct", "1 to 17 Sep"]);
    expect(text(container, ".stat-last-label")).toBe("Same days last month");
    expect(container.querySelector(".stat-last-label")).toHaveAttribute("title", "Same days last month"); // the label can never be cut without its full text on hand
    expect(text(container, ".stat-last-fig")).toBe("1300.00 kWh");
    expect(text(container, ".stat-change")).toBe("up 15.4 % (+200.00 kWh)");
    const note = container.querySelector(".stat-note");
    expect(note).not.toBeNull(); // the slot is there with nothing in it, so a note appearing moves nothing
    expect(note).toBeEmptyDOMElement();
  });

  it("orders the rows: figure, name, window, last month, its window, change, note", () => {
    const { container } = show();
    const classes = [...container.querySelector(".stat")!.children].map((el) => el.className.split(" ")[0]);
    expect(classes).toEqual(["big", "stat-name", "stat-window", "stat-last", "stat-window", "stat-change", "stat-note"]);
  });

  it("compares cost with the currency, and shows the marks of each side where they belong", () => {
    const data = withAsset(
      { this: compareSide({ cost: 4.5, estimated: true, partial: true }), last: compareSide({ cost: 3, partial: true }), cost: compareChange({ abs: 1.5, why_none: "partial" }) },
      {}, { source: "cost", unit: "QAR", values: [valueRow({ value: 4.5, estimated: true, partial: true, point_id: null })] },
    );
    const { container } = show(data);
    expect(container.querySelector(".big")).toHaveTextContent("~4.50* QAR");
    expect(text(container, ".stat-last-fig")).toBe("3.00* QAR");
    expect(text(container, ".stat-change")).toBe("up ~1.50* QAR"); // the change carries the marks of the figures it is made from
    expect(text(container, ".stat-note")).toBe("No percentage: some of the cost has no rate.");
  });

  it("carries ~ on the change when a side is estimated, on the percentage and on the amount, and never a star on kWh", () => {
    const energy = withAsset({ this: compareSide({ kwh: 1500, estimated: true, partial: true }), kwh: compareChange({ abs: -294.32, percent: -0.2 }) });
    expect(text(show(energy).container, ".stat-change")).toBe("down ~0.2 % (~-294.32 kWh)");
  });

  it("carries * on a partial cost's change even when the percentage is withheld, and ~ and * together", () => {
    const partial = withAsset(
      { this: compareSide({ cost: 4.5, partial: true }), cost: compareChange({ abs: 1.5, why_none: "partial" }) },
      {}, { source: "cost", unit: "QAR", values: [valueRow({ value: 4.5, partial: true, point_id: null })] },
    );
    expect(text(show(partial).container, ".stat-change")).toBe("up 1.50* QAR");
  });

  it("says nothing of a missing rate for a currency change: the last month's figure is a dash and the note tells the truth", () => {
    const data = withAsset(
      { last: compareSide({ cost: null }), cost: compareChange({ why_none: "currency" }) },
      { last_month: { month: "2026-09", closed: true } }, { source: "cost", unit: "QAR" },
    );
    const { container } = show(data);
    expect(text(container, ".stat-last-fig")).toBe("—");
    expect(text(container, ".stat-change")).toBe("—");
    expect(text(container, ".stat-note")).toContain("No cost comparison: the currency changed since last month closed.");
    expect(container.textContent).not.toContain("no rate");
  });

  it("says both months when neither has readings", () => {
    const none = compareSide({ kwh: 0, no_data_days: 17 });
    const { container } = show(withAsset({ this: none, last: none, last_state: "no_readings", kwh: compareChange({ why_none: "no_previous" }) }));
    expect(text(container, ".stat-note")).toBe("No readings this month or last month.");
  });

  it("marks an estimated kWh side with ~ and never with a star, even when its cost is partial", () => {
    const { container } = show(withAsset({ last: compareSide({ kwh: 1300, estimated: true, partial: true }) }));
    expect(text(container, ".stat-last-fig")).toBe("~1300.00 kWh");
  });

  it("shows one line for the notes: the reason first, how many more wait in Details, and every note in the title", () => {
    const data = withAsset(
      { cost: compareChange({ abs: 4, why_none: "partial" }), rate_change: { date: "2026-10-05" } },
      { left_out_days: ["2026-10-31"], last_month: { month: "2026-09", closed: true } },
      { source: "cost", unit: "QAR" },
    );
    const { container } = show(data);
    const note = container.querySelector(".stat-note")!;
    expect(note).toHaveTextContent("No percentage: some of the cost has no rate. (+3 more in Details)");
    expect(note.getAttribute("title")).toContain("A rate changed on 5 Oct, so the cost change is not only usage.");
    expect(note.getAttribute("title")).toContain("31 October has no matching day in September.");
    expect(note.getAttribute("title")).toContain("Last month is closed: these are its closed figures.");
  });

  it("gives the rate note only to cost", () => {
    const { container } = show(withAsset({ rate_change: { date: "2026-10-05" } }));
    expect(text(container, ".stat-note")).toBe("");
  });

  it("says why a percentage is withheld, and shows the amount alone", () => {
    const data = withAsset({ last: compareSide({ kwh: 1300, no_data_days: 3 }), kwh: compareChange({ abs: 200, why_none: "missing_days" }) });
    const { container } = show(data);
    expect(text(container, ".stat-change")).toBe("up 200.00 kWh");
    expect(text(container, ".stat-note")).toBe("No percentage: last month has no readings on 3 of the 17 days.");
  });

  it("says no change for an amount that is nothing at the shown precision", () => {
    const { container } = show(withAsset({ kwh: compareChange({ abs: 0, percent: 0 }) }));
    expect(text(container, ".stat-change")).toBe("no change");
  });

  it("draws a dash, never a zero, for a last month without readings, and the reason", () => {
    const { container } = show(withAsset({ last: compareSide({ kwh: 0, no_data_days: 17 }), kwh: compareChange({ why_none: "no_previous" }) }));
    expect(text(container, ".stat-last-fig")).toBe("—");
    expect(text(container, ".stat-change")).toBe("—");
    expect(text(container, ".stat-note")).toBe("No readings last month.");
  });

  it("says a closed month's asset is not in its closed figures, instead of the percentage's reason", () => {
    const data = withAsset({ last: null, last_state: "not_in_closed", kwh: compareChange({ why_none: "no_previous" }) }, { last_month: { month: "2026-09", closed: true } });
    const { container } = show(data);
    expect(text(container, ".stat-last-fig")).toBe("—");
    expect(text(container, ".stat-note")).toBe("Not in last month's closed figures.");
  });

  it("says a closed month on its own", () => {
    const { container } = show(withAsset({}, { last_month: { month: "2026-09", closed: true } }));
    expect(text(container, ".stat-note")).toBe("Last month is closed: these are its closed figures.");
  });

  it("says only 'Nothing to compare yet' on the first of the month", () => {
    const { container } = show(compareStatData({ compare: compareBlock({ state: "nothing_yet", elapsed_days: 0, days: 0, this_window: null, last_window: null, assets: [] }), values: [] }));
    expect(container.querySelector(".stat")).toHaveTextContent(/^Nothing to compare yet$/);
    expect(container.querySelector(".big")).toBeNull();
  });

  it("falls back to the plain stat when the asset is gone (the comparison has no asset and the answer no row)", () => {
    const { container } = show(compareStatData({ compare: compareBlock({ assets: [] }), values: [] }));
    expect(container.querySelector(".stat-num")).toHaveTextContent("—");
    expect(container.querySelector(".stat-last")).toBeNull();
  });

  it("is exactly the old stat when there is no comparison", () => {
    const { container } = render(<StatWidget data={valuesData({ compare: null, breakdown: null })} live={false} />);
    expect(container.querySelector(".stat")).not.toHaveClass("stat-compare");
    expect(container.querySelector(".stat-last, .stat-change, .stat-note, .stat-window")).toBeNull();
  });
});
