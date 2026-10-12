import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useAppearance } from "../auth/AppearanceProvider";
import { CHART_HEIGHT } from "../lib/chartBox";
import { mockFetch } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { seriesToOption, TrendChart } from "./TrendChart";

// The mock records every option the chart is given; JSON.stringify in the DOM would drop the formatter functions.
const captured = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock("echarts-for-react", () => ({
  default: (props: { option: unknown }) => {
    captured.options.push(props.option);
    return <pre data-testid="chart">{JSON.stringify(props.option)}</pre>;
  },
}));

const siteRoute = { "GET /api/site": { body: { timezone: "Asia/Qatar", currency: "QAR" } } };

const series = {
  metric: "active_power_kw", unit: "kW",
  points: [{ ts: "2026-10-07T10:00:00+00:00", avg: 1, min: 0.5, max: 1.5 }, { ts: "2026-10-07T10:01:00+00:00", avg: 2, min: 1, max: 3 }],
};
const metrics = [{ mapping_id: 1, point_id: 7, metric: "active_power_kw" as const, unit: "kW", value: 1, ts: null, quality: 0 }];

describe("seriesToOption", () => {
  it("draws avg with gaps and a min/max band in the unit", () => {
    const minuteBuckets = { start: "2026-10-07T10:00:00Z", end: "2026-10-07T15:00:00Z", buckets: 300 };
    const option = seriesToOption(series as never, "1h", minuteBuckets) as { series: { name: string; data: unknown[]; connectNulls?: boolean }[]; yAxis: { name: string }; xAxis: { name?: string } };
    expect(option.yAxis.name).toBe("kW");
    expect(option.xAxis.name).toBeUndefined();
    const avg = option.series.find((s) => s.name === "avg")!;
    expect(avg.connectNulls).toBe(false);
    expect(avg.data).toEqual([["2026-10-07T10:00:00+00:00", 1], ["2026-10-07T10:01:00+00:00", 2]]);
    expect(option.series.map((s) => s.name)).toEqual(["min", "max", "avg"]);
  });
});

