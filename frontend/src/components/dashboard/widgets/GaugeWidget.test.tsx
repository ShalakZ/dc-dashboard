import { render } from "@testing-library/react";
import { config, valueRow, valuesData } from "../../../test/dashboardFixtures";
import { MUTED_FIGURE } from "../../../lib/widgetFormat";
import { LiveValuesContext } from "../LiveValuesContext";
import { GaugeWidget } from "./GaugeWidget";

// The gauge's figure is drawn by ECharts' formatter, which a JSON dump of the option cannot show: keep the option itself.
const chart = vi.hoisted(() => ({ option: null as null | Record<string, any> }));
vi.mock("echarts-for-react", () => ({
  default: (props: { option: Record<string, any> }) => {
    chart.option = props.option;
    return <pre data-testid="chart" />;
  },
}));
const detail = () => chart.option!.series[0].detail as { formatter: () => string; color?: string };
const pointer = () => chart.option!.series[0].pointer.show as boolean;

const cfg = config({ aggregation: "last", min: 0, max: 200 });
const stream = (value: number | null, quality = 0) => ({
  values: new Map([[7, { ts: "2026-10-08T06:00:00.000Z", value, quality }]]), connected: true, register: () => {},
});

describe("the gauge when there is no figure", () => {
  it("says 'no data', muted, with no needle, for a metric with no reading", () => {
    render(<GaugeWidget data={valuesData({ type: "gauge", values: [valueRow({ value: null, no_data: true })] })} config={cfg} live={false} />);
    expect(detail().formatter()).toBe("no data");
    expect(detail().color).toBe(MUTED_FIGURE);
    expect(pointer()).toBe(false);
  });

  it("says 'no data' too when the live reading goes bad", () => {
    render(<LiveValuesContext.Provider value={stream(7, 1)}><GaugeWidget data={valuesData({ type: "gauge" })} config={cfg} live /></LiveValuesContext.Provider>);
    expect(detail().formatter()).toBe("no data");
    expect(detail().color).toBe(MUTED_FIGURE);
  });

  it("keeps the dash for a cost without a rate, which means no rate and nothing else", () => {
    render(<GaugeWidget data={valuesData({ type: "gauge", source: "cost", metric: null, unit: "QAR", values: [valueRow({ value: null, no_data: true, point_id: null })] })} config={cfg} live={false} />);
    expect(detail().formatter()).toBe("—");
  });

  it("keeps the dash for a value that is missing without being marked silent, as before", () => {
    render(<GaugeWidget data={valuesData({ type: "gauge", values: [valueRow({ value: null })] })} config={cfg} live={false} />);
    expect(detail().formatter()).toBe("—");
  });

  it("shows a measured figure in the normal colour", () => {
    render(<GaugeWidget data={valuesData({ type: "gauge" })} config={cfg} live={false} />);
    expect(detail().formatter()).toBe("10.50 kW");
    expect(detail().color).toBeUndefined();
  });
});
