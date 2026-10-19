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
    expect(screen.getAllByRole("checkbox").map((box) => box.parentElement?.textContent)).toEqual(["Site", "MV2", "LV Panel 1"]);
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
    for (const hidden of ["Source", "Metric", "Aggregation", "Widget range", "Bars", "Gauge minimum", "Gauge maximum"]) expect(screen.queryByLabelText(hidden)).not.toBeInTheDocument();
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
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByText("Choose an asset.")).toBeInTheDocument();
  });
});