describe("seriesToOption appearance", () => {
  const T1 = "2026-10-07T10:00:00+00:00";
  const T2 = "2026-10-07T10:01:00+00:00";
  const minuteBuckets = { start: "2026-10-07T10:00:00Z", end: "2026-10-07T15:00:00Z", buckets: 300 };
  type Dark = {
    backgroundColor?: string;
    tooltip: { backgroundColor?: string; borderColor?: string; textStyle?: { color: string } };
    xAxis: Record<string, { color?: string; lineStyle?: { color: string } }>;
    yAxis: Record<string, { color?: string; lineStyle?: { color: string } }>;
    series: { name: string; color?: string; areaStyle?: { color: string; opacity: number } }[];
  };

  // The option as it was before the dark parameter existed: a chart in light mode must not change by a single key.
  it("returns today's option, key for key, when dark is false or left out", () => {
    const today = {
      animation: false,
      useUTC: true,
      tooltip: { trigger: "axis", formatter: expect.any(Function) },
      grid: { left: 60, right: 20, top: 30, bottom: 40 },
      xAxis: { type: "time", axisLabel: { formatter: expect.any(Function) } },
      yAxis: { type: "value", name: "kW", scale: true },
      series: [
        { name: "min", type: "line", data: [[T1, 0.5], [T2, 1]], lineStyle: { opacity: 0 }, symbol: "none", stack: "band", connectNulls: false },
        { name: "max", type: "line", data: [[T1, 1], [T2, 2]], lineStyle: { opacity: 0 }, symbol: "none", stack: "band", areaStyle: { color: "#000", opacity: 0.1 }, connectNulls: false },
        { name: "avg", type: "line", data: [[T1, 1], [T2, 2]], symbol: "none", color: "#000", connectNulls: false },
      ],
    };
    expect(seriesToOption(series as never, "1h", minuteBuckets)).toStrictEqual(today);
    expect(seriesToOption(series as never, "1h", minuteBuckets, "UTC", false)).toStrictEqual(today);
  });

  it("paints the axes, the unit name, the lines, the band and the tooltip in light-on-dark colours when dark is true", () => {
    const o = seriesToOption(series as never, "1h", minuteBuckets, "UTC", true) as unknown as Dark;
    expect(o.backgroundColor).toBe("transparent");
    for (const axis of [o.xAxis, o.yAxis]) {
      expect(axis.axisLabel.color).toBe("#a3abb8");
      expect(axis.axisLine.lineStyle!.color).toBe("#3a414d");
      expect(axis.axisTick.lineStyle!.color).toBe("#3a414d");
      expect(axis.splitLine.lineStyle!.color).toBe("#2b313b");
    }
    expect(o.yAxis.nameTextStyle.color).toBe("#a3abb8"); // the unit name: ECharts' own default (#6E7079) is 3.6:1 on the dark page
    expect(o.series.find((s) => s.name === "avg")!.color).toBe("#e4e7ed");
    expect(o.series.find((s) => s.name === "max")!.areaStyle).toEqual({ color: "#e4e7ed", opacity: 0.12 });
    expect(o.tooltip).toMatchObject({ backgroundColor: "#1f232b", borderColor: "#3a414d", textStyle: { color: "#e4e7ed" } });
  });

  it("keeps the data, the unit, the site-zone ticks and the tooltip text in dark", () => {
    const light = seriesToOption(series as never, "1h", minuteBuckets, "Asia/Qatar") as unknown as { yAxis: { name: string }; xAxis: { axisLabel: { formatter: (v: number) => string } }; series: unknown[]; tooltip: { formatter: (v: unknown) => string } };
    const dark = seriesToOption(series as never, "1h", minuteBuckets, "Asia/Qatar", true) as unknown as typeof light;
    const at = Date.parse("2026-10-06T21:00:00Z");
    expect(dark.yAxis.name).toBe("kW");
    expect(dark.xAxis.axisLabel.formatter(at)).toBe(light.xAxis.axisLabel.formatter(at));
    expect(dark.tooltip.formatter([{ axisValue: at, seriesName: "avg", value: [at, 2] }])).toBe(light.tooltip.formatter([{ axisValue: at, seriesName: "avg", value: [at, 2] }]));
    expect(dark.series.map((s) => (s as { data: unknown }).data)).toEqual(light.series.map((s) => (s as { data: unknown }).data));
  });
});

describe("seriesToOption gaps", () => {
  type Opt = { series: { name: string; data: [string, number | null][] }[] };
  const T0 = Date.parse("2026-10-07T10:00:00Z");
  const point = (offsetWidths: number, width: number) => {
    const ts = new Date(T0 + offsetWidths * width).toISOString();
    return { ts, avg: 1, min: 0.5, max: 1.5 };
  };

  it("inserts a null point when consecutive buckets are more than one width apart", () => {
    const width = 60_000; // 300 buckets over 5h
    const start = new Date(T0).toISOString();
    const end = new Date(T0 + 300 * width).toISOString();
    // A gap is judged against the series' normal step (the median), which needs more than one step to know:
    // the steps are 1, 1, 1, 3, 1 widths, median 1 width. The last two points are adjacent, so neither is alone.
    const gapped = { ...series, points: [point(0, width), point(1, width), point(2, width), point(3, width), point(6, width), point(7, width)] };
    const option = seriesToOption(gapped as never, "1h", { start, end, buckets: 300 }) as Opt;
    const avg = option.series.find((s) => s.name === "avg")!.data;
    expect(avg.map(([, v]) => v)).toEqual([1, 1, 1, 1, null, 1, 1]);
    expect(avg[4][0]).toBe(new Date(T0 + 4 * width).toISOString());
    for (const name of ["min", "max"]) {
      expect(option.series.find((s) => s.name === name)!.data[4][1]).toBeNull();
    }
  });

  it("leaves adjacent buckets alone", () => {
    const width = 60_000;
    const start = new Date(T0).toISOString();
    const end = new Date(T0 + 300 * width).toISOString();
    const dense = { ...series, points: [point(0, width), point(1, width), point(2, width)] };
    const option = seriesToOption(dense as never, "1h", { start, end, buckets: 300 }) as Opt;
    expect(option.series.find((s) => s.name === "avg")!.data.map(([, v]) => v)).toEqual([1, 1, 1]);
  });
});

