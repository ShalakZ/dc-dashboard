import { render, screen, within } from "@testing-library/react";
import type { Asset, WidgetData } from "../../../api/types";
import { parentNamesOf, type ParentNames } from "../../../lib/widgetFormat";
import { breakdownBlock, breakdownData, seriesData, seriesPoint, valueRow, valuesData } from "../../../test/dashboardFixtures";
import { barOption } from "./BarWidget";
import { DEFAULT_CHART_WIDTH } from "./barAxis";
import { LIGHT_CHART } from "./chartTheme";
import { TableWidget } from "./TableWidget";
import { timeSeriesOption } from "./TimeSeriesWidget";

// w27 R6: a name used by several assets of one card gains its parent's name ("Hall 2 / Rack 04") when the asset list is known; the table, the bars, the legends and the
// Details rows all say the same thing, because they all call the one labelling function with the one map. Without the map the text is today's "Rack 04 (#12)".
vi.mock("echarts-for-react", () => ({
  default: (props: { option: { series?: { type?: string }[] } }) => <pre data-testid="chart">{JSON.stringify(props.option)}</pre>,
}));

const TZ = "Asia/Qatar";
const asset = (id: number, parent_id: number | null, name: string): Asset => ({ id, parent_id, name, kind: "rack", sort_order: id });
const LIST: Asset[] = [asset(1, null, "Site"), asset(2, 1, "Hall 2"), asset(3, 1, "Hall 3"), asset(12, 2, "Rack 04"), asset(13, 3, "Rack 04"), asset(14, 3, "Rack 04"), asset(20, 2, "Main")];
const PARENTS: ParentNames = parentNamesOf(LIST);
const NAMES = (ids: number[]) => ids.map((id) => ({ id, name: LIST.find((a) => a.id === id)!.name }));

const rows = (ids: number[]): WidgetData["values"] => NAMES(ids).map(({ id, name }, i) => valueRow({ asset_id: id, name, value: 10 + i, point_id: null }));
const lines = (ids: number[]): WidgetData["series"] => NAMES(ids).map(({ id, name }) => ({
  asset_id: id, name, estimated: false, partial: false,
  points: [seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 1, min: 1, max: 1 }), seriesPoint({ ts: "2026-10-08T00:04:48+00:00", value: 2, min: 2, max: 2 })],
}));

const TWO = [12, 13];
const THREE = [12, 13, 14];
const tableCells = (): string[] => screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent ?? "");
const axisOf = (option: unknown) => (option as { xAxis: { data: string[] } }).xAxis.data;
const namesOf = (option: unknown) => (option as { series: { name?: string; id?: string }[] }).series.filter((s) => !s.id || s.id.startsWith("avg-")).map((s) => s.name);

describe("a table with a repeated name", () => {
  const data = valuesData({ type: "table", values: rows([12, 13, 20]) });
  it("says the parent's name, and leaves a unique name alone", () => {
    render(<TableWidget data={data} parents={PARENTS} />);
    expect(tableCells()).toEqual(["Hall 2 / Rack 04", "Hall 3 / Rack 04", "Main"]);
  });
  it("is exactly today's text without the map (no permission, or the list not here yet)", () => {
    render(<TableWidget data={data} />);
    expect(tableCells()).toEqual(["Rack 04 (#12)", "Rack 04 (#13)", "Main"]);
  });
  it("keeps (#id) for the two that are still the same after the parent's name", () => {
    render(<TableWidget data={valuesData({ type: "table", values: rows(THREE) })} parents={PARENTS} />);
    expect(tableCells()).toEqual(["Hall 2 / Rack 04", "Hall 3 / Rack 04 (#13)", "Hall 3 / Rack 04 (#14)"]);
  });
});

describe("the bars and the table of one answer say the same names", () => {
  it("a bar per asset: the axis, the tooltip header and the table agree", () => {
    const data = valuesData({ type: "bar", source: "energy", metric: null, unit: "kWh", values: rows(THREE) });
    const option = barOption(data, TZ, LIGHT_CHART, DEFAULT_CHART_WIDTH, undefined, PARENTS);
    expect(axisOf(option)).toEqual(["Hall 2 / Rack 04", "Hall 3 / Rack 04 (#13)", "Hall 3 / Rack 04 (#14)"]);
    render(<TableWidget data={{ ...data, type: "table" }} parents={PARENTS} />);
    expect(tableCells()).toEqual(axisOf(option));
    const tip = (option as { tooltip: { formatter: (params: unknown) => string } }).tooltip.formatter([{ dataIndex: 1, seriesIndex: 0 }]);
    expect(tip).toContain("Hall 3 / Rack 04 (#13)");
  });
  it("is today's text on the axis without the map", () => {
    const data = valuesData({ type: "bar", values: rows(TWO) });
    expect(axisOf(barOption(data, TZ))).toEqual(["Rack 04 (#12)", "Rack 04 (#13)"]);
    expect(axisOf(barOption(data, TZ, LIGHT_CHART, DEFAULT_CHART_WIDTH, undefined, new Map()))).toEqual(["Rack 04 (#12)", "Rack 04 (#13)"]);
  });
  it("a breakdown's click line names the bar as the axis does", () => {
    const data = breakdownData(2, {
      values: rows(TWO),
      breakdown: breakdownBlock({ count: 2, shown: 2, more: { count: 0, with_value: 0, value: null, estimated: false, partial: false } }),
    });
    const option = barOption(data, TZ, LIGHT_CHART, DEFAULT_CHART_WIDTH, ["narrow", "open"], PARENTS);
    expect(axisOf(option)).toEqual(["Hall 2 / Rack 04", "Hall 3 / Rack 04"]);
    const tip = (option as { tooltip: { formatter: (params: unknown) => string } }).tooltip.formatter([{ dataIndex: 0, seriesIndex: 0 }]);
    expect(tip).toContain("Click to narrow the dashboard to Hall 2 / Rack 04");
  });
  it("a bar per asset and bucket: the series names, which are the legend entries", () => {
    const data = seriesData({ type: "bar", source: "energy", metric: null, unit: "kWh", bucket: "hour", series: lines(TWO) });
    expect(namesOf(barOption(data, TZ, LIGHT_CHART, DEFAULT_CHART_WIDTH, undefined, PARENTS))).toEqual(["Hall 2 / Rack 04", "Hall 3 / Rack 04"]);
    expect(namesOf(barOption(data, TZ))).toEqual(["Rack 04 (#12)", "Rack 04 (#13)"]);
  });
});

describe("a line chart with a repeated name", () => {
  const data = seriesData({ series: lines(TWO) });
  it("names its lines, and so its legend, by the parent", () => {
    const option = timeSeriesOption(data, TZ, LIGHT_CHART, PARENTS);
    expect(namesOf(option)).toEqual(["Hall 2 / Rack 04", "Hall 3 / Rack 04"]);
    expect((option as { legend: { data: string[] } }).legend.data).toEqual(["Hall 2 / Rack 04", "Hall 3 / Rack 04"]);
  });
  it("is exactly today's text without the map, and for a unique name", () => {
    expect(namesOf(timeSeriesOption(data, TZ))).toEqual(["Rack 04 (#12)", "Rack 04 (#13)"]);
    expect(namesOf(timeSeriesOption(seriesData({ series: lines([12, 20]) }), TZ, LIGHT_CHART, PARENTS))).toEqual(["Rack 04", "Main"]);
  });
});
