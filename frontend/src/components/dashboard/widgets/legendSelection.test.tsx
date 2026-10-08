import { act, render } from "@testing-library/react";
import { seriesData, seriesPoint, valueRow, valuesData } from "../../../test/dashboardFixtures";
import { BarWidget } from "./BarWidget";
import { TimeSeriesWidget } from "./TimeSeriesWidget";

// What echarts-for-react was last handed. The real component calls setOption(option, { notMerge: true }) whenever the
// option changes, and a fresh option puts every legend entry back on: a refetch every 30 s on a rolling range must not.
interface ChartProps {
  option: { legend?: { selected?: Record<string, boolean> }; series: { id?: string; data: [string, number][] }[] };
  notMerge?: boolean;
  onEvents?: Record<string, (event: unknown) => void>;
}
const chart = vi.hoisted(() => ({ props: null as null | Record<string, any> }));
vi.mock("echarts-for-react", () => ({
  default: (props: Record<string, any>) => {
    chart.props = props;
    return <pre data-testid="chart" />;
  },
}));
const props = () => chart.props as unknown as ChartProps;
/** The viewer clicks a legend entry: ECharts reports the selection of every entry. */
const toggle = (selected: Record<string, boolean>) => act(() => props().onEvents!.legendselectchanged({ type: "legendselectchanged", name: "B", selected }));

const TZ = "Asia/Qatar";
const line = (id: number, name: string, base: number) => ({
  asset_id: id, name, estimated: false, partial: false,
  points: [0, 1, 2].map((i) => seriesPoint({ ts: `2026-10-08T0${i}:00:00+00:00`, value: base + i, min: base + i - 1, max: base + i + 1 })),
});
const two = (base: number) => seriesData({ series: [line(5, "A", base), line(6, "B", base + 10)] });

describe("a legend selection survives a refetch", () => {
  it("keeps a time-series entry switched off when new data arrives, and still re-sets the chart with that data", () => {
    const { rerender } = render(<TimeSeriesWidget data={two(1)} timezone={TZ} />);
    expect(props().option.legend?.selected).toBeUndefined(); // nothing chosen yet: the default, every entry on
    toggle({ A: true, B: false });
    const before = props().option;
    rerender(<TimeSeriesWidget data={two(100)} timezone={TZ} />); // the 30 s refetch brought new figures
    expect(props().option).not.toBe(before);
    expect(props().option.series.find((s) => s.id === "avg-6")!.data[1][1]).toBe(111); // it is the new data that is drawn
    expect(props().option.legend?.selected).toEqual({ A: true, B: false });
    expect(props().notMerge).toBe(true);
  });

  it("follows the viewer's latest choice, not the first one", () => {
    const { rerender } = render(<TimeSeriesWidget data={two(1)} timezone={TZ} />);
    toggle({ A: true, B: false });
    rerender(<TimeSeriesWidget data={two(2)} timezone={TZ} />);
    toggle({ A: true, B: true });
    rerender(<TimeSeriesWidget data={two(3)} timezone={TZ} />);
    expect(props().option.legend?.selected).toEqual({ A: true, B: true });
  });

  it("keeps a bar entry switched off (bars per time bucket, grouped by asset)", () => {
    const bars = (base: number) => seriesData({
      type: "bar", series: [line(5, "A", base), line(6, "B", base + 10)],
    });
    const { rerender } = render(<BarWidget data={bars(1)} timezone={TZ} />);
    expect(props().option.legend?.selected).toBeUndefined();
    toggle({ A: false, B: true });
    rerender(<BarWidget data={bars(50)} timezone={TZ} />);
    expect(props().option.legend?.selected).toEqual({ A: false, B: true });
    expect(props().notMerge).toBe(true);
  });

  it("adds no legend to the bar chart of one value per asset: it has none to remember", () => {
    const values = (v: number) => valuesData({ type: "bar", source: "energy", metric: null, unit: "kWh", values: [valueRow({ asset_id: 5, name: "A", value: v })] });
    const { rerender } = render(<BarWidget data={values(1)} timezone={TZ} />);
    rerender(<BarWidget data={values(2)} timezone={TZ} />);
    expect(props().option.legend).toBeUndefined();
  });
});

describe("two charts do not share a selection", () => {
  it("remembers per widget", () => {
    const first = render(<TimeSeriesWidget data={two(1)} timezone={TZ} />);
    toggle({ A: false, B: true });
    first.unmount();
    render(<TimeSeriesWidget data={two(1)} timezone={TZ} />);
    expect(props().option.legend?.selected).toBeUndefined();
  });
});