describe("seriesToOption on a grid finer than the data", () => {
  type Row = [string, number | null] | { value: [string, number | null]; symbol: string; symbolSize: number };
  const T0 = Date.parse("2026-10-07T10:00:00Z");
  // 1 hour in 300 buckets = a 12 s grid, as the 1h range asks for
  const query = { start: new Date(T0).toISOString(), end: new Date(T0 + 3_600_000).toISOString(), buckets: 300 };
  const at = (seconds: number) => ({ ts: new Date(T0 + seconds * 1000).toISOString(), avg: 5, min: 4, max: 6 });
  const avgOf = (points: ReturnType<typeof at>[]) => {
    const option = seriesToOption({ metric: "energy_kwh", unit: "kWh", points } as never, "1h", query) as unknown as { series: { name: string; data: Row[] }[] };
    return option.series.find((s) => s.name === "avg")!.data;
  };

  it("draws a series sampled every 60 s as one line, with no gap rows between its points", () => {
    const data = avgOf([0, 60, 120, 180, 240, 300].map(at));
    expect(data).toHaveLength(6);
    expect(data.every((row) => Array.isArray(row) && row[1] === 5)).toBe(true);
  });

  it("still breaks the line at a real outage in such a series", () => {
    const data = avgOf([0, 60, 120, 180, 240, 840, 900].map(at)); // ten minutes missing
    expect(data.map((row) => (Array.isArray(row) ? row[1] : row.value[1]))).toEqual([5, 5, 5, 5, 5, null, 5, 5]);
  });

  it("gives a lone point a dot, so a one-point range is not an empty chart", () => {
    const data = avgOf([at(0)]);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ symbol: "circle", symbolSize: 6 });
  });

  it("an axis label for a value that is not a finite number is empty, not a thrown RangeError", () => {
    const option = seriesToOption({ metric: "energy_kwh", unit: "kWh", points: [at(0), at(60)] } as never, "1h", query) as unknown as { xAxis: { axisLabel: { formatter: (v: number) => string } } };
    expect(option.xAxis.axisLabel.formatter(Number.NaN)).toBe("");
    expect(option.xAxis.axisLabel.formatter(T0)).not.toBe("");
  });
});

