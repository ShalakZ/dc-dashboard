import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Metric } from "../../api/types";
import { toDrafts, type DraftWidget } from "../../lib/layout";
import { assetList, authed, config, widget, widgetDataRoute } from "../../test/dashboardFixtures";
import { mockFetch } from "../../test/fetchMock";
import { renderWithProviders } from "../../test/render";
import { LiveValuesContext } from "./LiveValuesContext";
import { WidgetEditor } from "./WidgetEditor";

vi.mock("echarts-for-react", () => ({ default: (props: { option: unknown }) => <pre data-testid="chart">{JSON.stringify(props.option)}</pre> }));

type Call = { method: string; path: string; body: unknown };
/** Assets 5 and 6 are mapped to active power; nothing else is mapped to anything (what the discovery graph says in these tests). */
const POWER = new Map<Metric, Set<number>>([["active_power_kw", new Set([5, 6])]]);

function open(initial: DraftWidget | null = null, metricAssets: Map<Metric, Set<number>> = POWER) {
  const calls = mockFetch({ ...authed("operator"), "POST /api/widget-data": widgetDataRoute });
  const onSave = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <WidgetEditor initial={initial} assets={assetList} metricAssets={metricAssets} dashboardRange="24h" timezone="Asia/Qatar" onSave={onSave} onClose={onClose} />,
  );
  return { calls, onSave, onClose };
}
const save = () => screen.getByRole("button", { name: "Save widget" });
const previews = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/widget-data");
const optionTexts = (label: string) => within(screen.getByLabelText(label)).getAllByRole("option").map((o) => o.textContent);
const power = { assets: [5], source: "metric", metric: "active_power_kw", aggregation: "avg", range: null, bars: "asset", min: 0, max: null };

