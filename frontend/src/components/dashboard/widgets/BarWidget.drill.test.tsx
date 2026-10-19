import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { keys } from "../../../api/queries";
import type { Asset, WidgetData } from "../../../api/types";
import { chartLabels } from "../../../lib/widgetFormat";
import { breakdownBlock, breakdownData, valueRow } from "../../../test/dashboardFixtures";
import { FocusContext, type FocusState } from "../FocusContext";
import { BarWidget, barOption, clickedBar } from "./BarWidget";

// w25 T5 (R10): a click on a bar of a breakdown by kind, or on its name, narrows the dashboard or opens the asset's page. echarts-for-react is a stub that keeps what it
// was handed, so the tests read the option and call the click handler as ECharts would.
interface ChartProps {
  option: {
    xAxis: { triggerEvent?: boolean; data: string[]; axisLabel: { formatter: (value: string) => string } };
    series: { cursor?: string; data: (number | null)[] }[];
    tooltip: { formatter: (params: unknown) => string };
  };
  onEvents?: { click: (params: unknown) => void };
}
const chart = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("echarts-for-react", () => ({
  default: (props: Record<string, unknown>) => {
    chart.props = props;
    return <div data-testid="chart" />;
  },
}));
const drawn = () => chart.props as unknown as ChartProps;
const TZ = "Asia/Qatar";

const asset = (id: number, parent_id: number | null, name: string): Asset => ({ id, parent_id, name, kind: "rack", sort_order: id });
/** Rack 05 (id 10) holds a feed; Rack 06 and Rack 07 hold nothing. */
const ASSETS: Asset[] = [asset(1, null, "Site"), asset(2, 1, "Hall 1"), asset(10, 2, "Rack 05"), asset(11, 2, "Rack 06"), asset(12, 2, "Rack 07"), asset(100, 10, "Feed A")];
const bars = (...rows: [number, string, number | null][]): WidgetData =>
  breakdownData(rows.length, {
    values: rows.map(([id, name, value]) => valueRow({ asset_id: id, name, value, no_data: value === null, point_id: null })),
    breakdown: breakdownBlock({ count: rows.length, shown: rows.length, more: { count: 0, with_value: 0, value: null, estimated: false, partial: false } }),
  });
const THREE = bars([10, "Rack 05", 100], [11, "Rack 06", 90], [12, "Rack 07", 80]);