describe("TrendChart", () => {
  it("requests the series for the chosen range", async () => {
    const calls = mockFetch({
      ...siteRoute,
      "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "v", role: "viewer" } },
      "GET /api/assets/4/series": { body: series },
    });
    renderWithProviders(<TrendChart assetId={4} metrics={metrics} />);
    await screen.findByTestId("chart");
    await userEvent.click(screen.getByRole("button", { name: "7d" }));
    expect(screen.getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "true");
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("metric=active_power_kw") && u.includes("buckets=300"))).toBe(true);
    expect(calls.filter((c) => c.path === "/api/assets/4/series").length).toBeGreaterThanOrEqual(2);
  });

  it("draws in the dark colours when the account's mode is dark, and redraws when the mode is switched", async () => {
    mockFetch({
      ...siteRoute,
      "GET /api/setup": { body: { needed: false } },
      "GET /api/me": { body: { id: 1, username: "v", role: "viewer", preferences: { mode: "light", theme: "navy-gold" } } },
      "PUT /api/me/preferences": { body: { mode: "dark", theme: "navy-gold" } },
      "GET /api/assets/4/series": { body: series },
    });
    captured.options.length = 0;
    function Switch() {
      const { setMode } = useAppearance();
      return <button onClick={() => setMode("dark")}>go dark</button>;
    }
    renderWithProviders(<><Switch /><TrendChart assetId={4} metrics={metrics} /></>);
    await screen.findByTestId("chart");
    expect(captured.options.at(-1)).not.toHaveProperty("backgroundColor");
    await userEvent.click(screen.getByRole("button", { name: "go dark" }));
    await waitFor(() => expect(captured.options.at(-1)).toHaveProperty("backgroundColor", "transparent"));
  });

  it("is a region named Trend, so a page (and a test) can find it by its name", async () => {
    mockFetch({
      ...siteRoute,
      "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "v", role: "viewer" } },
      "GET /api/assets/4/series": { body: series },
    });
    renderWithProviders(<TrendChart assetId={4} metrics={metrics} />);
    const region = await screen.findByRole("region", { name: "Trend" });
    expect(region).toContainElement(await screen.findByTestId("chart"));
  });

  it("is one framed region: the controls sit in a bar inside it, the range picker is a segmented group, and no section is nested in the region", async () => {
    mockFetch({
      ...siteRoute,
      "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "v", role: "viewer" } },
      "GET /api/assets/4/series": { body: series },
    });
    renderWithProviders(<TrendChart assetId={4} metrics={metrics} />);
    const region = await screen.findByRole("region", { name: "Trend" });
    expect(region).toHaveClass("trend-frame");
    expect(region.querySelectorAll("section")).toHaveLength(0);
    const group = screen.getByRole("group", { name: "Time range" });
    expect(group).toHaveClass("range-picker");
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["1h", "6h", "24h", "7d"]);
    expect(group.closest(".trend-bar")).not.toBeNull();
    expect(region).toContainElement(group.closest(".trend-bar") as HTMLElement);
  });

  it("labels the storage tier the series came from", async () => {
    mockFetch({
      ...siteRoute,
      "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "v", role: "viewer" } },
      "GET /api/assets/4/series": { body: { ...series, tier: "1h" } },
    });
    renderWithProviders(<TrendChart assetId={4} metrics={metrics} />);
    await screen.findByTestId("chart");
    expect(screen.getByText("1-hour rollup")).toBeInTheDocument();
  });

  it("offers a mapping picker when a metric has several mappings and requests the chosen one", async () => {
    const calls = mockFetch({
      ...siteRoute,
      "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "v", role: "viewer" } },
      "GET /api/assets/4/series": { body: series },
    });
    const two = [...metrics, { ...metrics[0], mapping_id: 7, point_id: 8 }];
    renderWithProviders(<TrendChart assetId={4} metrics={two} />);
    await screen.findByTestId("chart");
    // two mappings of one metric are one entry in the metric picker (a duplicate would also repeat a React key)
    expect(within(screen.getByLabelText("Metric")).getAllByRole("option").map((o) => o.textContent)).toEqual(["active_power_kw"]);
    // the empty option means "whatever the backend picks" (its lowest-id mapping), not every mapping
    expect(screen.getByRole("option", { name: "default" })).toHaveValue("");
    expect(screen.queryByRole("option", { name: "all" })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Mapping"), "7");
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("mapping_id=7"))).toBe(true);
    expect(calls.filter((c) => c.path === "/api/assets/4/series").length).toBeGreaterThanOrEqual(2);
  });
});

describe("seriesToOption in the site timezone", () => {
  type Opt = {
    useUTC: boolean;
    xAxis: { axisLabel: { formatter: (ms: number) => string } };
    tooltip: { formatter: (params: unknown) => string };
  };
  const midnightQatar = Date.parse("2026-10-06T21:00:00Z"); // 2026-10-07 00:00 in Asia/Qatar, the 6th at 21:00 in UTC

  it("labels ticks with the site's time of day, and with the date on a 7d range", () => {
    const day = seriesToOption(series as never, "24h", undefined, "Asia/Qatar") as unknown as Opt;
    const week = seriesToOption(series as never, "7d", undefined, "Asia/Qatar") as unknown as Opt;
    expect(day.xAxis.axisLabel.formatter(midnightQatar)).toBe("00:00");
    expect(week.xAxis.axisLabel.formatter(midnightQatar)).toBe("10-07 00:00");
    expect(day.useUTC).toBe(true); // tick positions must not depend on the browser's zone
  });

  it("prints the tooltip header in the site zone and a dash for a gap", () => {
    const option = seriesToOption(series as never, "24h", undefined, "Asia/Qatar") as unknown as Opt;
    const html = option.tooltip.formatter([
      { axisValue: midnightQatar, marker: "", seriesName: "avg", value: [midnightQatar, 2] },
      { axisValue: midnightQatar, marker: "", seriesName: "min", value: [midnightQatar, null] },
    ]);
    expect(html).toBe("2026-10-07 00:00:00<br/>avg: 2<br/>min: —");
  });
});