describe("WidgetEditor", () => {
  it("starts blank: Save is disabled, the form says what is missing, and nothing is previewed", () => {
    const { calls } = open();
    expect(screen.getByRole("dialog", { name: "Add widget" })).toBeInTheDocument();
    expect(save()).toBeDisabled();
    expect(screen.getByText("Enter a title.")).toBeInTheDocument();
    expect(screen.getByText("Choose at least one asset.")).toBeInTheDocument();
    expect(screen.getByText("Complete the form to see a preview.")).toBeInTheDocument();
    expect(previews(calls)).toHaveLength(0);
  });

  it("previews with the exact widget-data request once the form is valid, then saves", async () => {
    const { calls, onSave } = open();
    await userEvent.type(screen.getByLabelText("Title"), "Hall power");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    expect(save()).toBeEnabled();
    await screen.findByTestId("chart");
    expect(previews(calls)).toHaveLength(1);
    expect(previews(calls)[0].body).toEqual({ type: "timeseries", range: "24h", config: power });
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith({ type: "timeseries", title: "Hall power", config: power });
  });

  it("lets a widget override the dashboard range, and go back to inheriting it", async () => {
    const { calls, onSave } = open();
    await userEvent.type(screen.getByLabelText("Title"), "T");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    expect(within(screen.getByLabelText("Widget range")).getAllByRole("option")[0]).toHaveTextContent("Use dashboard range");
    await userEvent.selectOptions(screen.getByLabelText("Widget range"), "7d");
    await waitFor(() => expect(previews(calls).some((c) => (c.body as { range: string }).range === "7d")).toBe(true));
    await userEvent.click(save());
    expect(onSave.mock.calls[0][0].config.range).toBe("7d");
    await userEvent.selectOptions(screen.getByLabelText("Widget range"), "Use dashboard range");
    await userEvent.click(save());
    expect(onSave.mock.calls[1][0].config.range).toBeNull();
  });

  it("makes a stat single-select, and lists only the assets that have the metric", async () => {
    open();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "stat");
    expect(screen.getAllByRole("radio")).toHaveLength(2); // the default metric is active power: only assets 5 and 6 are mapped to it
    await userEvent.click(screen.getByRole("radio", { name: "LV Panel 1" }));
    await userEvent.click(screen.getByRole("radio", { name: "LV Panel 2" }));
    expect(screen.getByRole("radio", { name: "LV Panel 1" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "LV Panel 2" })).toBeChecked();
  });

  it("keeps only the first asset when a multi-asset widget becomes a gauge", async () => {
    open();
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 2" }));
    await userEvent.selectOptions(screen.getByLabelText("Type"), "gauge");
    expect(screen.getByRole("radio", { name: "LV Panel 1" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "LV Panel 2" })).not.toBeChecked();
  });

  it("enforces the gauge rules: a metric, the latest value, and a maximum above the minimum", async () => {
    const { onSave } = open();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "gauge");
    expect(optionTexts("Source")).toEqual(["Metric"]);
    expect(optionTexts("Aggregation")).toEqual(["Latest"]);
    await userEvent.type(screen.getByLabelText("Title"), "Load");
    await userEvent.click(screen.getByRole("radio", { name: "LV Panel 1" }));
    expect(save()).toBeDisabled();
    expect(screen.getByText("Enter a number for the gauge minimum and maximum.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Gauge maximum"), "0");
    expect(screen.getByText("The gauge maximum must be greater than the minimum.")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Gauge maximum"));
    await userEvent.type(screen.getByLabelText("Gauge maximum"), "250");
    expect(save()).toBeEnabled();
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith({
      type: "gauge", title: "Load",
      config: { assets: [5], source: "metric", metric: "active_power_kw", aggregation: "last", range: null, bars: "asset", min: 0, max: 250 },
    });
  });

  it("offers only a total for energy, and no metric choice", async () => {
    const { calls } = open();
    expect(optionTexts("Metric")).toHaveLength(8);
    await userEvent.selectOptions(screen.getByLabelText("Source"), "energy");
    expect(screen.queryByLabelText("Metric")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Title"), "kWh");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await waitFor(() => expect(previews(calls)).toHaveLength(1));
    expect(previews(calls)[0].body).toEqual({ type: "timeseries", range: "24h", config: { ...power, source: "energy", metric: null, aggregation: "sum" } });
    await userEvent.selectOptions(screen.getByLabelText("Type"), "bar"); // a time series has no aggregation control; a bar chart does
    expect(optionTexts("Aggregation")).toEqual(["Total"]);
  });

  it("lists every asset for energy and cost, whatever they are mapped to", async () => {
    open();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    await userEvent.selectOptions(screen.getByLabelText("Source"), "energy");
    expect(screen.getAllByRole("checkbox").map((box) => box.parentElement?.textContent)).toEqual(["Site", "MV2", "LV Panel 1", "LV Panel 2"]);
    await userEvent.selectOptions(screen.getByLabelText("Source"), "cost");
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
  });

  it("shows the bars choice for bar widgets only", async () => {
    const { onSave } = open();
    expect(screen.queryByLabelText("Bars")).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "bar");
    await userEvent.selectOptions(screen.getByLabelText("Bars"), "time");
    await userEvent.type(screen.getByLabelText("Title"), "B");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.click(save());
    expect(onSave.mock.calls[0][0].config.bars).toBe("time");
  });

  it("edits an existing widget and drops assets that no longer exist, saying so", async () => {
    const [draft] = toDrafts([widget(1, "table", { title: "Assets", config: config({ assets: [5, 99] }) })]);
    const { onSave } = open(draft);
    expect(screen.getByRole("dialog", { name: "Edit widget" })).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Assets");
    expect(screen.getByRole("checkbox", { name: "LV Panel 1" })).toBeChecked();
    expect(screen.getByText(/1 removed asset was dropped/)).toBeInTheDocument();
    await userEvent.click(save());
    expect(onSave.mock.calls[0][0]).toEqual({ type: "table", title: "Assets", config: config({ assets: [5] }) });
  });

  it("is a modal dialog: focus starts on the title, stays inside, Escape closes without saving, focus returns to the opener", async () => {
    const opener = document.createElement("button");
    const outside = document.createElement("button");
    document.body.append(opener, outside);
    try {
      opener.focus();
      const { onSave, onClose } = open();
      const dialog = screen.getByRole("dialog", { name: "Add widget" });
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(screen.getByLabelText("Title")).toHaveFocus();
      outside.focus();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
      await userEvent.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onSave).not.toHaveBeenCalled();
      cleanup();
      expect(opener).toHaveFocus();
    } finally {
      opener.remove();
      outside.remove();
    }
  });
});

