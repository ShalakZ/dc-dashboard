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
    const option = seriesToOption(series as never, "1h") as { series: { name: string; data: unknown[]; connectNulls?: boolean }[]; yAxis: { name: string } };
    expect(option.yAxis.name).toBe("kW");
    const avg = option.series.find((s) => s.name === "avg")!;
    expect(avg.connectNulls).toBe(false);
    expect(avg.data).toEqual([["2026-10-07T10:00:00+00:00", 1], ["2026-10-07T10:01:00+00:00", 2]]);
    expect(option.series.map((s) => s.name)).toEqual(["min", "max", "avg"]);
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