describe("the tooltip of the band", () => {
  type Opt = { tooltip: { formatter: (params: unknown) => string } };
  const at = Date.parse("2026-10-06T21:00:00Z");
  const item = (seriesName: string, value: number | null) => ({ axisValue: at, marker: "", seriesName, value: [at, value] });

  it("prints the real max, not the width of the band that is stacked on the min", () => {
    // the chart stacks "max" as max - min on top of "min" (here 2 - 0.5 = 1.5 on 0.5), so the raw item value is the width
    const option = seriesToOption(series as never, "24h", undefined, "Asia/Qatar") as unknown as Opt;
    const html = option.tooltip.formatter([item("min", 0.5), item("max", 1.5), item("avg", 1)]);
    expect(html).toBe("2026-10-07 00:00:00<br/>min: 0.5<br/>max: 2<br/>avg: 1");
  });

  it("shows a dash for the max of a gap, and adds nothing when the min is missing", () => {
    const option = seriesToOption(series as never, "24h", undefined, "Asia/Qatar") as unknown as Opt;
    expect(option.tooltip.formatter([item("min", null), item("max", null), item("avg", null)])).toBe("2026-10-07 00:00:00<br/>min: —<br/>max: —<br/>avg: —");
  });
});

describe("TrendChart site timezone", () => {
  beforeEach(() => { captured.options.length = 0; });

  /** Hold back GET /api/site until `release()` is called; everything else answers at once. */
  function holdSite(routes: Parameters<typeof mockFetch>[0]) {
    mockFetch(routes);
    const answer = fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes("/api/site") ? gate.then(() => answer(input, init)) : answer(input, init)));
    return release;
  }
  const routes = {
    "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "v", role: "viewer" } },
    "GET /api/assets/4/series": { body: series },
  };

  it("does not draw the axis in UTC while the site's zone is still loading", async () => {
    const release = holdSite({ ...siteRoute, ...routes });
    renderWithProviders(<TrendChart assetId={4} metrics={metrics} />);
    expect(await screen.findByText("raw samples")).toBeInTheDocument(); // the series has arrived
    expect(screen.getByText("Loading the chart").parentElement).toHaveAttribute("role", "status"); // the chart's box, not a bare line
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
    expect(captured.options).toHaveLength(0); // no chart was ever given an option, so none had the UTC axis
    release();
    await screen.findByTestId("chart");
    expect(captured.options.length).toBeGreaterThan(0);
    for (const option of captured.options as { xAxis: { axisLabel: { formatter: (ms: number) => string } } }[]) {
      expect(option.xAxis.axisLabel.formatter(Date.parse("2026-10-06T21:00:00Z"))).toBe("00:00"); // Asia/Qatar, never UTC's 21:00
    }
    expect(screen.queryByText("Loading the chart")).not.toBeInTheDocument();
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
  });

  it("says so, and draws no chart, when the site's zone cannot be read", async () => {
    mockFetch({ ...routes, "GET /api/site": { status: 500, body: { detail: "site unavailable" } } });
    renderWithProviders(<TrendChart assetId={4} metrics={metrics} />);
    expect(await screen.findByText("Could not load the site time zone: site unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
    expect(captured.options).toHaveLength(0);
  });


  it("draws the axis in the zone GET /api/site reports", async () => {
    mockFetch({
      ...siteRoute,
      "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "v", role: "viewer" } },
      "GET /api/assets/4/series": { body: series },
    });
    renderWithProviders(<TrendChart assetId={4} metrics={metrics} />);
    await waitFor(() => {
      const option = captured.options.at(-1) as { xAxis: { axisLabel: { formatter: (ms: number) => string } } };
      expect(option.xAxis.axisLabel.formatter(Date.parse("2026-10-06T21:00:00Z"))).toBe("00:00");
    });
  });
});