describe("which assets a metric widget may list", () => {
  const MAPPED = new Map<Metric, Set<number>>([
    ["active_power_kw", new Set([5, 6])], ["voltage_v", new Set([6])], ["energy_kwh", new Set([5, 6])],
  ]);

  it("removes selected assets that lack the metric when the metric changes", async () => {
    open(null, MAPPED);
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 2" }));
    expect(screen.getByText("2 of 20 selected")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Metric"), "voltage_v");
    expect(screen.queryByRole("checkbox", { name: /LV Panel 1/ })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "LV Panel 2" })).toBeChecked();
    expect(screen.getByText("1 of 20 selected")).toBeInTheDocument();
  });

  it("says so when no asset has the metric, and cannot be saved", async () => {
    open(null, MAPPED);
    await userEvent.type(screen.getByLabelText("Title"), "F");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.selectOptions(screen.getByLabelText("Metric"), "frequency_hz");
    expect(screen.getByText("No asset has a mapping for frequency_hz; choose another metric.")).toBeInTheDocument();
    expect(screen.getByText("0 of 20 selected")).toBeInTheDocument();
    expect(screen.getByText("Choose at least one asset.")).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it("keeps an asset of a saved widget that lacks the metric: shown, checked, labelled, and removable", async () => {
    const [draft] = toDrafts([widget(1, "table", { title: "Volts", config: config({ assets: [5, 6], metric: "voltage_v" }) })]);
    open(draft, MAPPED);
    expect(screen.getByRole("checkbox", { name: "LV Panel 1 (no voltage_v)" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "LV Panel 2" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /MV2/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1 (no voltage_v)" }));
    expect(screen.queryByRole("checkbox", { name: /LV Panel 1/ })).not.toBeInTheDocument(); // unchecked: it is no longer offered
    expect(screen.getByText("1 of 20 selected")).toBeInTheDocument();
  });

  it("drops them again when the source goes back from energy to a metric they lack", async () => {
    open(null, MAPPED);
    await userEvent.selectOptions(screen.getByLabelText("Source"), "energy");
    await userEvent.click(screen.getByRole("checkbox", { name: "MV2" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.selectOptions(screen.getByLabelText("Source"), "metric");
    expect(screen.queryByRole("checkbox", { name: "MV2" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "LV Panel 1" })).toBeChecked();
  });

  it("drops them too when picking a type that forces the metric source (a gauge cannot show energy)", async () => {
    open(null, MAPPED);
    await userEvent.selectOptions(screen.getByLabelText("Source"), "energy");
    await userEvent.click(screen.getByRole("checkbox", { name: "MV2" }));
    await userEvent.selectOptions(screen.getByLabelText("Type"), "gauge");
    expect(optionTexts("Source")).toEqual(["Metric"]);
    expect(screen.queryByRole("radio", { name: /MV2/ })).not.toBeInTheDocument();
    expect(screen.getByText("Choose an asset.")).toBeInTheDocument();
  });

  it("does not drop an unmapped asset of a saved widget when only the type changes", async () => {
    const [draft] = toDrafts([widget(1, "table", { title: "Volts", config: config({ assets: [5, 6], metric: "voltage_v" }) })]);
    open(draft, MAPPED);
    await userEvent.selectOptions(screen.getByLabelText("Type"), "bar");
    expect(screen.getByRole("checkbox", { name: "LV Panel 1 (no voltage_v)" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "LV Panel 2" })).toBeChecked();
  });

  it("keeps energy_kwh to the latest value, which the hidden time-series control still sends", async () => {
    const { onSave } = open(null, MAPPED);
    expect(screen.queryByLabelText("Aggregation")).not.toBeInTheDocument(); // a time series draws the average whatever it is told
    await userEvent.type(screen.getByLabelText("Title"), "Meter");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.selectOptions(screen.getByLabelText("Metric"), "energy_kwh");
    await userEvent.click(save());
    expect(onSave.mock.calls[0][0].config).toMatchObject({ metric: "energy_kwh", aggregation: "last" });
    await userEvent.selectOptions(screen.getByLabelText("Type"), "table");
    expect(optionTexts("Aggregation")).toEqual(["Latest"]);
    await userEvent.selectOptions(screen.getByLabelText("Metric"), "active_power_kw");
    expect(optionTexts("Aggregation")).toEqual(["Average", "Minimum", "Maximum", "Latest"]);
  });
});

describe("the preview", () => {
  it("waits for typing to settle: one request for the final gauge maximum, not one per keystroke", async () => {
    const { calls } = open();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "gauge");
    await userEvent.type(screen.getByLabelText("Title"), "Load");
    await userEvent.click(screen.getByRole("radio", { name: "LV Panel 1" }));
    await userEvent.type(screen.getByLabelText("Gauge maximum"), "250"); // "2", "25" and "250" are each a valid maximum
    await screen.findByTestId("chart");
    const gauges = previews(calls).filter((c) => (c.body as { type: string }).type === "gauge");
    expect(gauges).toHaveLength(1);
    expect((gauges[0].body as { config: { max: number } }).config.max).toBe(250);
  });

  it("never asks the API about a form that is not valid yet, even when it just became valid", async () => {
    const { calls } = open();
    await userEvent.type(screen.getByLabelText("Title"), "Hall power");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await screen.findByTestId("chart");
    for (const call of previews(calls)) expect((call.body as { config: { assets: number[] } }).config.assets).toEqual([5]);
  });

  it("registers under a key of its own, so it cannot withdraw a dashboard widget from the live values", async () => {
    const [draft] = toDrafts([widget(1, "stat", { title: "Now", config: config({ aggregation: "last" }) })]);
    mockFetch({ ...authed("operator"), "POST /api/widget-data": widgetDataRoute });
    const register = vi.fn();
    renderWithProviders(
      <LiveValuesContext.Provider value={{ values: new Map(), connected: false, register }}>
        <WidgetEditor initial={draft} assets={assetList} metricAssets={POWER} dashboardRange="24h" timezone="Asia/Qatar" onSave={vi.fn()} onClose={vi.fn()} />
      </LiveValuesContext.Provider>,
    );
    await screen.findByText(/10\.5/); // the stat's figure: the preview is up
    const owners = register.mock.calls.map(([owner]) => owner);
    expect(owners.length).toBeGreaterThan(0);
    expect(owners).not.toContain(draft.key);
  });
});