const setFocus = vi.fn();
/** A dashboard on which a card follows the focus (`anyFollowing`), so that a click may narrow it; the all-fixed case says `anyFollowing: false`. */
const state = (over: Partial<FocusState> = {}): FocusState => ({ focus: null, allowed: true, assets: ASSETS, name: null, notice: null, anyFollowing: true, setFocus, reportGone: () => {}, ...over });

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
/** The widget in the providers the dashboard gives it. The asset list is in the cache and never stale, so no request is made. */
function drawBars(data: WidgetData, { focus = state(), cached = ASSETS, splitDisabled = false }: { focus?: FocusState; cached?: Asset[] | null; splitDisabled?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (cached) client.setQueryData(keys.assets, cached);
  const wrap = (next: WidgetData) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FocusContext.Provider value={focus}>
          <BarWidget data={next} timezone={TZ} splitDisabled={splitDisabled} />
        </FocusContext.Provider>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const shown = render(wrap(data));
  return { ...shown, client, again: (next: WidgetData) => shown.rerender(wrap(next)) };
}
const click = (params: unknown) => act(() => drawn().onEvents!.click(params));
const tipOf = (index: number) => drawn().option.tooltip.formatter([{ dataIndex: index, seriesIndex: 0 }]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

beforeEach(() => {
  setFocus.mockReset();
  chart.props = null;
});

describe("a breakdown chart where a click does something", () => {
  it("narrows the dashboard on a click on a bar whose asset has children", () => {
    drawBars(THREE);
    click({ componentType: "series", dataIndex: 0 });
    expect(setFocus).toHaveBeenCalledTimes(1);
    expect(setFocus).toHaveBeenCalledWith(10);
  });

  it("opens the page of a bar's asset that has none", () => {
    const view = drawBars(THREE);
    click({ componentType: "series", dataIndex: 1 });
    expect(setFocus).not.toHaveBeenCalled();
    expect(view.getByTestId("where")).toHaveTextContent("/assets/11");
  });

  it("does the same for a click on a bar's name, found by the category text it was given", () => {
    const view = drawBars(THREE);
    click({ componentType: "xAxis", targetType: "axisLabel", value: "Rack 05", tickIndex: 0, dataIndex: 0 });
    expect(setFocus).toHaveBeenCalledWith(10);
    click({ componentType: "xAxis", targetType: "axisLabel", value: "Rack 07", tickIndex: 2, dataIndex: 2 });
    expect(view.getByTestId("where")).toHaveTextContent("/assets/12");
  });

  it("maps a name that is drawn wrapped or shortened by the whole text it was given, not by what is drawn", () => {
    const names = ["Main-Switchboard-Feeder-Room-East-Hall-3", "Auxiliary-Distribution-Panel-Block-West", "Rack 07"];
    const long = bars([10, names[0], 100], [11, names[1], 90], [12, names[2], 80]);
    const view = drawBars(long);
    const { xAxis } = drawn().option;
    expect(xAxis.triggerEvent).toBe(true);
    expect(xAxis.data).toEqual(names);
    expect(xAxis.axisLabel.formatter(names[0]), "the axis draws something other than the category").not.toBe(names[0]);
    expect(xAxis.axisLabel.formatter(names[1])).not.toBe(names[1]);
    click({ componentType: "xAxis", value: names[0] });
    expect(setFocus).toHaveBeenLastCalledWith(10);
    click({ componentType: "xAxis", value: names[1] });
    expect(view.getByTestId("where")).toHaveTextContent("/assets/11");
    click({ componentType: "xAxis", value: xAxis.axisLabel.formatter(names[0]) });
    expect(setFocus, "the drawn text is not a category").toHaveBeenCalledTimes(1);
  });

  it("maps two bars with the same name by the id the label carries", () => {
    const twins = bars([10, "Rack", 100], [11, "Rack", 90]);
    const view = drawBars(twins);
    expect(drawn().option.xAxis.data).toEqual(["Rack (#10)", "Rack (#11)"]);
    click({ componentType: "xAxis", value: "Rack (#11)" });
    expect(view.getByTestId("where")).toHaveTextContent("/assets/11");
  });

  it("makes the name of a bar with no data clickable too (it has no shape to click)", () => {
    const view = drawBars(bars([10, "Rack 05", 100], [12, "Rack 07", null]));
    expect(drawn().option.series[0].data).toEqual([100, null]);
    click({ componentType: "xAxis", value: "Rack 07" });
    expect(view.getByTestId("where")).toHaveTextContent("/assets/12");
  });

  it("ignores a click on anything else, an unknown name or a bar that is not there", () => {
    const view = drawBars(THREE);
    click({ componentType: "markPoint", dataIndex: 0 });
    click({ componentType: "xAxis", value: "Rack 99" });
    click({ componentType: "series", dataIndex: 7 });
    click({ componentType: "series" });
    expect(setFocus).not.toHaveBeenCalled();
    expect(view.getByTestId("where")).toHaveTextContent("/");
    expect(view.getByTestId("where").textContent).toBe("/");
  });

  it("shows the pointer, and says what a click does as the tooltip's last line", () => {
    drawBars(THREE);
    expect(drawn().option.series[0].cursor).toBe("pointer");
    expect(tipOf(0)).toMatch(/^Rack 05 100\.00 kWh Click to narrow the dashboard to Rack 05$/);
    expect(tipOf(1)).toMatch(/Click to open Rack 06&#39;s page$/);
  });

  it("names a bar in the line as the chart does, and escapes it", () => {
    drawBars(bars([10, "Rack", 100], [11, "Rack", 90], [12, "<b>Rack</b> & co", 80]));
    expect(tipOf(0)).toContain("Click to narrow the dashboard to Rack (#10)");
    expect(drawn().option.tooltip.formatter([{ dataIndex: 2, seriesIndex: 0 }])).toContain("Click to open &lt;b&gt;Rack&lt;/b&gt; &amp; co&#39;s page");
  });

  it("puts the line on the tooltip of a bar with no data as well, saying that only its name answers (W8)", () => {
    drawBars(bars([10, "Rack 05", 100], [12, "Rack 07", null]));
    expect(tipOf(1)).toMatch(/Rack 07 no data Click its name to open Rack 07&#39;s page$/);
    expect(tipOf(0), "a bar with a shape keeps the plain wording").toMatch(/Click to narrow the dashboard to Rack 05$/);
  });

  it("says its name for a bar with no data that would narrow, too (W8)", () => {
    drawBars(bars([10, "Rack 05", null], [12, "Rack 07", 80]));
    expect(tipOf(0)).toMatch(/Rack 05 no data Click its name to narrow the dashboard to Rack 05$/);
  });

  it("opens the page of every bar when nothing on the dashboard follows the focus, an asset with children included (W2)", () => {
    const view = drawBars(THREE, { focus: state({ anyFollowing: false }) });
    expect(drawn().option.series[0].cursor).toBe("pointer");
    expect(tipOf(0)).toMatch(/^Rack 05 100\.00 kWh Click to open Rack 05&#39;s page$/);
    expect(tipOf(0)).not.toContain("narrow");
    click({ componentType: "series", dataIndex: 0 });
    expect(setFocus).not.toHaveBeenCalled();
    expect(view.getByTestId("where")).toHaveTextContent("/assets/10");
    click({ componentType: "xAxis", value: "Rack 05" });
    expect(setFocus).not.toHaveBeenCalled();
  });

  it("says in the tooltip of a bar with no data that its name opens the page when nothing follows (W2, W8)", () => {
    drawBars(bars([10, "Rack 05", null], [12, "Rack 07", 80]), { focus: state({ anyFollowing: false }) });
    expect(tipOf(0)).toMatch(/Rack 05 no data Click its name to open Rack 05&#39;s page$/);
  });

  it("keeps the handler ECharts holds when the answer changes, and follows the newest answer", () => {
    const view = drawBars(THREE);
    const held = drawn().onEvents;
    view.again(bars([12, "Rack 07", 100], [10, "Rack 05", 90]));
    expect(drawn().onEvents).toBe(held);
    click({ componentType: "series", dataIndex: 0 });
    expect(view.getByTestId("where")).toHaveTextContent("/assets/12");
    click({ componentType: "xAxis", value: "Rack 05" });
    expect(setFocus).toHaveBeenCalledWith(10);
  });
});

describe("a breakdown chart where a click does nothing", () => {
  /** The same chart with no event handler, no events on the names, no line in the tooltip, and the arrow where the bars would show a pointer. */
  const expectPlain = () => {
    expect(drawn().onEvents).toBeUndefined();
    expect(drawn().option.xAxis.triggerEvent).toBeUndefined();
    expect(drawn().option.series[0].cursor).toBe("default");
    expect(tipOf(0)).not.toContain("Click");
    expect(tipOf(0)).toMatch(/^Rack 05 100\.00 kWh$/);
  };

  it("has no providers to need: the default context (a lone card) is allowed nothing", () => {
    render(<BarWidget data={THREE} timezone={TZ} />);
    expectPlain();
  });

  it("is plain for a role that cannot open assets", () => {
    drawBars(THREE, { focus: state({ allowed: false, assets: undefined }) });
    expectPlain();
  });

  it("is plain in the editor's grid and preview", () => {
    drawBars(THREE, { splitDisabled: true });
    expectPlain();
  });

  it("is plain until the asset list is loaded, then drills", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {})); // the list is asked for and never answers
    const view = drawBars(THREE, { cached: null });
    expectPlain();
    act(() => { view.client.setQueryData(keys.assets, ASSETS); });
    await waitFor(() => expect(drawn().onEvents).toBeDefined());
    expect(drawn().option.series[0].cursor).toBe("pointer");
    click({ componentType: "series", dataIndex: 0 });
    expect(setFocus).toHaveBeenCalledWith(10);
  });

  it("is the old bar chart for a values answer without a breakdown, even where a click could do something", () => {
    drawBars(breakdownData(3, { breakdown: null }));
    expect(drawn().onEvents).not.toHaveProperty("click"); // the legend's events, as ever
    expect(drawn().option.xAxis.triggerEvent).toBeUndefined();
    expect(drawn().option.series[0].cursor).toBeUndefined();
  });
});

describe("the click and the option", () => {
  it("maps a click by the category list: a bar by its index, a name by its text, anything else to none", () => {
    const labels = chartLabels(THREE.values);
    expect(clickedBar({ componentType: "series", dataIndex: 2 }, labels)).toBe(2);
    expect(clickedBar({ componentType: "xAxis", value: "Rack 06" }, labels)).toBe(1);
    expect(clickedBar({ componentType: "xAxis", value: "Rack" }, labels)).toBe(-1);
    expect(clickedBar({ componentType: "title" }, labels)).toBe(-1);
  });

  it("changes nothing in a chart that is given no drill, except the cursor of a breakdown", () => {
    const plain = barOption(THREE, TZ) as unknown as ChartProps["option"];
    const drill = barOption(THREE, TZ, undefined, undefined, ["narrow", "open", "open"]) as unknown as ChartProps["option"];
    expect(plain.xAxis.triggerEvent).toBeUndefined();
    expect(drill.xAxis.triggerEvent).toBe(true);
    expect(plain.series[0].cursor).toBe("default");
    expect(drill.series[0].cursor).toBe("pointer");
  });

});
