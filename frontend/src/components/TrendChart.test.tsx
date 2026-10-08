import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
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
    const gapped = { ...series, points: [point(0, width), point(1, width), point(4, width)] };
    const option = seriesToOption(gapped as never, "1h", { start, end, buckets: 300 }) as Opt;
    const avg = option.series.find((s) => s.name === "avg")!.data;
    expect(avg.map(([, v]) => v)).toEqual([1, 1, null, 1]);
    expect(avg[2][0]).toBe(new Date(T0 + 2 * width).toISOString());
    for (const name of ["min", "max"]) {
      expect(option.series.find((s) => s.name === name)!.data[2][1]).toBeNull();
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
    expect(screen.getByText("loading…")).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
    expect(captured.options).toHaveLength(0); // no chart was ever given an option, so none had the UTC axis
    release();
    await screen.findByTestId("chart");
    expect(captured.options.length).toBeGreaterThan(0);
    for (const option of captured.options as { xAxis: { axisLabel: { formatter: (ms: number) => string } } }[]) {
      expect(option.xAxis.axisLabel.formatter(Date.parse("2026-10-06T21:00:00Z"))).toBe("00:00"); // Asia/Qatar, never UTC's 21:00
    }
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
