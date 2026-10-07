import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { seriesToOption, TrendChart } from "./TrendChart";

vi.mock("echarts-for-react", () => ({ default: (props: { option: unknown }) => <pre data-testid="chart">{JSON.stringify(props.option)}</pre> }));

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
});