describe("TrendChart says when it was updated and pauses under a mouse", () => {
  const routes = {
    ...siteRoute,
    "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "v", role: "viewer" } },
    "GET /api/assets/4/series": { body: series },
  };
  const PAUSED = "(paused while you point at the chart)";

  beforeEach(() => {
    captured.options.length = 0;
    // Only Date is faked, so React Query, user-event and findBy keep their real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T10:05:00Z")); // 13:05:00 in Asia/Qatar
    // jsdom 26 has no PointerEvent: without this stub pointerType would be undefined and "mouse" could never be told from "touch".
    vi.stubGlobal("PointerEvent", class extends MouseEvent {
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerType = init.pointerType ?? ""; }
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  async function open() {
    mockFetch(routes);
    renderWithProviders(<TrendChart assetId={4} metrics={metrics} />);
    const section = (await screen.findByTestId("chart")).closest("section")!;
    return section;
  }
  /** Points at the section the way a pointer of this kind does, and returns the pointer types the DOM actually carried. */
  function point(section: HTMLElement, pointerType: string, action: "enter" | "leave") {
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as unknown as { pointerType: string }).pointerType);
    section.addEventListener(action === "enter" ? "pointerover" : "pointerout", listener);
    if (action === "enter") fireEvent.pointerEnter(section, { pointerType });
    else fireEvent.pointerLeave(section, { pointerType });
    section.removeEventListener(action === "enter" ? "pointerover" : "pointerout", listener);
    return seen;
  }

  it("says when the data was fetched, in the site zone", async () => {
    await open();
    expect(await screen.findByText("updated 13:05:00")).toBeInTheDocument();
  });

  it("pauses while a mouse is over the chart and resumes when it leaves", async () => {
    const section = await open();
    await screen.findByText("updated 13:05:00");
    expect(point(section, "mouse", "enter")).toEqual(["mouse"]);
    expect(screen.getByText(`updated 13:05:00 ${PAUSED}`)).toBeInTheDocument();
    point(section, "mouse", "leave");
    expect(screen.getByText("updated 13:05:00")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`paused while`))).not.toBeInTheDocument();
  });

  it("never pauses for a touch or a pen pointer", async () => {
    const section = await open();
    await screen.findByText("updated 13:05:00");
    expect(point(section, "touch", "enter")).toEqual(["touch"]); // the stub carried the type through, so this is a real touch event
    expect(point(section, "pen", "enter")).toEqual(["pen"]);
    expect(screen.getByText("updated 13:05:00")).toBeInTheDocument();
    expect(screen.queryByText(/paused while/)).not.toBeInTheDocument();
  });

  it("shows 'updating…' only while there is no data yet, not on a refetch", async () => {
    mockFetch(routes);
    renderWithProviders(<TrendChart assetId={4} metrics={metrics} />);
    expect(screen.getByText("updating…")).toBeInTheDocument();
    await screen.findByTestId("chart");
    await waitFor(() => expect(screen.queryByText("updating…")).not.toBeInTheDocument());
    // hold the next series answer and make React Query refetch (the tab becomes visible again)
    const answer = fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes("/series") ? new Promise<Response>(() => {}) : answer(input, init)));
    fireEvent(window, new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("updating…")).not.toBeInTheDocument();
    expect(screen.getByTestId("chart")).toBeInTheDocument();
  });

  it("gives the chart the identical option when the parent re-renders with the same data", async () => {
    mockFetch(routes);
    function Parent() {
      const [n, setN] = useState(0);
      return (
        <>
          <button onClick={() => setN(n + 1)}>tick {n}</button>
          <TrendChart assetId={4} metrics={metrics} />
        </>
      );
    }
    renderWithProviders(<Parent />);
    await screen.findByText("updated 13:05:00");
    await waitFor(() => expect(screen.getByTestId("chart")).toBeInTheDocument());
    const before = captured.options.length;
    await userEvent.click(screen.getByRole("button", { name: "tick 0" }));
    await screen.findByRole("button", { name: "tick 1" });
    expect(captured.options.length).toBeGreaterThan(before); // the chart really rendered again
    expect(captured.options.at(-1)).toBe(captured.options.at(-2));
    // a hover re-renders the chart too, and must not hand it a new option either
    fireEvent.pointerEnter(screen.getByTestId("chart").closest("section")!, { pointerType: "mouse" });
    await screen.findByText(/paused while you point/);
    expect(captured.options.at(-1)).toBe(captured.options.at(-2));
  });
});

