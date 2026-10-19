import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Metric } from "../../api/types";
import { toDrafts, type DraftWidget } from "../../lib/layout";
import { assetList, authed, config, textWidget, widget, widgetDataRoute } from "../../test/dashboardFixtures";
import { mockFetch } from "../../test/fetchMock";
import { renderWithProviders } from "../../test/render";
import { LiveValuesContext } from "./LiveValuesContext";
import { WidgetEditor } from "./WidgetEditor";
import { WidgetView } from "./WidgetView";

vi.mock("echarts-for-react", () => ({ default: (props: { option: unknown }) => <pre data-testid="chart">{JSON.stringify(props.option)}</pre> }));

type Call = { method: string; path: string; body: unknown };
/** Assets 5 and 6 are mapped to active power; nothing else is mapped to anything (what the discovery graph says in these tests). */
const POWER = new Map<Metric, Set<number>>([["active_power_kw", new Set([5, 6])]]);

function open(initial: DraftWidget | null = null, metricAssets: Map<Metric, Set<number>> = POWER, otherTitles: string[] = []) {
  const calls = mockFetch({ ...authed("operator"), "POST /api/widget-data": widgetDataRoute });
  const onSave = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <WidgetEditor initial={initial} assets={assetList} metricAssets={metricAssets} dashboardRange="24h" timezone="Asia/Qatar" otherTitles={otherTitles} onSave={onSave} onClose={onClose} />,
  );
  return { calls, onSave, onClose };
}
const save = () => screen.getByRole("button", { name: "Save widget" });
const previews = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/widget-data");
const optionTexts = (label: string) => within(screen.getByLabelText(label)).getAllByRole("option").map((o) => o.textContent);
/** The checkboxes of the asset picker (the dialog has others: the comparison box). */
const pickerBoxes = () => within(screen.getByRole("group", { name: "Assets" })).getAllByRole("checkbox");
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
    expect(within(screen.getByRole("group", { name: "Asset" })).getAllByRole("radio")).toHaveLength(2); // the default metric is active power: only assets 5 and 6 are mapped to it (the scope has radios of its own)
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
    // Energy and cost also offer the comparison box, so the asset checkboxes are read inside the picker.
    expect(pickerBoxes().map((box) => box.parentElement?.textContent)).toEqual(["Site", "MV2", "LV Panel 1", "LV Panel 2"]);
    await userEvent.selectOptions(screen.getByLabelText("Source"), "cost");
    expect(pickerBoxes()).toHaveLength(4);
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

  it("clears a typed search on Escape and keeps the dialog open; a second Escape closes it", async () => {
    const { onClose } = open();
    const box = screen.getByLabelText("Search assets");
    await userEvent.type(box, "Panel");
    expect(box).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(box).toHaveValue("");
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("narrows the checkboxes to what is typed in Search assets", async () => {
    open();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    await userEvent.type(screen.getByLabelText("Search assets"), "Panel 1");
    expect(screen.getAllByRole("checkbox").map((box) => box.parentElement?.textContent)).toEqual(["LV Panel 1"]);
    // Energy offers every asset, so the site and MV2 stay as ordinary rows on the way to the match.
    await userEvent.selectOptions(screen.getByLabelText("Source"), "energy");
    expect(pickerBoxes().map((box) => box.parentElement?.textContent)).toEqual(["Site", "MV2", "LV Panel 1"]);
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
    expect(screen.getByText("2 selected (up to 20)")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Metric"), "voltage_v");
    expect(screen.queryByRole("checkbox", { name: /LV Panel 1/ })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "LV Panel 2" })).toBeChecked();
    expect(screen.getByText("1 selected (up to 20)")).toBeInTheDocument();
  });

  it("says so when no asset has the metric, and cannot be saved", async () => {
    open(null, MAPPED);
    await userEvent.type(screen.getByLabelText("Title"), "F");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.selectOptions(screen.getByLabelText("Metric"), "frequency_hz");
    expect(screen.getByText("No asset has a mapping for frequency_hz; choose another metric.")).toBeInTheDocument();
    expect(screen.getByText("0 selected (up to 20)")).toBeInTheDocument();
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
    expect(screen.getByText("1 selected (up to 20)")).toBeInTheDocument();
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
    await screen.findByRole("meter"); // the gauge is an SVG arc with a meter role, not an ECharts canvas
    const gauges = previews(calls).filter((c) => (c.body as { type: string }).type === "gauge");
    expect(gauges).toHaveLength(1);
    expect((gauges[0].body as { config: { max: number } }).config.max).toBe(250);
  });

  it("is the real widget card of the dashboard, without its Details and CSV buttons, in a box that knows the type", async () => {
    // The same stat config drawn once the way a dashboard draws it, once in the dialog's preview: the card has the same shape and text.
    const [draft] = toDrafts([widget(1, "stat", { title: "Hall power", config: config({ aggregation: "last" }) })]);
    mockFetch({ ...authed("operator"), "POST /api/widget-data": widgetDataRoute });
    renderWithProviders(<WidgetView widgetKey="1" type="stat" title="Hall power" config={config({ aggregation: "last" })} dashboardRange="24h" timezone="Asia/Qatar" />);
    const dashboardCard = await screen.findByRole("region", { name: "Hall power" });
    await within(dashboardCard).findByText("10.50");
    const shape = (card: HTMLElement) => {
      const tools = card.querySelector(".widget-tools");
      const parts = [card, ...card.querySelectorAll<HTMLElement>("*")].filter((el) => !tools?.contains(el));
      return { tags: parts.map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].sort().join(".")}`), text: parts.map((el) => el.textContent).join("|") };
    };
    const inDashboard = shape(dashboardCard);
    cleanup();
    open(draft);
    const previewCard = await screen.findByRole("region", { name: "Hall power" });
    await within(previewCard).findByText("10.50");
    expect(previewCard.closest(".widget-preview")).toHaveAttribute("data-type", "stat");
    expect(previewCard.tagName).toBe("SECTION");
    expect([...previewCard.classList]).toEqual([...dashboardCard.classList]);
    expect(shape(previewCard)).toEqual(inDashboard);
    expect(within(previewCard).queryByRole("button", { name: /^Details for/ })).not.toBeInTheDocument();
    expect(within(previewCard).queryByRole("button", { name: /^Download CSV/ })).not.toBeInTheDocument();
    expect(within(previewCard).getByRole("heading", { level: 2, name: "Hall power" })).toBeInTheDocument();
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
        <WidgetEditor initial={draft} assets={assetList} metricAssets={POWER} dashboardRange="24h" timezone="Asia/Qatar" otherTitles={[]} onSave={vi.fn()} onClose={vi.fn()} />
      </LiveValuesContext.Provider>,
    );
    await screen.findByText(/10\.5/); // the stat's figure: the preview is up
    const owners = register.mock.calls.map(([owner]) => owner);
    expect(owners.length).toBeGreaterThan(0);
    expect(owners).not.toContain(draft.key);
  });
});

describe("a text widget", () => {
  const EMOJI = String.fromCodePoint(0x1f600);
  const type = () => screen.getByLabelText("Type");
  const title = () => screen.getByLabelText("Title");
  const text = () => screen.getByLabelText("Text");
  const typeText = async (words: string) => {
    await userEvent.click(text());
    await userEvent.paste(words);
  };
  const choose = async (kind: string) => userEvent.selectOptions(type(), kind);
  const style = (name: string) => userEvent.selectOptions(screen.getByLabelText("Style"), name);
  const preview = () => document.querySelector<HTMLElement>(".widget-preview");

  it("is the last choice of Type, and shows Type, Title, Style and Text only", async () => {
    open();
    expect(optionTexts("Type")).toEqual(["Time series", "Bar chart", "Stat", "Gauge", "Table", "Text"]);
    await choose("text");
    expect(screen.getByLabelText("Style")).toHaveValue("heading");
    expect(optionTexts("Style")).toEqual(["Heading", "Paragraph", "Divider"]);
    expect(text().tagName).toBe("TEXTAREA");
    expect(text()).toHaveAttribute("rows", "5");
    expect(text()).not.toHaveAttribute("maxlength");
    for (const hidden of [
      "Source", "Metric", "Aggregation", "Widget range", "Bars", "Gauge minimum", "Gauge maximum",
      "Compare with the same days of last month", "One bar for each", "Bars to show",
    ]) expect(screen.queryByLabelText(hidden)).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Look under" })).not.toBeInTheDocument(); // a legend, not a label: found by its group (see the kind mode tests)
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument(); // the asset picker
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByText(/mapping for/)).not.toBeInTheDocument();
    expect(screen.queryByText(/removed asset/)).not.toBeInTheDocument();
    expect(screen.getAllByLabelText(/type/i)).toHaveLength(1); // no new label may match an existing lookup by substring
    expect(screen.getAllByLabelText(/title/i)).toHaveLength(1);
  });

  it("keeps the focus on Title when it opens and on Type when the type changes", async () => {
    open();
    expect(title()).toHaveFocus();
    await choose("text");
    expect(type()).toHaveFocus();
    await choose("stat");
    expect(type()).toHaveFocus();
  });

  it("counts characters in a line of its own under the text, tied to it, and not announced", async () => {
    open();
    await choose("text");
    expect(text()).toHaveAccessibleDescription("0 of 200 characters");
    const counter = screen.getByText("0 of 200 characters");
    expect(counter).toHaveAttribute("id", text().getAttribute("aria-describedby"));
    expect(counter).not.toHaveAttribute("aria-live");
    expect(counter).not.toHaveAttribute("role");
    expect(counter.closest("[aria-live]")).toBeNull();
    expect(counter.className).toContain("widget-text-count"); // the stylesheet reserves its line (min-height: 1lh)
    await style("paragraph");
    expect(screen.getByText("0 of 2,000 characters")).toBeInTheDocument();
    await typeText(`a${EMOJI}b`);
    expect(screen.getByText("3 of 2,000 characters")).toBeInTheDocument();
  });

  it("counts an emoji once and the normalized text, not what was typed", async () => {
    open();
    await choose("text");
    await typeText(EMOJI);
    expect(screen.getByText("1 of 200 characters")).toBeInTheDocument();
    await userEvent.clear(text());
    await typeText(`  ${EMOJI}${EMOJI}  `);
    expect(screen.getByText("2 of 200 characters")).toBeInTheDocument(); // the ends are trimmed
    await style("paragraph");
    await userEvent.clear(text());
    await typeText("one\r\ntwo");
    expect(screen.getByText("7 of 2,000 characters")).toBeInTheDocument(); // CRLF is one line feed
  });

  it("has no text and no counter for a divider, and gives them back with the style", async () => {
    open();
    await choose("text");
    await typeText("kept");
    await style("divider");
    expect(screen.queryByLabelText("Text")).not.toBeInTheDocument();
    expect(screen.queryByText(/characters$/)).not.toBeInTheDocument();
    await style("heading");
    expect(text()).toHaveValue("kept");
    expect(screen.getByText("4 of 200 characters")).toBeInTheDocument();
  });

  it("refuses a heading with a line break, and a text that is too long, and says why", async () => {
    const { onSave } = open();
    await choose("text");
    await userEvent.type(text(), "one{Enter}two");
    expect(screen.getByRole("list")).toHaveTextContent("A heading is one line.");
    expect(save()).toBeDisabled();
    expect(screen.getByText("Complete the form to see a preview.")).toBeInTheDocument();
    await style("paragraph");
    expect(save()).toBeEnabled(); // a paragraph may have line breaks
    await userEvent.clear(text());
    await typeText("a".repeat(2001));
    expect(screen.getByText("2,001 of 2,000 characters")).toBeInTheDocument(); // the counter says by how much
    expect(screen.getByText("The text can be at most 2,000 characters.")).toBeInTheDocument();
    expect(save()).toBeDisabled();
    await userEvent.click(save());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves the style and the normalized text: heading, paragraph, divider", async () => {
    const { onSave } = open();
    await choose("text");
    await typeText("  Cooling plant ");
    await userEvent.click(save());
    expect(onSave).toHaveBeenLastCalledWith({ type: "text", title: "Cooling plant", config: { style: "heading", text: "Cooling plant" } });
    await style("paragraph");
    await userEvent.clear(text());
    await typeText("  one\r\ntwo  ");
    await userEvent.click(save());
    expect(onSave).toHaveBeenLastCalledWith({ type: "text", title: "one", config: { style: "paragraph", text: "one\ntwo" } });
    await style("divider");
    await userEvent.click(save());
    expect(onSave).toHaveBeenLastCalledWith({ type: "text", title: "Divider", config: { style: "divider", text: "" } }); // the typed text is not sent
  });

  it("needs no text for a divider, even though text was typed before the style changed", async () => {
    open();
    await choose("text");
    expect(save()).toBeDisabled(); // a heading needs its text
    await style("divider");
    expect(save()).toBeEnabled();
    expect(within(preview()!).getByRole("separator")).toBeInTheDocument();
  });

  describe("the title", () => {
    it("follows the text until the person types a title", async () => {
      open();
      await choose("text");
      expect(title()).toHaveValue("Heading");
      await typeText("Cooling plant");
      expect(title()).toHaveValue("Cooling plant");
      await style("paragraph");
      await userEvent.clear(text());
      await typeText("First line\nsecond line");
      expect(title()).toHaveValue("First line");
      await userEvent.clear(title());
      await userEvent.type(title(), "Mine");
      await userEvent.clear(text());
      await typeText("Another text");
      expect(title()).toHaveValue("Mine");
      await style("divider");
      expect(title()).toHaveValue("Mine");
    });

    it("cuts a long first line at 40 characters with one ellipsis", async () => {
      open();
      await choose("text");
      await typeText("a".repeat(45));
      expect(title()).toHaveValue(`${"a".repeat(40)}…`);
    });

    it("takes the first free name among the other widgets' titles", async () => {
      open(null, POWER, ["Divider", "Hall A"]);
      await choose("text");
      await style("divider");
      expect(title()).toHaveValue("Divider 2");
      await style("heading");
      await typeText("Hall A");
      expect(title()).toHaveValue("Hall A 2"); // two headings with one first line
    });

    it("is cleared when the type changes to a data type before the title was typed, and a typed title is kept", async () => {
      open();
      await choose("text");
      await typeText("Cooling plant");
      expect(title()).toHaveValue("Cooling plant");
      await choose("stat");
      expect(title()).toHaveValue("");
      await choose("text");
      expect(title()).toHaveValue("Cooling plant"); // the text came back with the type, and so does its automatic title
      await userEvent.type(title(), "!");
      await choose("table");
      expect(title()).toHaveValue("Cooling plant!");
    });

    it("keeps a data widget's title when it becomes a text widget and back", async () => {
      open();
      await userEvent.type(title(), "Hall power");
      await choose("text");
      expect(title()).toHaveValue("Hall power");
      await choose("bar");
      expect(title()).toHaveValue("Hall power");
    });

    it("does not prefill when an existing text widget is edited", async () => {
      const [draft] = toDrafts([textWidget(1, "paragraph", "Some words", { title: "Notes" })]);
      const { onSave } = open(draft, POWER, ["Notes 2"]);
      expect(screen.getByRole("dialog", { name: "Edit widget" })).toBeInTheDocument();
      expect(title()).toHaveValue("Notes");
      expect(screen.getByLabelText("Style")).toHaveValue("paragraph");
      expect(text()).toHaveValue("Some words");
      await userEvent.clear(text());
      await typeText("Other words");
      await style("heading");
      expect(title()).toHaveValue("Notes");
      await choose("stat");
      expect(title()).toHaveValue("Notes");
      await choose("text");
      await userEvent.click(save());
      expect(onSave).toHaveBeenCalledWith({ type: "text", title: "Notes", config: { style: "heading", text: "Other words" } });
    });
  });

  describe("the preview", () => {
    it("draws at once, from the form, and asks the API nothing", async () => {
      const { calls } = open();
      await choose("text");
      expect(screen.getByText("Complete the form to see a preview.")).toBeInTheDocument();
      await typeText("Cooling plant");
      // No debounce: the card is there in the same step as the text.
      expect(preview()).toHaveAttribute("data-type", "text");
      expect(within(preview()!).getByRole("heading", { level: 2, name: "Cooling plant" })).toBeInTheDocument();
      await style("paragraph");
      expect(within(preview()!).getByRole("region", { name: "Cooling plant" })).toHaveTextContent("Cooling plant");
      await style("divider");
      expect(within(preview()!).getByRole("separator")).toBeInTheDocument();
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); }); // longer than the data preview's delay; the settled copy of the form updates inside it
      expect(previews(calls)).toHaveLength(0);
      expect(within(preview()!).queryByRole("button")).not.toBeInTheDocument();
    });

    it("shows the text literally", async () => {
      open();
      await choose("text");
      await style("paragraph");
      await typeText("<b>x</b>");
      expect(preview()!.querySelector("b")).toBeNull();
      expect(within(preview()!).getByText("<b>x</b>")).toBeInTheDocument();
    });
  });

  it("restores the data form after Text -> Time series, and the text after Time series -> Text", async () => {
    const { onSave } = open();
    await userEvent.type(title(), "Hall power");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.selectOptions(screen.getByLabelText("Source"), "energy");
    await choose("text");
    await typeText("Words");
    await choose("timeseries");
    expect(screen.getByLabelText("Source")).toHaveValue("energy");
    expect(screen.getByRole("checkbox", { name: "LV Panel 1" })).toBeChecked();
    expect(title()).toHaveValue("Hall power");
    expect(screen.queryByLabelText("Text")).not.toBeInTheDocument();
    await choose("text");
    expect(text()).toHaveValue("Words");
    await choose("timeseries");
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith({
      type: "timeseries", title: "Hall power", config: { ...power, source: "energy", metric: null, aggregation: "sum" },
    });
  });

  it("opens a text widget with the data form blank behind it", async () => {
    const [draft] = toDrafts([textWidget(1, "heading", "Plant", { title: "Plant" })]);
    open(draft);
    await choose("stat");
    expect(screen.getByLabelText("Source")).toHaveValue("metric");
    expect(within(screen.getByRole("group", { name: "Asset" })).getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByText("Choose an asset.")).toBeInTheDocument();
  });
});

// w24: the comparison box and the bar chart with one bar per asset of a kind.
const KINDS = [
  { id: 1, name: "Rack", icon: "rack", asset_count: 4, starter: true },
  { id: 2, name: "Panel", icon: "panel", asset_count: 2, starter: true },
];
const COMPARE = "Compare with the same days of last month";

function openW24(initial: DraftWidget | null = null) {
  const calls = mockFetch({ ...authed("operator"), "POST /api/widget-data": widgetDataRoute, "GET /api/asset-kinds": { body: KINDS } });
  const onSave = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <WidgetEditor initial={initial} assets={assetList} metricAssets={POWER} dashboardRange="24h" timezone="Asia/Qatar" otherTitles={[]} onSave={onSave} onClose={onClose} />,
  );
  return { calls, onSave, onClose };
}
/** The last call of `onSave`: what the dialog would store. */
const saved = (onSave: ReturnType<typeof vi.fn>) => onSave.mock.calls[onSave.mock.calls.length - 1][0];
const choose = (label: string, value: string) => userEvent.selectOptions(screen.getByLabelText(label), value);
const kindsAsked = (calls: Call[]) => calls.filter((c) => c.path === "/api/asset-kinds");

describe("the comparison box", () => {
  it("is offered for a stat and a time series on energy or cost, and for no other widget", async () => {
    openW24();
    expect(screen.queryByLabelText(COMPARE)).not.toBeInTheDocument(); // the default is a time series on a metric
    await choose("Source", "energy");
    expect(screen.getByRole("checkbox", { name: COMPARE })).not.toBeChecked();
    await choose("Source", "cost");
    expect(screen.getByRole("checkbox", { name: COMPARE })).toBeInTheDocument();
    await choose("Type", "stat");
    expect(screen.getByRole("checkbox", { name: COMPARE })).toBeInTheDocument();
    for (const type of ["bar", "table", "gauge"]) {
      await choose("Type", type);
      expect(screen.queryByLabelText(COMPARE), type).not.toBeInTheDocument();
    }
  });

  it("sits after Widget range and before Bars, and its tip is a button that submits nothing", async () => {
    openW24();
    await choose("Type", "bar");
    await choose("Source", "energy");
    await choose("Type", "stat");
    const range = screen.getByLabelText("Widget range");
    const box = screen.getByRole("checkbox", { name: COMPARE });
    expect(range.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const tip = within(box.closest(".has-tip") as HTMLElement).getByRole("button", { name: "What does this mean?" });
    expect(tip).toHaveAttribute("type", "button");
    // The box and its words are an inline label (the stylesheet keeps the field's negative margin off it) in a wrapper that shrinks to them, so the tip follows the words.
    expect(box.closest("label")).toHaveClass("inline");
    expect(box.closest(".has-tip")).toHaveClass("compare-field");
    expect(box.closest("label")?.nextElementSibling).toBe(tip.closest(".tip"));
    await userEvent.click(tip);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(/complete days/);
    expect(note).toHaveTextContent(/the 1st/);
    expect(note).toHaveTextContent(/same number of days/);
  });

  it("locks the range to this month with a sentence, makes the picker single and saves 'same_days_last_month'", async () => {
    const { onSave } = openW24();
    await choose("Type", "stat");
    await choose("Source", "energy");
    await choose("Widget range", "7d");
    await userEvent.type(screen.getByLabelText("Title"), "MTD");
    const sentence = screen.getByText(/A comparison always looks at this month so far, against the same days of last month\./);
    expect(sentence).not.toBeVisible(); // its slot is reserved, so ticking the box moves nothing
    await userEvent.click(screen.getByRole("checkbox", { name: COMPARE }));
    expect(screen.getByLabelText("Widget range")).toBeDisabled();
    expect(screen.getByLabelText("Widget range")).toHaveValue("this_month");
    expect(sentence).toBeVisible();
    expect(screen.getByLabelText("Widget range")).toHaveAccessibleDescription(/this month so far/);
    await userEvent.click(screen.getByRole("radio", { name: "LV Panel 1" }));
    await userEvent.click(save());
    expect(saved(onSave)).toEqual({
      type: "stat", title: "MTD",
      config: { assets: [5], source: "energy", metric: null, aggregation: "sum", range: "this_month", bars: "asset", min: 0, max: null, compare: "same_days_last_month" },
    });
  });

  it("gives the range back when it is unticked", async () => {
    const { onSave } = openW24();
    await choose("Type", "stat");
    await choose("Source", "energy");
    await choose("Widget range", "7d");
    await userEvent.click(screen.getByRole("checkbox", { name: COMPARE }));
    await userEvent.click(screen.getByRole("checkbox", { name: COMPARE }));
    expect(screen.getByLabelText("Widget range")).toBeEnabled();
    expect(screen.getByLabelText("Widget range")).toHaveValue("7d");
    await userEvent.type(screen.getByLabelText("Title"), "S");
    await userEvent.click(screen.getByRole("radio", { name: "LV Panel 1" }));
    await userEvent.click(save());
    expect(saved(onSave).config).toMatchObject({ range: "7d" });
    expect(saved(onSave).config).not.toHaveProperty("compare");
  });

  it("turns a time series into a single-asset picker that keeps the first asset, and back", async () => {
    openW24();
    await choose("Source", "energy");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 2" }));
    expect(screen.getByText("2 selected (up to 20)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: COMPARE }));
    expect(within(screen.getByRole("group", { name: "Asset" })).getAllByRole("radio")).toHaveLength(4);
    expect(screen.getByRole("radio", { name: "LV Panel 1" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "LV Panel 2" })).not.toBeChecked();
    await userEvent.click(screen.getByRole("checkbox", { name: COMPARE }));
    expect(screen.getByRole("checkbox", { name: "LV Panel 1" })).toBeChecked(); // many again, with the one that was kept
    expect(screen.getByRole("checkbox", { name: "LV Panel 2" })).not.toBeChecked();
  });

  it("asks for exactly one asset while it is ticked", async () => {
    openW24();
    await choose("Source", "cost");
    await userEvent.type(screen.getByLabelText("Title"), "C");
    await userEvent.click(screen.getByRole("checkbox", { name: COMPARE }));
    expect(screen.getByText("A comparison needs exactly one asset.")).toBeInTheDocument();
    expect(screen.queryByText("Choose an asset.")).not.toBeInTheDocument();
    expect(save()).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: "LV Panel 2" }));
    expect(save()).toBeEnabled();
  });

  it("is unticked when the type or the source can no longer compare, and the range stays this month", async () => {
    const { onSave } = openW24();
    await choose("Source", "energy");
    await userEvent.click(screen.getByRole("checkbox", { name: COMPARE }));
    await choose("Type", "bar");
    expect(screen.queryByLabelText(COMPARE)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Widget range")).toBeEnabled();
    expect(screen.getByLabelText("Widget range")).toHaveValue("this_month");
    await userEvent.type(screen.getByLabelText("Title"), "B");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.click(save());
    expect(saved(onSave).config).toMatchObject({ range: "this_month", bars: "asset" });
    expect(saved(onSave).config).not.toHaveProperty("compare");
    await choose("Type", "stat"); // the box is back, unticked
    expect(screen.getByRole("checkbox", { name: COMPARE })).not.toBeChecked();
    await userEvent.click(screen.getByRole("checkbox", { name: COMPARE }));
    await choose("Source", "metric");
    expect(screen.queryByLabelText(COMPARE)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Widget range")).toBeEnabled();
  });

  it("opens a saved comparison ticked, with the range locked, and can be unticked", async () => {
    const saved_ = toDrafts([widget(1, "timeseries", {
      title: "MTD", config: config({ assets: [5], source: "cost", metric: null, aggregation: "sum", range: "this_month", compare: "same_days_last_month" }),
    })])[0];
    const { onSave } = openW24(saved_);
    expect(screen.getByRole("checkbox", { name: COMPARE })).toBeChecked();
    expect(screen.getByLabelText("Widget range")).toBeDisabled();
    expect(screen.getByRole("radio", { name: "LV Panel 1" })).toBeChecked();
    await userEvent.click(save());
    expect(saved(onSave).config).toMatchObject({ compare: "same_days_last_month", range: "this_month", assets: [5] });
    await userEvent.click(screen.getByRole("checkbox", { name: COMPARE }));
    await userEvent.click(save());
    expect(saved(onSave).config).not.toHaveProperty("compare");
  });

  it("can be reached with the keyboard and ticked with Space", async () => {
    openW24();
    await choose("Source", "energy");
    screen.getByLabelText("Widget range").focus();
    await userEvent.tab();
    expect(screen.getByRole("checkbox", { name: COMPARE })).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(screen.getByRole("checkbox", { name: COMPARE })).toBeChecked();
    await userEvent.tab();
    expect(within(screen.getByRole("checkbox", { name: COMPARE }).closest(".has-tip") as HTMLElement).getByRole("button", { name: "What does this mean?" })).toHaveFocus();
  });
});

describe("one bar per asset of a kind", () => {
  const BARS = "One bar per asset of a kind";
  /** A bar chart on energy, with the kind mode chosen. */
  async function kindMode(initial: DraftWidget | null = null) {
    const opened = openW24(initial);
    if (!initial) {
      await choose("Type", "bar");
      await choose("Source", "energy");
      await choose("Bars", "kind");
    }
    return opened;
  }
  const lookUnder = () => screen.getByRole("group", { name: "Look under" });

  it("offers the choice for energy and cost only", async () => {
    openW24();
    await choose("Type", "bar");
    expect(optionTexts("Bars")).toEqual(["One bar per asset", "One bar per time bucket"]);
    await choose("Source", "energy");
    expect(optionTexts("Bars")).toEqual(["One bar per asset", "One bar per time bucket", BARS]);
    await choose("Source", "cost");
    expect(optionTexts("Bars")).toContain(BARS);
  });

  it("replaces the Assets picker with Look under, One bar for each and Bars to show, and clears the assets", async () => {
    const { calls } = openW24();
    await choose("Type", "bar");
    await choose("Source", "energy");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    expect(kindsAsked(calls)).toHaveLength(0); // nothing asks for the kinds before the mode is chosen
    await choose("Bars", "kind");
    expect(screen.queryByRole("group", { name: "Assets" })).not.toBeInTheDocument();
    expect(lookUnder()).toBeInTheDocument();
    expect(screen.getAllByLabelText("Search assets")).toHaveLength(1); // never two pickers: the search and the kind filter stay unique
    expect(screen.getAllByLabelText("Filter by kind")).toHaveLength(1);
    expect(screen.getByLabelText("One bar for each")).toHaveValue("");
    expect(screen.getByLabelText("Bars to show")).toHaveValue(10);
    expect(within(lookUnder()).getAllByRole("radio")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Whole site" })).toHaveAttribute("type", "button");
    expect(screen.getByText("Under: Whole site")).toBeInTheDocument();
    await waitFor(() => expect(kindsAsked(calls)).toHaveLength(1));
    // going back brings the Assets picker, empty: the pick was cleared
    await choose("Bars", "asset");
    expect(screen.getByRole("group", { name: "Assets" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Look under" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "LV Panel 1" })).not.toBeChecked();
  });

  it("asks for the kind, saves without assets, and leaves root and top out at their defaults", async () => {
    const { onSave } = await kindMode();
    await userEvent.type(screen.getByLabelText("Title"), "Racks");
    expect(screen.getByText("Enter the kind of asset to draw one bar for.")).toBeInTheDocument();
    expect(screen.queryByText("Choose at least one asset.")).not.toBeInTheDocument();
    expect(save()).toBeDisabled();
    await userEvent.type(screen.getByLabelText("One bar for each"), "  Rack ");
    expect(save()).toBeEnabled();
    await userEvent.click(save());
    expect(saved(onSave)).toEqual({
      type: "bar", title: "Racks",
      config: { assets: [], source: "energy", metric: null, aggregation: "sum", range: null, bars: "kind", min: 0, max: null, kind: "Rack" },
    });
  });

  it("previews the real card once the kind is entered", async () => {
    const { calls } = await kindMode();
    await userEvent.type(screen.getByLabelText("Title"), "Racks");
    await userEvent.type(screen.getByLabelText("One bar for each"), "Rack");
    await waitFor(() => expect(previews(calls)).toHaveLength(1));
    expect(previews(calls)[0].body).toEqual({
      type: "bar", range: "24h",
      config: { assets: [], source: "energy", metric: null, aggregation: "sum", range: null, bars: "kind", min: 0, max: null, kind: "Rack" },
    });
  });

  it("suggests the kinds of the registry", async () => {
    await kindMode();
    const input = screen.getByLabelText("One bar for each");
    const list = document.getElementById(input.getAttribute("list") as string);
    expect(list?.tagName).toBe("DATALIST");
    await waitFor(() => expect([...(list as HTMLElement).querySelectorAll("option")].map((o) => o.getAttribute("value"))).toEqual(["Rack", "Panel"]));
  });

  it("looks under one asset, says which in words, and 'Whole site' clears it and keeps the focus", async () => {
    const { onSave } = await kindMode();
    await userEvent.type(screen.getByLabelText("Title"), "Racks");
    await userEvent.type(screen.getByLabelText("One bar for each"), "Panel");
    await userEvent.click(within(lookUnder()).getByRole("radio", { name: "MV2" }));
    expect(screen.getByText("Under: MV2")).toBeInTheDocument();
    await userEvent.click(save());
    expect(saved(onSave).config).toMatchObject({ bars: "kind", kind: "Panel", root: 2, assets: [] });
    const whole = screen.getByRole("button", { name: "Whole site" });
    await userEvent.click(whole);
    expect(screen.getByText("Under: Whole site")).toBeInTheDocument();
    expect(within(lookUnder()).getByRole("radio", { name: "MV2" })).not.toBeChecked();
    expect(whole).toHaveFocus(); // never the page
    expect(document.body).not.toHaveFocus();
    await userEvent.click(whole); // already the whole site: nothing happens, the focus stays
    expect(whole).toHaveFocus();
    await userEvent.click(save());
    expect(saved(onSave).config).not.toHaveProperty("root");
  });

  it("saves the number of bars when it is not 10, and refuses a number outside 3 to 50", async () => {
    const { onSave } = await kindMode();
    await userEvent.type(screen.getByLabelText("Title"), "Racks");
    await userEvent.type(screen.getByLabelText("One bar for each"), "Rack");
    const top = screen.getByLabelText("Bars to show");
    await userEvent.clear(top);
    await userEvent.type(top, "2");
    expect(screen.getByText("Bars to show must be a whole number from 3 to 50.")).toBeInTheDocument();
    expect(save()).toBeDisabled();
    await userEvent.clear(top);
    await userEvent.type(top, "25");
    expect(save()).toBeEnabled();
    await userEvent.click(save());
    expect(saved(onSave).config).toMatchObject({ kind: "Rack", top: 25 });
  });

  it("says the one-level rule in a tip, and Escape closes the tip and not the dialog", async () => {
    const { onClose } = await kindMode();
    const tip = within(screen.getByLabelText("One bar for each").closest(".has-tip") as HTMLElement).getByRole("button", { name: "What does this mean?" });
    expect(tip).toHaveAttribute("type", "button");
    await userEvent.click(tip);
    expect(screen.getByRole("note")).toHaveTextContent("Choose the level that carries the meters, for example Panels or Racks. Each bar is that asset's own reading.");
    expect(screen.getByRole("note")).toHaveTextContent("a total over both counts the same energy twice");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("goes back to one bar per asset when the source becomes a metric", async () => {
    await kindMode();
    await choose("Source", "metric");
    expect(screen.getByLabelText("Bars")).toHaveValue("asset");
    expect(optionTexts("Bars")).toEqual(["One bar per asset", "One bar per time bucket"]);
    expect(screen.getByRole("group", { name: "Assets" })).toBeInTheDocument();
    expect(screen.queryByLabelText("One bar for each")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Bars to show")).not.toBeInTheDocument();
  });

  it("keeps the kind, the place and the number for when the choice comes back", async () => {
    await kindMode();
    await userEvent.type(screen.getByLabelText("One bar for each"), "Rack");
    await userEvent.click(within(lookUnder()).getByRole("radio", { name: "MV2" }));
    await choose("Bars", "time");
    expect(screen.queryByLabelText("One bar for each")).not.toBeInTheDocument();
    await choose("Bars", "kind");
    expect(screen.getByLabelText("One bar for each")).toHaveValue("Rack");
    expect(screen.getByText("Under: MV2")).toBeInTheDocument();
  });

  it("opens a saved breakdown with its kind, place and number, and saves it unchanged", async () => {
    const draft = toDrafts([widget(1, "bar", {
      title: "Racks",
      config: config({ assets: [], source: "cost", metric: null, aggregation: "sum", range: "this_month", bars: "kind", kind: "Rack", root: 2, top: 25 }),
    })])[0];
    const { onSave } = await kindMode(draft);
    expect(screen.getByLabelText("Bars")).toHaveValue("kind");
    expect(screen.getByLabelText("One bar for each")).toHaveValue("Rack");
    expect(screen.getByLabelText("Bars to show")).toHaveValue(25);
    expect(screen.getByText("Under: MV2")).toBeInTheDocument();
    expect(within(lookUnder()).getByRole("radio", { name: "MV2" })).toBeChecked();
    await userEvent.click(save());
    expect(saved(onSave)).toEqual({ type: "bar", title: "Racks", config: draft.config });
  });

  it("shows a place that was deleted as the whole site, with a note", async () => {
    const draft = toDrafts([widget(1, "bar", {
      title: "Racks", config: config({ assets: [], source: "energy", metric: null, aggregation: "sum", bars: "kind", kind: "Rack", root: 99 }),
    })])[0];
    const { onSave } = await kindMode(draft);
    expect(screen.getByText("Under: Whole site")).toBeInTheDocument();
    expect(screen.getByText(/looked under was removed/)).toBeVisible();
    await userEvent.click(save());
    expect(saved(onSave).config).not.toHaveProperty("root");
  });

  it("says the removed place only while the form still looks at the whole site: a new pick hides the note (its line stays), 'Whole site' brings it back", async () => {
    const draft = toDrafts([widget(1, "bar", {
      title: "Racks", config: config({ assets: [], source: "energy", metric: null, aggregation: "sum", bars: "kind", kind: "Rack", root: 99 }),
    })])[0];
    await kindMode(draft);
    const note = screen.getByText(/looked under was removed/);
    expect(note).toBeVisible();
    await userEvent.click(within(lookUnder()).getByRole("radio", { name: "MV2" }));
    expect(screen.getByText("Under: MV2")).toBeInTheDocument();
    expect(note, "kept in the layout so nothing below it moves").toBeInTheDocument();
    expect(note).not.toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Whole site" }));
    expect(note).toBeVisible();
  });

  it("shows no such line at all for a saved place that still exists", async () => {
    await kindMode();
    expect(screen.queryByText(/looked under was removed/)).not.toBeInTheDocument();
  });

  it("marks 'Whole site' aria-disabled (not disabled) while the whole site is chosen, and not once a place is picked", async () => {
    await kindMode();
    const whole = screen.getByRole("button", { name: "Whole site" });
    expect(whole).toHaveAttribute("aria-disabled", "true");
    expect(whole).toBeEnabled();
    expect(whole).toHaveClass("quiet", "whole-site"); // the disabled look is the editor's own class: the picker's Clear all is a quiet aria-disabled button too, with its own look
    await userEvent.click(within(lookUnder()).getByRole("radio", { name: "MV2" }));
    expect(whole).not.toHaveAttribute("aria-disabled");
    await userEvent.click(whole);
    expect(whole).toHaveAttribute("aria-disabled", "true");
  });

  it("has no label that a lookup by substring would find twice", async () => {
    await kindMode();
    for (const label of [/look under/i, /one bar for each/i, /bars to show/i]) {
      // Look under is the picker's legend (a group), the other two are labels
      expect(screen.queryAllByLabelText(label).length, String(label)).toBeLessThanOrEqual(1);
    }
    expect(screen.getAllByRole("group", { name: /look under/i })).toHaveLength(1);
    expect(screen.getAllByLabelText(/one bar for each/i)).toHaveLength(1);
    expect(screen.getAllByLabelText(/bars to show/i)).toHaveLength(1);
    expect(screen.getAllByLabelText(/source/i)).toHaveLength(1);
    expect(screen.getAllByLabelText(/type/i)).toHaveLength(1);
    expect(screen.getAllByLabelText(/title/i)).toHaveLength(1);
    expect(screen.getAllByLabelText(/metric|aggregation|widget range/i)).toHaveLength(2); // Aggregation and Widget range; the metric field is hidden for energy
  });
});

// w25: what the widget follows. A radio group "Show" near the asset field (chosen here, the focus asset, the children of the focus asset); a widget that
// follows draws no picker; a breakdown by kind keeps Look under and gains a second quiet button, "The focus asset", beside "Whole site".
describe("what the widget follows (w25)", () => {
  // user-event's arrow keys on a radio read window.CSS.escape, which jsdom 26 does not have: stub it here only.
  beforeEach(() => {
    vi.stubGlobal("CSS", { escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const HERE = "Assets chosen here";
  const FOCUS = "The focus asset";
  const CHILDREN = "The children of the focus asset";
  const scopeGroup = () => screen.getByRole("group", { name: "Show" });
  const scopeRadio = (name: string) => within(scopeGroup()).getByRole("radio", { name });
  const scopeNames = () => within(scopeGroup()).getAllByRole("radio").map((r) => r.parentElement?.textContent);
  const checkedScope = () => within(scopeGroup()).getAllByRole("radio").filter((r) => (r as HTMLInputElement).checked).map((r) => r.parentElement?.textContent);
  const pickerGroup = () => screen.queryByRole("group", { name: "Assets" });
  const draftOf = (type: "stat" | "timeseries" | "table" | "bar" | "gauge", over: Partial<ReturnType<typeof config>>, title = "Followed") =>
    toDrafts([widget(1, type, { title, config: config({ assets: [], ...over }) })])[0];

  it("offers chosen here first and checked, then the focus asset, then the children of the focus asset", () => {
    open();
    expect(scopeNames()).toEqual([HERE, FOCUS, CHILDREN]);
    expect(checkedScope()).toEqual([HERE]);
    expect(pickerGroup()).toBeInTheDocument();
  });

  it("offers the children only to a widget that can draw many assets, and not with the comparison", async () => {
    open();
    for (const [type, names] of [
      ["stat", [HERE, FOCUS]], ["gauge", [HERE, FOCUS]], ["table", [HERE, FOCUS, CHILDREN]], ["bar", [HERE, FOCUS, CHILDREN]], ["timeseries", [HERE, FOCUS, CHILDREN]],
    ] as const) {
      await choose("Type", type);
      expect(scopeNames(), type).toEqual(names);
    }
    await choose("Source", "energy"); // a time series on energy: the comparison box appears
    expect(screen.getAllByRole("button", { name: "What does this mean?" }), "the group adds no tip of its own: the comparison has the only one").toHaveLength(1);
    await userEvent.click(screen.getByRole("checkbox", { name: COMPARE }));
    expect(scopeNames()).toEqual([HERE, FOCUS]);
    await userEvent.click(screen.getByRole("checkbox", { name: COMPARE }));
    expect(scopeNames()).toEqual([HERE, FOCUS, CHILDREN]);
  });

  it("draws no group for a text widget, and finds the scope again when the type comes back", async () => {
    open();
    await userEvent.click(screen.getByRole("radio", { name: CHILDREN }));
    await choose("Type", "text");
    expect(screen.queryByRole("group", { name: "Show" })).not.toBeInTheDocument();
    await choose("Type", "table");
    expect(checkedScope()).toEqual([CHILDREN]);
  });

  it("takes the picker out of the page for the focus asset, says what it shows, and saves without assets", async () => {
    const { calls, onSave } = open();
    await userEvent.type(screen.getByLabelText("Title"), "Hall power");
    expect(save()).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: FOCUS }));
    expect(checkedScope()).toEqual([FOCUS]);
    expect(pickerGroup()).not.toBeInTheDocument(); // out of the DOM, not hidden
    expect(screen.queryByLabelText("Search assets")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText(/^Shows the asset chosen as the dashboard's focus\./)).toBeInTheDocument();
    expect(screen.queryByText("Choose at least one asset.")).not.toBeInTheDocument();
    expect(save()).toBeEnabled();
    const body = { type: "timeseries", range: "24h", config: { ...power, assets: [], scope: "focus" } };
    await waitFor(() => expect(previews(calls).map((c) => c.body)).toContainEqual(body));
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith({ type: "timeseries", title: "Hall power", config: { ...power, assets: [], scope: "focus" } });
  });

  it("says in plain words what the children are, per type, and what happens with no focus", async () => {
    open();
    await userEvent.click(screen.getByRole("radio", { name: CHILDREN }));
    expect(screen.getByText(/^Shows the children of the focus asset, one line each\./)).toHaveTextContent("With no focus it shows the top-level assets.");
    await choose("Type", "table");
    expect(screen.getByText(/one row each/)).toBeInTheDocument();
    await choose("Type", "bar");
    expect(screen.getByText(/one bar each/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: FOCUS }));
    expect(screen.getByText(/^Shows the asset chosen as the dashboard's focus\./)).toHaveTextContent("With no focus it shows the site's only top-level asset, or asks for a focus when there are several.");
  });

  it("saves the children of the focus for a table, with no assets", async () => {
    const { onSave } = open();
    await choose("Type", "table");
    await userEvent.type(screen.getByLabelText("Title"), "Per child");
    await userEvent.click(screen.getByRole("radio", { name: CHILDREN }));
    await userEvent.click(save());
    expect(saved(onSave)).toEqual({
      type: "table", title: "Per child",
      config: { assets: [], source: "metric", metric: "active_power_kw", aggregation: "avg", range: null, bars: "asset", min: 0, max: null, scope: "children" },
    });
  });

  it("keeps the picked assets while the widget follows, and shows them again when chosen here comes back", async () => {
    const { onSave } = open();
    await userEvent.type(screen.getByLabelText("Title"), "T");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.click(screen.getByRole("radio", { name: FOCUS }));
    await userEvent.click(save());
    expect(saved(onSave).config).toMatchObject({ assets: [], scope: "focus" });
    await userEvent.click(screen.getByRole("radio", { name: HERE }));
    expect(screen.getByRole("checkbox", { name: "LV Panel 1" })).toBeChecked();
    await userEvent.click(save());
    expect(saved(onSave).config).toMatchObject({ assets: [5] });
    expect(saved(onSave).config).not.toHaveProperty("scope");
  });

  it("leaves the scope key out of every widget that is not changed to follow", async () => {
    const { onSave } = open();
    await userEvent.type(screen.getByLabelText("Title"), "T");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.click(save());
    expect(saved(onSave).config).not.toHaveProperty("scope");
    expect(saved(onSave).config).toEqual(power);
  });

  it("turns the children into the focus asset when the type becomes a stat, and when the comparison is ticked", async () => {
    open();
    await userEvent.click(screen.getByRole("radio", { name: CHILDREN }));
    await choose("Type", "stat");
    expect(checkedScope()).toEqual([FOCUS]);
    expect(within(scopeGroup()).queryByRole("radio", { name: CHILDREN })).not.toBeInTheDocument();
    await choose("Type", "timeseries");
    await choose("Source", "cost");
    await userEvent.click(screen.getByRole("radio", { name: CHILDREN }));
    await userEvent.click(screen.getByRole("checkbox", { name: COMPARE }));
    expect(checkedScope()).toEqual([FOCUS]);
  });

  it("shows no group in the breakdown by kind (Look under is its control) and turns the children into the focus asset on the way in", async () => {
    openW24();
    await choose("Type", "bar");
    await choose("Source", "energy");
    await userEvent.click(screen.getByRole("radio", { name: CHILDREN }));
    await choose("Bars", "kind");
    expect(screen.queryByRole("group", { name: "Show" })).not.toBeInTheDocument();
    expect(screen.getByText("Under: The focus asset")).toBeInTheDocument();
    await choose("Bars", "time");
    expect(checkedScope()).toEqual([FOCUS]);
  });

  it("opens a saved Power-style widget (the focus asset, no assets, a comparison) and saves it unchanged", async () => {
    const draft = draftOf("stat", { source: "energy", metric: null, aggregation: "sum", range: "this_month", compare: "same_days_last_month", scope: "focus" }, "Energy this month");
    const { onSave } = open(draft);
    expect(checkedScope()).toEqual([FOCUS]);
    expect(pickerGroup()).not.toBeInTheDocument();
    expect(screen.getByLabelText("Widget range")).toBeDisabled();
    expect(screen.queryByText(/Choose an asset|exactly one asset/)).not.toBeInTheDocument();
    expect(save()).toBeEnabled();
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith({ type: "stat", title: "Energy this month", config: draft.config });
  });

  it("opens a saved widget that follows the children, and saves it unchanged", async () => {
    const draft = draftOf("timeseries", { scope: "children" });
    const { onSave } = open(draft);
    expect(checkedScope()).toEqual([CHILDREN]);
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith({ type: "timeseries", title: "Followed", config: draft.config });
  });

  it("keeps a comparison's range rule for a widget that follows", async () => {
    const draft = draftOf("stat", { source: "energy", metric: null, aggregation: "sum", range: "this_month", compare: "same_days_last_month", scope: "focus" });
    open(draft);
    await userEvent.click(screen.getByRole("checkbox", { name: COMPARE })); // untick: the range comes back as it was
    expect(screen.getByLabelText("Widget range")).toBeEnabled();
    await userEvent.selectOptions(screen.getByLabelText("Widget range"), "7d");
    await userEvent.click(screen.getByRole("checkbox", { name: COMPARE })); // tick again: this month
    expect(screen.getByLabelText("Widget range")).toHaveValue("this_month");
    expect(save()).toBeEnabled();
  });

  it("moves with the arrow keys from the keyboard, and keeps the focus on the radio", async () => {
    open();
    scopeRadio(HERE).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(checkedScope()).toEqual([FOCUS]);
    expect(scopeRadio(FOCUS)).toHaveFocus();
    expect(pickerGroup()).not.toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}");
    expect(checkedScope()).toEqual([CHILDREN]);
    expect(scopeRadio(CHILDREN)).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(checkedScope()).toEqual([HERE]);
    expect(scopeRadio(HERE)).toHaveFocus();
    expect(pickerGroup()).toBeInTheDocument();
  });

  it("is one Tab stop between the fields before it and the picker after it", async () => {
    open();
    screen.getByLabelText("Widget range").focus();
    await userEvent.tab();
    expect(scopeRadio(HERE)).toHaveFocus(); // the checked one is the stop; the others are reached by the arrows
    await userEvent.tab();
    expect(screen.getByLabelText("Search assets")).toHaveFocus();
  });

  it("has no name that a lookup by substring would find twice", () => {
    open();
    expect(screen.getAllByRole("group", { name: /show/i })).toHaveLength(1);
    expect(screen.getAllByRole("radio", { name: /chosen here/i })).toHaveLength(1);
    expect(screen.getAllByLabelText(/type/i)).toHaveLength(1);
    expect(screen.getAllByLabelText(/title/i)).toHaveLength(1);
    expect(screen.getAllByLabelText(/source/i)).toHaveLength(1);
    expect(screen.queryAllByLabelText(/look under|one bar for each|bars to show/i)).toHaveLength(0); // none of the kind fields is here
    expect(screen.getAllByRole("group", { name: "Assets" })).toHaveLength(1); // exactly one picker
    expect(scopeRadio(HERE).closest("label"), "label.inline is the comparison box's alone (an e2e lookup finds it by that)").not.toHaveClass("inline");
  });

  it("ties the sentence of a scope that follows to the group, and has none for the chosen assets", async () => {
    open();
    expect(scopeGroup()).not.toHaveAttribute("aria-describedby");
    await userEvent.click(screen.getByRole("radio", { name: FOCUS }));
    expect(scopeGroup()).toHaveAccessibleDescription(/^Shows the asset chosen as the dashboard's focus\./);
  });

  describe("a breakdown by kind", () => {
    const lookUnder = () => screen.getByRole("group", { name: "Look under" });
    const whole = () => screen.getByRole("button", { name: "Whole site" });
    const focusButton = () => screen.getByRole("button", { name: FOCUS });
    async function kindMode(initial: DraftWidget | null = null) {
      const opened = openW24(initial);
      if (!initial) {
        await choose("Type", "bar");
        await choose("Source", "energy");
        await choose("Bars", "kind");
        await userEvent.type(screen.getByLabelText("Title"), "Racks");
        await userEvent.type(screen.getByLabelText("One bar for each"), "Rack");
      }
      return opened;
    }

    it("gains a quiet button The focus asset beside Whole site, with the same aria-disabled pattern", async () => {
      await kindMode();
      expect(focusButton()).toHaveAttribute("type", "button");
      expect(focusButton()).toHaveClass("quiet", "whole-site"); // the editor's one aria-disabled look
      expect(focusButton()).toBeEnabled();
      expect(focusButton()).not.toHaveAttribute("aria-disabled");
      expect(whole()).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByText("Under: Whole site")).toBeInTheDocument();
      expect(focusButton().parentElement).toBe(whole().parentElement); // beside it, in the same row
    });

    it("looks under the focus: the live line says so, nothing is picked, and the config has the scope and no root", async () => {
      const { onSave, calls } = await kindMode();
      await userEvent.click(within(lookUnder()).getByRole("radio", { name: "MV2" }));
      expect(screen.getByText("Under: MV2")).toBeInTheDocument();
      await userEvent.click(focusButton());
      expect(screen.getByText("Under: The focus asset")).toBeInTheDocument();
      expect(within(lookUnder()).getByRole("radio", { name: "MV2" })).not.toBeChecked();
      expect(focusButton()).toHaveAttribute("aria-disabled", "true");
      expect(whole()).not.toHaveAttribute("aria-disabled");
      expect(focusButton()).toHaveFocus(); // never the page
      await userEvent.click(focusButton()); // already the focus asset: nothing happens
      expect(focusButton()).toHaveFocus();
      await userEvent.click(save());
      expect(saved(onSave)).toEqual({
        type: "bar", title: "Racks",
        config: { assets: [], source: "energy", metric: null, aggregation: "sum", range: null, bars: "kind", min: 0, max: null, kind: "Rack", scope: "focus" },
      });
      await waitFor(() => expect(previews(calls).map((c) => c.body)).toContainEqual({
        type: "bar", range: "24h",
        config: { assets: [], source: "energy", metric: null, aggregation: "sum", range: null, bars: "kind", min: 0, max: null, kind: "Rack", scope: "focus" },
      }));
    });

    it("goes back to a place of its own when one is picked, and to the whole site with Whole site", async () => {
      const { onSave } = await kindMode();
      await userEvent.click(focusButton());
      await userEvent.click(within(lookUnder()).getByRole("radio", { name: "MV2" }));
      expect(screen.getByText("Under: MV2")).toBeInTheDocument();
      expect(focusButton()).not.toHaveAttribute("aria-disabled");
      await userEvent.click(save());
      expect(saved(onSave).config).toMatchObject({ root: 2 });
      expect(saved(onSave).config).not.toHaveProperty("scope");
      await userEvent.click(focusButton());
      await userEvent.click(whole());
      expect(screen.getByText("Under: Whole site")).toBeInTheDocument();
      expect(whole()).toHaveAttribute("aria-disabled", "true");
      expect(whole()).toHaveFocus();
      await userEvent.click(save());
      expect(saved(onSave).config).not.toHaveProperty("scope");
      expect(saved(onSave).config).not.toHaveProperty("root");
    });

    it("opens a saved breakdown under the focus, says so, and saves it unchanged", async () => {
      const draft = draftOf("bar", { source: "cost", metric: null, aggregation: "sum", range: "this_month", bars: "kind", kind: "Rack", top: 5, scope: "focus" }, "Racks");
      const { onSave } = await kindMode(draft);
      expect(screen.getByText("Under: The focus asset")).toBeInTheDocument();
      expect(focusButton()).toHaveAttribute("aria-disabled", "true");
      expect(whole()).not.toHaveAttribute("aria-disabled");
      expect(within(lookUnder()).queryAllByRole("radio").filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);
      await userEvent.click(save());
      expect(saved(onSave)).toEqual({ type: "bar", title: "Racks", config: draft.config });
    });

    it("says the removed place only while the widget looks at the whole site, not under the focus", async () => {
      const draft = toDrafts([widget(1, "bar", {
        title: "Racks", config: config({ assets: [], source: "energy", metric: null, aggregation: "sum", bars: "kind", kind: "Rack", root: 99 }),
      })])[0];
      await kindMode(draft);
      const note = screen.getByText(/looked under was removed/);
      expect(note).toBeVisible();
      await userEvent.click(focusButton());
      expect(note).not.toBeVisible();
      await userEvent.click(whole());
      expect(note).toBeVisible();
    });

    it("has no name that a lookup by substring would find twice", async () => {
      await kindMode();
      expect(screen.getAllByRole("button", { name: /whole site/i })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: /focus asset/i })).toHaveLength(1);
      expect(screen.getAllByRole("group", { name: /look under/i })).toHaveLength(1);
      expect(screen.getAllByLabelText("Search assets")).toHaveLength(1);
    });
  });
});
