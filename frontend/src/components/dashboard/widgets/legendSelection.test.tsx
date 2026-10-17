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

describe("a remembered selection is kept by asset, and only what still fits is applied", () => {
  const only = (...ids: [number, string][]) => seriesData({ series: ids.map(([id, name]) => line(id, name, id)) });
  const A: [number, string] = [5, "A"];
  const B: [number, string] = [6, "B"];
  const C: [number, string] = [7, "C"];
  const D: [number, string] = [8, "D"];

  it("when the legend is no longer shown (one series left), so a hidden series can never become unreachable", () => {
    const { rerender } = render(<TimeSeriesWidget data={only(A, B)} timezone={TZ} />);
    toggle({ A: false, B: true });
    rerender(<TimeSeriesWidget data={only(B)} timezone={TZ} />); // A was deleted: a single series has no legend to switch it back on
    expect(props().option.legend?.selected).toBeUndefined();
    rerender(<TimeSeriesWidget data={only(A, B)} timezone={TZ} />); // and the old choice does not come back with the legend
    expect(props().option.legend?.selected).toBeUndefined();
  });

  it("when an asset gains or loses a ~ or a * (its legend name changes), the choice stays with the asset", () => {
    const flagged = (flag: { estimated?: boolean; partial?: boolean }) =>
      seriesData({ series: [line(5, "A", 5), { ...line(6, "B", 6), ...flag }] });
    const { rerender } = render(<TimeSeriesWidget data={flagged({})} timezone={TZ} />);
    toggle({ A: true, B: false });
    rerender(<TimeSeriesWidget data={flagged({ estimated: true })} timezone={TZ} />); // the refetch flagged B: its name is now "B ~"
    expect(props().option.legend?.selected).toEqual({ A: true, "B ~": false });
    rerender(<TimeSeriesWidget data={flagged({ estimated: true, partial: true })} timezone={TZ} />);
    expect(props().option.legend?.selected).toEqual({ A: true, "B ~ *": false });
    rerender(<TimeSeriesWidget data={flagged({})} timezone={TZ} />); // and the flag goes again
    expect(props().option.legend?.selected).toEqual({ A: true, B: false });
    rerender(<TimeSeriesWidget data={flagged({ partial: true })} timezone={TZ} />);
    toggle({ A: true, "B *": true }); // a choice made under a flagged name is remembered under the asset too
    rerender(<TimeSeriesWidget data={flagged({})} timezone={TZ} />);
    expect(props().option.legend?.selected).toEqual({ A: true, B: true });
  });

  it("when an asset is renamed", () => {
    const named = (name: string) => seriesData({ series: [line(5, "A", 5), line(6, name, 6)] });
    const { rerender } = render(<TimeSeriesWidget data={named("B")} timezone={TZ} />);
    toggle({ A: true, B: false });
    rerender(<TimeSeriesWidget data={named("Boiler")} timezone={TZ} />);
    expect(props().option.legend?.selected).toEqual({ A: true, Boiler: false });
  });

  it("when an asset is replaced: the one that is gone is ignored, a new one is shown, the others keep their choice", () => {
    const { rerender } = render(<TimeSeriesWidget data={only(A, B, C)} timezone={TZ} />);
    toggle({ A: false, B: true, C: true });
    rerender(<TimeSeriesWidget data={only(A, D)} timezone={TZ} />); // C replaced by D
    expect(props().option.legend?.selected).toEqual({ A: false, D: true });
    rerender(<TimeSeriesWidget data={only(A, B, C)} timezone={TZ} />); // an asset that was gone has no choice left: shown
    expect(props().option.legend?.selected).toEqual({ A: false, B: true, C: true });
  });

  it("never leaves every series hidden: a choice that would is dropped for good", () => {
    const { rerender } = render(<TimeSeriesWidget data={only(A, B, C)} timezone={TZ} />);
    toggle({ A: true, B: false, C: false });
    rerender(<TimeSeriesWidget data={only(B, C)} timezone={TZ} />); // A, the only one left on, was deleted
    expect(props().option.legend?.selected).toBeUndefined();
    rerender(<TimeSeriesWidget data={only(A, B, C)} timezone={TZ} />); // and it does not come back with A
    expect(props().option.legend?.selected).toBeUndefined();
  });

  it("for bars too", () => {
    const bars = (...ids: [number, string][]) => seriesData({ type: "bar", series: ids.map(([id, name]) => line(id, name, id)) });
    const { rerender } = render(<BarWidget data={bars(A, B)} timezone={TZ} />);
    toggle({ A: false, B: true });
    rerender(<BarWidget data={bars(B)} timezone={TZ} />);
    expect(props().option.legend?.selected).toBeUndefined();
    const { rerender: again } = render(<BarWidget data={bars(A, B, C)} timezone={TZ} />);
    toggle({ A: true, B: false, C: true });
    again(<BarWidget data={bars(A, B, D)} timezone={TZ} />);
    expect(props().option.legend?.selected).toEqual({ A: true, B: false, D: true });
  });

  it("but not while the same assets are still there: the choice survives data that changed, in any order", () => {
    const { rerender } = render(<TimeSeriesWidget data={only(A, B)} timezone={TZ} />);
    toggle({ A: true, B: false });
    rerender(<TimeSeriesWidget data={only(B, A)} timezone={TZ} />);
    expect(props().option.legend?.selected).toEqual({ A: true, B: false });
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