describe("TrendChart while the series loads", () => {
  const LABEL = "Loading the chart";
  const routes = {
    ...siteRoute,
    "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "v", role: "viewer" } },
    "GET /api/assets/4/series": { body: series },
  };
  const holdSeries = () => holdFetch((method, path) => method === "GET" && path === "/api/assets/4/series");
  const seriesAsked = () => waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/series"))).toBe(true));
  const regionOf = () => screen.getByText(LABEL).parentElement!;
  beforeEach(() => { captured.options.length = 0; });

  it("puts a chart-sized block, as one status region, in the frame under the real toolbar while the series is held; then the chart", async () => {
    mockFetch(routes);
    const held = holdSeries();
    renderWithProviders(<TrendChart assetId={4} metrics={metrics} />);
    await seriesAsked();
    const frame = screen.getByRole("region", { name: "Trend" });
    expect(frame.querySelector(".trend-bar select")).not.toBeNull(); // the toolbar is the real one
    expect(regionOf()).toHaveAttribute("role", "status");
    expect(frame.contains(regionOf())).toBe(true);
    const block = regionOf().querySelector<HTMLElement>(".sk-block")!;
    expect(block.style.height).toBe(`${CHART_HEIGHT}px`);
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
    held.release();
    await screen.findByTestId("chart");
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("is one region from the series to the site zone (the same element stays while the zone is awaited)", async () => {
    mockFetch(routes);
    const answer = fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => (String(input).includes("/api/site") ? gate.then(() => answer(input, init)) : answer(input, init))));
    renderWithProviders(<TrendChart assetId={4} metrics={metrics} />);
    const region = regionOf();
    await screen.findByText("raw samples"); // the series is in, the zone is not
    expect(regionOf()).toBe(region);
    release();
    await screen.findByTestId("chart");
    expect(region.isConnected).toBe(false);
  });

  it("shows the text 'No data in this range.' and no block for an empty series", async () => {
    mockFetch({ ...routes, "GET /api/assets/4/series": { body: { ...series, points: [] } } });
    renderWithProviders(<TrendChart assetId={4} metrics={metrics} />);
    expect(await screen.findByText("No data in this range.")).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the error and no block when the series fails", async () => {
    mockFetch({ ...routes, "GET /api/assets/4/series": { status: 500, body: { detail: "series down" } } });
    renderWithProviders(<TrendChart assetId={4} metrics={metrics} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("series down");
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("never shows the block on a refetch with the chart on screen", async () => {
    mockFetch(routes);
    renderWithProviders(<TrendChart assetId={4} metrics={metrics} />);
    await screen.findByTestId("chart");
    holdSeries();
    fireEvent(window, new Event("visibilitychange")); // React Query fetches again
    await seriesAsked();
    expect(screen.getByTestId("chart")).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
  });

  it("a series that failed never brings the block back when it is tried again (the error and the block would take turns at every poll)", async () => {
    mockFetch({ ...routes, "GET /api/assets/4/series": { status: 500, body: { detail: "series down" } } });
    renderWithProviders(<TrendChart assetId={4} metrics={metrics} />);
    await screen.findByRole("alert");
    holdSeries();
    fireEvent(window, new Event("visibilitychange"));
    await seriesAsked();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument()); // the retry is pending: no error yet
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
