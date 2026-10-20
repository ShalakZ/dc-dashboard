import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { keys } from "../../api/queries";
import type { Asset, WidgetConfig, WidgetData, DataWidgetType } from "../../api/types";
import { downloadCsv } from "../../lib/download";
import type { LiveValue } from "../../lib/stream";
import { parseRules, stripComments } from "../../test/cssTools";
import {
  breakdownBlock, breakdownData, compareAsset, compareBlock, compareChange, compareSide, compareStatData, config, seriesData, seriesPoint, valueRow, valuesData,
} from "../../test/dashboardFixtures";
import { LiveValuesContext } from "./LiveValuesContext";
import { WidgetDetails, type WidgetDetailsProps } from "./WidgetDetails";

const held = { ids: new Set<string>(["assets.view"]) };
vi.mock("../../auth/AuthProvider", () => ({ useAuth: () => ({ can: (id: string) => held.ids.has(id) }) }));
vi.mock("../../lib/download", () => ({ downloadCsv: vi.fn() }));

const TZ = "Asia/Qatar";
const NOW = Date.parse("2026-10-17T12:04:40+03:00"); // 12:04:40 in Qatar, 09:04:40 UTC
const at = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();
const LAST = (): WidgetConfig => config({ aggregation: "last" });
const assetRecord = (id: number, name: string): Asset => ({ id, parent_id: null, name, kind: "panel", sort_order: 0 });

interface Options { assets?: Asset[]; stream?: Map<number, LiveValue>; props?: Partial<WidgetDetailsProps> }
/** The drawer for `data`, in the providers the dashboard gives it. The clock is fixed at NOW, only `Date` and the interval timer are faked. */
function open(type: DataWidgetType, data: WidgetData, cfg: WidgetConfig, { assets, stream, props }: Options = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (assets) client.setQueryData(keys.assets, assets);
  const onClose = vi.fn();
  const live = { values: stream ?? new Map<number, LiveValue>(), connected: stream !== undefined, register: () => {} };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LiveValuesContext.Provider value={live}>{children}</LiveValuesContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const shown = render(
    <WidgetDetails title="Hall" type={type} data={data} config={cfg} timezone={TZ} following={false} onClose={onClose} {...props} />,
    { wrapper },
  );
  return { ...shown, onClose, dialog: () => screen.getByRole("dialog", { name: "Details: Hall" }) };
}
const sections = (dialog: HTMLElement) => within(dialog).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
const cellsOf = (row: HTMLElement) => within(row).getAllByRole("cell").map((c) => c.textContent);

beforeEach(() => {
  held.ids = new Set(["assets.view"]);
  vi.mocked(downloadCsv).mockReset();
  vi.mocked(downloadCsv).mockResolvedValue(undefined);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); });

describe("WidgetDetails: the frame", () => {
  it("is a dialog named 'Details: <title>' with the sections in order, and only the sections that apply", () => {
    const { dialog } = open("stat", valuesData({ type: "stat", values: [valueRow({ ts: at(9) })] }), LAST());
    expect(dialog()).toBeInTheDocument();
    expect(sections(dialog())).toEqual(["What it shows", "Time window", "Freshness"]); // no markers in this answer, nothing per asset to add
  });

  it("closes through the drawer's own close button", async () => {
    vi.useRealTimers();
    const { dialog, onClose } = open("stat", valuesData({ type: "stat" }), config());
    await userEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("WidgetDetails: what it shows and the time window", () => {
  it("names the type, the source with its unit, what one figure is, the assets, the window and what the figures are", () => {
    const { dialog } = open("stat", valuesData({ type: "stat", values: [valueRow({ ts: at(9) })] }), LAST());
    const d = dialog();
    const row = (label: string) => within(d).getByText(label, { selector: "dt" }).parentElement as HTMLElement;
    expect(row("Type")).toHaveTextContent("Stat");
    expect(row("Source")).toHaveTextContent("active_power_kw (kW)");
    expect(row("Figure")).toHaveTextContent("Latest reading");
    expect(row("Assets")).toHaveTextContent("LV Panel 1");
    expect(row("Window")).toHaveTextContent("2026-10-07 09:00 to 2026-10-08 09:00 (Asia/Qatar)");
    expect(row("Range")).toHaveTextContent("Last 24 hours");
    expect(row("Data")).toHaveTextContent("The latest reading of each asset");
  });

  it("links each asset to its page when the role may see assets, and writes plain names when it may not", () => {
    const data = valuesData({ type: "table", values: [valueRow(), valueRow({ asset_id: 6, name: "LV Panel 2", point_id: 8 })] });
    const first = open("table", data, config());
    expect(within(first.dialog()).getByRole("link", { name: "LV Panel 1" })).toHaveAttribute("href", "/assets/5");
    expect(within(first.dialog()).getByRole("link", { name: "LV Panel 2" })).toHaveAttribute("href", "/assets/6");
    first.unmount();
    held.ids = new Set();
    const second = open("table", data, config());
    expect(within(second.dialog()).queryByRole("link")).not.toBeInTheDocument();
    expect(within(second.dialog()).getByText("LV Panel 2", { selector: "li" })).toBeInTheDocument();
  });

  it("says how many assets were removed, and names the ones without the metric when the asset list is already cached", () => {
    const data = valuesData({ type: "table", missing: [99], no_metric: [6, 7] });
    const cached = open("table", data, config(), { assets: [assetRecord(6, "Chiller 1"), assetRecord(7, "Chiller 2")] });
    const out = within(cached.dialog()).getByText("Left out", { selector: "dt" }).parentElement as HTMLElement;
    expect(out).toHaveTextContent("1 asset removed");
    expect(out).toHaveTextContent("Without this metric: Chiller 1, Chiller 2");
    expect(within(out).getByRole("link", { name: "Chiller 1" })).toHaveAttribute("href", "/assets/6");
  });

  it("falls back to the count when the asset list is not cached (it is never fetched here) or lacks one of them", () => {
    const data = valuesData({ type: "table", missing: [], no_metric: [6, 7] });
    const none = open("table", data, config());
    expect(within(none.dialog()).getByText("2 assets without this metric")).toBeInTheDocument();
    none.unmount();
    const partial = open("table", data, config(), { assets: [assetRecord(6, "Chiller 1")] });
    expect(within(partial.dialog()).getByText("2 assets without this metric")).toBeInTheDocument();
    expect(within(partial.dialog()).queryByText(/Chiller 1/)).not.toBeInTheDocument();
  });

  it("has no 'Left out' row when nothing was left out", () => {
    const { dialog } = open("table", valuesData({ type: "table" }), config());
    expect(within(dialog()).queryByText("Left out")).not.toBeInTheDocument();
  });
});

describe("WidgetDetails: freshness", () => {
  it("a live reading: the site clock and the age, counted up every second while the drawer is open", () => {
    const { dialog } = open("stat", valuesData({ type: "stat", values: [valueRow({ ts: at(9) })] }), LAST());
    expect(within(dialog()).getByText("Last reading 12:04:31 (9 s ago)")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(within(dialog()).getByText("Last reading 12:04:31 (14 s ago)")).toBeInTheDocument();
  });

  it("a stale reading carries the stale sentence", () => {
    const { dialog } = open("stat", valuesData({ type: "stat", values: [valueRow({ ts: at(47 * 60), stale: true })] }), LAST());
    expect(within(dialog()).getByText(
      "Last reading 11:17:40 (47 min ago) Stale: older than three polling intervals of its meter (and at least a minute).",
    )).toBeInTheDocument();
  });

  it("a stat that follows the stream shows the streamed reading, as the card does; one that does not shows the fetched one", () => {
    const data = valuesData({ type: "stat", values: [valueRow({ point_id: 7, ts: at(60), stale: true })] });
    const stream = new Map<number, LiveValue>([[7, { ts: at(6), value: 11, quality: 0 }]]);
    const following = open("stat", data, LAST(), { stream, props: { following: true } });
    expect(within(following.dialog()).getByText("Last reading 12:04:34 (6 s ago)")).toBeInTheDocument(); // fresh by definition: no stale sentence
    expect(within(following.dialog()).queryByText(/Stale/)).not.toBeInTheDocument();
    following.unmount();
    const fetched = open("stat", data, LAST(), { stream, props: { following: false } });
    expect(within(fetched.dialog()).getByText(/^Last reading 12:03:40 \(1 min ago\) Stale/)).toBeInTheDocument();
  });

  it("a finished range names the hour the last value belongs to: no seconds, no age, never stale", () => {
    const data = valuesData({
      type: "stat", range: { preset: "yesterday", start: "2026-10-16T00:00:00+03:00", end: "2026-10-17T00:00:00+03:00" },
      values: [valueRow({ ts: "2026-10-16T23:00:00+03:00", stale: true })],
    });
    const { dialog } = open("stat", data, LAST());
    expect(within(dialog()).getByText("Last value of the hour from 10-16 23:00 (hourly roll-up)")).toBeInTheDocument();
    expect(dialog().textContent).not.toMatch(/ago|Stale|stale/);
  });

  it("a last month's value names its day: the date is in the freshness line", () => {
    const data = valuesData({
      type: "stat", range: { preset: "last_month", start: "2026-09-01T00:00:00+03:00", end: "2026-10-01T00:00:00+03:00" },
      values: [valueRow({ ts: "2026-09-30T23:00:00+03:00" })],
    });
    const { dialog } = open("stat", data, LAST());
    expect(within(dialog()).getByText("Last value of the hour from 09-30 23:00 (hourly roll-up)")).toBeInTheDocument();
  });

  it("a table has one line per row, from the fetched reading", () => {
    const data = valuesData({
      type: "table", values: [valueRow({ ts: at(9) }), valueRow({ asset_id: 6, name: "LV Panel 2", point_id: 8, ts: at(130) })],
    });
    const { dialog } = open("table", data, LAST());
    const part = within(dialog()).getByRole("heading", { name: "Freshness" }).nextElementSibling as HTMLElement;
    expect(within(part).getByText("LV Panel 1", { selector: "dt" }).nextElementSibling).toHaveTextContent("Last reading 12:04:31 (9 s ago)");
    expect(within(part).getByText("LV Panel 2", { selector: "dt" }).nextElementSibling).toHaveTextContent("Last reading 12:02:30 (2 min ago)");
  });

  it("a reading with no time recorded says so", () => {
    const { dialog } = open("stat", valuesData({ type: "stat", values: [valueRow({ ts: null, value: null, no_data: true })] }), LAST());
    expect(within(dialog()).getByText("No reading time recorded")).toBeInTheDocument();
  });

  it.each<[string, DataWidgetType, WidgetConfig, WidgetData]>([
    ["an average (not a reading)", "stat", config({ aggregation: "avg" }), valuesData({ type: "stat" })],
    ["an energy total", "stat", config({ source: "energy", metric: null, aggregation: "sum" }), valuesData({ type: "stat", source: "energy", metric: null, unit: "kWh" })],
    ["a bar chart", "bar", LAST(), valuesData({ type: "bar", values: [valueRow({ ts: at(9) })] })],
    ["a time series", "timeseries", config(), seriesData()],
  ])("has no Freshness section for %s", (_name, type, cfg, data) => {
    const { dialog } = open(type, data, cfg);
    expect(sections(dialog())).not.toContain("Freshness");
  });
});

describe("WidgetDetails: what the markers mean", () => {
  it("lists only the markers this answer uses, each with its meaning", () => {
    const data = valuesData({ type: "table", values: [valueRow({ estimated: true }), valueRow({ asset_id: 6, name: "B", partial: true })] });
    const { dialog } = open("table", data, config());
    const part = within(dialog()).getByRole("heading", { name: "What the markers mean here" }).nextElementSibling as HTMLElement;
    const items = within(part).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      "~ estimated from power, not measured",
      "* partial: some energy in the period had no rate, so the cost is incomplete",
    ]);
  });

  it("explains the dash of a cost with no rate", () => {
    const data = valuesData({ type: "stat", source: "cost", metric: null, unit: "QAR", values: [valueRow({ value: null })] });
    const { dialog } = open("stat", data, config({ source: "cost", metric: null, aggregation: "sum" }));
    expect(within(dialog()).getByText("— no rate: no tariff applies to this figure")).toBeInTheDocument();
  });
});

describe("WidgetDetails: a link to Tariffs next to the no-rate line (P5)", () => {
  const SENTENCE = "— no rate: no tariff applies to this figure";
  const LINK = "Set a rate in Tariffs";
  const noRateCost = () => valuesData({ type: "stat", source: "cost", metric: null, unit: "QAR", values: [valueRow({ value: null })] });
  const costCfg = () => config({ source: "cost", metric: null, aggregation: "sum" });
  const markerItems = (dialog: HTMLElement) =>
    within(within(dialog).getByRole("heading", { name: "What the markers mean here" }).nextElementSibling as HTMLElement).getAllByRole("listitem");

  it("offers the link inside the same list item as the no-rate sentence, after it, for a role that may open Tariffs", () => {
    held.ids = new Set(["assets.view", "tariffs.view"]);
    const { dialog } = open("stat", noRateCost(), costCfg());
    const li = within(dialog()).getByText(SENTENCE).closest("li") as HTMLElement;
    const link = within(li).getByRole("link", { name: LINK });
    expect(link).toHaveAttribute("href", "/tariffs");
    expect(markerItems(dialog())).toHaveLength(1); // the link is not a line of its own
    expect(li.textContent?.startsWith(SENTENCE)).toBe(true);
    expect(li.textContent?.endsWith(LINK)).toBe(true);
    expect(li.firstChild?.nodeType).toBe(Node.TEXT_NODE); // the sentence comes first, the link after it
  });

  it("keeps the sentence word for word (a text match on it still finds it)", () => {
    held.ids = new Set(["assets.view", "tariffs.view"]);
    const { dialog } = open("stat", noRateCost(), costCfg());
    expect(within(dialog()).getByText(SENTENCE)).toBeInTheDocument();
  });

  it("shows no link, and no error, for a role with assets.view only; the sentence is still there", () => {
    held.ids = new Set(["assets.view"]);
    const { dialog } = open("stat", noRateCost(), costCfg());
    expect(within(dialog()).getByText(SENTENCE)).toBeInTheDocument();
    expect(within(dialog()).queryByRole("link", { name: LINK })).toBeNull();
  });

  it("shows no link for a role with neither permission, or with tariffs.view only (the page needs both)", () => {
    for (const ids of [[], ["tariffs.view"]]) {
      held.ids = new Set(ids);
      const { dialog, unmount } = open("stat", noRateCost(), costCfg());
      expect(within(dialog()).getByText(SENTENCE)).toBeInTheDocument();
      expect(within(dialog()).queryByRole("link", { name: LINK })).toBeNull();
      unmount();
    }
  });

  it("offers it for a cost series with an unpriced bucket too, not only for a stat", () => {
    held.ids = new Set(["assets.view", "tariffs.view"]);
    const data = seriesData({
      type: "bar", source: "cost", metric: null, unit: "QAR", bucket: "hour", tier: null,
      series: [{
        asset_id: 5, name: "LV Panel 1", estimated: false, partial: false,
        points: [seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 3 }), seriesPoint({ ts: "2026-10-08T01:00:00+00:00", value: null })],
      }],
    });
    const { dialog } = open("bar", data, config({ source: "cost", metric: null, aggregation: "sum", bars: "time" }));
    expect(within(within(dialog()).getByText(SENTENCE).closest("li") as HTMLElement).getByRole("link", { name: LINK })).toHaveAttribute("href", "/tariffs");
  });

  it("has no link when the answer has no no-rate state, whatever the role holds", () => {
    held.ids = new Set(["assets.view", "tariffs.view"]);
    const estimated = valuesData({ type: "table", values: [valueRow({ estimated: true })] });
    const { dialog, unmount } = open("table", estimated, config());
    expect(within(dialog()).queryByRole("link", { name: LINK })).toBeNull();
    unmount();
    const priced = valuesData({ type: "stat", source: "cost", metric: null, unit: "QAR", values: [valueRow({ value: 12 })] });
    open("stat", priced, costCfg());
    expect(screen.queryByRole("link", { name: LINK })).toBeNull();
  });

  it("puts the link on the no-rate line only when other markers are listed around it", () => {
    held.ids = new Set(["assets.view", "tariffs.view"]);
    const data = valuesData({
      type: "table", source: "cost", metric: null, unit: "QAR",
      values: [valueRow({ estimated: true, partial: true }), valueRow({ asset_id: 6, name: "B", value: null, no_data: true })],
    });
    const { dialog } = open("table", data, costCfg());
    const items = markerItems(dialog());
    expect(items.map((li) => li.textContent?.split(" ")[0])).toEqual(["~", "*", "—", "no"]);
    expect(items.map((li) => within(li).queryAllByRole("link").length)).toEqual([0, 0, 1, 0]);
  });
});

describe("WidgetDetails: per asset", () => {
  it("shows the asset states in words under the name, and a value column for a bar per asset", () => {
    const data = valuesData({
      type: "bar", values: [valueRow({ value: 4 }), valueRow({ asset_id: 6, name: "LV Panel 2", value: 5.5, estimated: true, point_id: 8 })],
    });
    const { dialog } = open("bar", data, config());
    const table = within(dialog()).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Asset", "Value (kW)"]);
    const [first, second] = within(table).getAllByRole("row").slice(1);
    expect(cellsOf(first)).toEqual(["LV Panel 1", "4.00"]);
    expect(cellsOf(second)).toEqual(["LV Panel 2estimated", "~5.50"]);
  });

  it("has no table for a stat or gauge whose asset carries no state (the name is in 'What it shows')", () => {
    const { dialog } = open("gauge", valuesData({ type: "gauge" }), config());
    expect(within(dialog()).queryByRole("table")).not.toBeInTheDocument();
    expect(sections(dialog())).not.toContain("Per asset");
  });

  it("a stale stat says so in Freshness and does not repeat it as a state (the streamed reading may have made it fresh)", () => {
    const { dialog } = open("stat", valuesData({ type: "stat", values: [valueRow({ ts: at(600), stale: true })] }), LAST());
    expect(within(dialog()).getByText(/Stale: older than three polling intervals/)).toBeInTheDocument();
    expect(within(dialog()).queryByRole("table")).not.toBeInTheDocument();
  });

  it("lists an estimated stat as a state, since only the markers section would say it otherwise", () => {
    const { dialog } = open("stat", valuesData({ type: "stat", values: [valueRow({ ts: at(9), estimated: true })] }), LAST());
    expect(within(within(dialog()).getByRole("table")).getAllByRole("row")[1]).toHaveTextContent("LV Panel 1estimated");
  });
});

describe("WidgetDetails: the figures of a chart", () => {
  const BUCKETS = [
    seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 1, min: 0.5, max: 1.5 }),
    seriesPoint({ ts: "2026-10-08T00:04:48+00:00", value: 2, min: 1, max: 3 }),
    seriesPoint({ ts: "2026-10-08T00:09:36+00:00", value: 12.3, min: 10, max: 14, partial: true }),
  ];

  it("a metric time series: lowest, highest and when, and the last bucket's average; a partial bucket keeps its asterisk; no average over buckets", () => {
    const data = seriesData({ series: [{ asset_id: 5, name: "LV Panel 1", estimated: false, partial: false, points: BUCKETS }] });
    const { dialog } = open("timeseries", data, config());
    const table = within(dialog()).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent))
      .toEqual(["Asset", "Lowest", "Highest", "Last bucket (average)"]);
    const row = within(table).getAllByRole("row")[1];
    expect(cellsOf(row)).toEqual(["LV Panel 1", "0.50 kW", "14.00* kW" + "bucket from 2026-10-08 03:09:36", "12.30* kW" + "from 2026-10-08 03:09:36"]);
    expect(within(dialog()).getByText("Average of each bucket, with the lowest and highest as a band")).toBeInTheDocument();
    expect(within(table).queryByRole("columnheader", { name: "Average" })).not.toBeInTheDocument();
  });

  it("the time of the last bucket is a nowrap span of its own, so it never breaks inside the date (the state words around it may wrap)", () => {
    const data = seriesData({ series: [{ asset_id: 5, name: "LV Panel 1", estimated: false, partial: false, points: BUCKETS }] });
    const { dialog } = open("timeseries", data, config());
    const sub = dialog().querySelector(".wd-table td:last-child small.wd-sub") as HTMLElement;
    expect(sub.textContent).toBe("from 2026-10-08 03:09:36");
    const time = sub.querySelector("span.wd-fig");
    expect(time?.textContent, "only the time, not the word 'from'").toBe("2026-10-08 03:09:36");
  });

  it("the highest figure carries its bucket under it ('bucket from <time>': the start of a bucket, never the moment of the peak), in a nowrap span, and there is no column of its own for it", () => {
    const data = seriesData({ series: [{ asset_id: 5, name: "LV Panel 1", estimated: false, partial: false, points: BUCKETS }] });
    const { dialog } = open("timeseries", data, config());
    const table = within(dialog()).getByRole("table");
    expect(within(table).queryByRole("columnheader", { name: /Highest in the bucket from/ })).not.toBeInTheDocument();
    const highest = within(table).getAllByRole("row")[1].querySelectorAll("td")[2];
    const sub = highest.querySelector("small.wd-sub") as HTMLElement;
    expect(sub.textContent).toBe("bucket from 2026-10-08 03:09:36");
    expect(sub.querySelector("span.wd-fig")?.textContent, "the same text bucketStartText gives, and only the time").toBe("2026-10-08 03:09:36");
    expect(highest.querySelector(":scope > span.wd-fig")?.textContent).toBe("14.00* kW");
    // the last bucket keeps its own plain 'from'
    expect(within(table).getAllByRole("row")[1].querySelectorAll("td")[3].querySelector("small.wd-sub")?.textContent).toBe("from 2026-10-08 03:09:36");
  });

  it("an hour bucket and a day bucket say the time to the minute and to the date, under the highest figure as they do under the last", () => {
    const point = (ts: string, value: number) => seriesPoint({ ts, value });
    const series = (bucket: "hour" | "day") => seriesData({
      type: "bar", source: "energy", metric: null, unit: "kWh", bucket, tier: null,
      series: [{ asset_id: 5, name: "LV Panel 1", estimated: false, partial: false, points: [point("2026-10-08T00:00:00+00:00", 1.5), point("2026-10-09T00:00:00+00:00", 2.5)] }],
    });
    const energy = config({ source: "energy", metric: null, aggregation: "sum", bars: "time" });
    const hour = open("bar", series("hour"), energy);
    expect(hour.dialog().querySelector(".wd-table td:nth-child(2) small.wd-sub")?.textContent).toBe("bucket from 2026-10-09 03:00");
    hour.unmount();
    const day = open("bar", series("day"), energy);
    expect(day.dialog().querySelector(".wd-table td:nth-child(2) small.wd-sub")?.textContent).toBe("bucket from 2026-10-09");
  });

  it("is a wide drawer (class drawer-wide), because its table has several figure columns", () => {
    const { dialog } = open("timeseries", seriesData(), config());
    expect(dialog()).toHaveClass("drawer", "drawer-wide");
  });

  it("an energy series: the total only when every bucket has a value, and never a word about an average", () => {
    const point = (ts: string, value: number | null, no_data = false) => seriesPoint({ ts, value, no_data });
    const series = (points: ReturnType<typeof point>[]) => seriesData({
      type: "bar", source: "energy", metric: null, unit: "kWh", bucket: "hour", tier: null,
      series: [{ asset_id: 5, name: "LV Panel 1", estimated: false, partial: false, points }],
    });
    const whole = open("bar", series([point("2026-10-08T00:00:00+00:00", 1.5), point("2026-10-08T01:00:00+00:00", 2.5)]), config({ source: "energy", metric: null, aggregation: "sum", bars: "time" }));
    const table = within(whole.dialog()).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent))
      .toEqual(["Asset", "Highest", "Last bucket (total per hour)", "Total of the buckets shown"]);
    expect(cellsOf(within(table).getAllByRole("row")[1])).toEqual([
      "LV Panel 1", "2.50 kWhbucket from 2026-10-08 04:00", "2.50 kWhfrom 2026-10-08 04:00", "4.00 kWh",
    ]);
    expect(whole.dialog().textContent).not.toMatch(/average/i);
    whole.unmount();
    const gap = open("bar", series([point("2026-10-08T00:00:00+00:00", 1.5), point("2026-10-08T01:00:00+00:00", null, true)]), config({ source: "energy", metric: null, aggregation: "sum", bars: "time" }));
    const row = within(within(gap.dialog()).getByRole("table")).getAllByRole("row")[1];
    expect(cellsOf(row)[3]).toBe("—"); // no total: a missing bucket makes it not exact
    expect(within(gap.dialog()).getByText("A total is shown only when every bucket has a value.")).toBeInTheDocument();
  });

  it("a cost with an unpriced hour shows a dash and the words 'unpriced hours' for the highest, not a number", () => {
    const data = seriesData({
      type: "bar", source: "cost", metric: null, unit: "QAR", bucket: "hour", tier: null,
      series: [{
        asset_id: 5, name: "LV Panel 1", estimated: false, partial: false,
        points: [seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 3 }), seriesPoint({ ts: "2026-10-08T01:00:00+00:00", value: null })],
      }],
    });
    const { dialog } = open("bar", data, config({ source: "cost", metric: null, aggregation: "sum", bars: "time" }));
    const cells = cellsOf(within(within(dialog()).getByRole("table")).getAllByRole("row")[1]);
    expect(cells[0]).toBe("LV Panel 1no rate");
    expect(cells[1]).toBe("— unpriced hours");
    expect(cells[2]).toBe("3.00 QARfrom 2026-10-08 03:00"); // the last priced bucket, as before; the highest names no bucket (nothing is claimed)
    expect(cells[1]).not.toMatch(/\d/);
    expect(within(dialog()).getByText("— no rate: no tariff applies to this figure")).toBeInTheDocument();
  });

  it("a metric bar over time says what each bar is (here the highest per hour) in the last column", () => {
    const data = seriesData({
      type: "bar", bucket: "hour", tier: "1h",
      series: [{ asset_id: 5, name: "LV Panel 1", estimated: false, partial: false, points: [seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 9, min: 2, max: 9 })] }],
    });
    const { dialog } = open("bar", data, config({ aggregation: "max", bars: "time" }));
    expect(within(within(dialog()).getByRole("table")).getByRole("columnheader", { name: "Last bucket (highest per hour)" })).toBeInTheDocument();
    expect(within(dialog()).getByText("Highest per hour")).toBeInTheDocument();
  });

  it("says in a note what the figures are taken from", () => {
    const { dialog } = open("timeseries", seriesData(), config());
    expect(within(dialog()).getByText(/of the buckets shown/)).toBeInTheDocument();
  });

  it("has at most four columns (Asset and three figures), so the table fits the wide drawer", () => {
    const heads = (dialog: HTMLElement) => within(within(dialog).getByRole("table")).getAllByRole("columnheader").length;
    const metric = open("timeseries", seriesData({ series: [{ asset_id: 5, name: "LV Panel 1", estimated: false, partial: false, points: BUCKETS }] }), config());
    expect(heads(metric.dialog())).toBe(4);
    metric.unmount();
    const energy = open("bar", seriesData({
      type: "bar", source: "energy", metric: null, unit: "kWh", bucket: "hour", tier: null,
      series: [{ asset_id: 5, name: "LV Panel 1", estimated: false, partial: false, points: [seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 1.5 })] }],
    }), config({ source: "energy", metric: null, aggregation: "sum", bars: "time" }));
    expect(heads(energy.dialog())).toBe(4);
  });
});

describe("WidgetDetails: the table's stylesheet (jsdom has no layout; the drawer was looked at in a browser at 1440, 1024 and 800)", () => {
  const rules = parseRules(stripComments(readFileSync("src/styles/widgets-details.css", "utf8")));
  const body = (selector: string) => {
    const found = rules.filter((r) => r.selector === selector && r.at.length === 1);
    expect(found, `one plain rule for "${selector}"`).toHaveLength(1);
    return found[0].body;
  };

  it("a figure and a time never break inside (nowrap), while the words of a sub-line may wrap", () => {
    expect(body(".wd-fig")).toMatch(/white-space:\s*nowrap/);
    expect(body(".wd-sub")).toMatch(/white-space:\s*normal/);
    expect(body(".wd-sub")).toMatch(/display:\s*block/);
  });

  it("the Asset column keeps a readable width and the box scrolls sideways inside itself only as a net", () => {
    expect(body(".wd-table td:first-child")).toMatch(/min-width:\s*11ch/);
    expect(body(".wd-table-wrap")).toMatch(/overflow-x:\s*auto/);
  });
});

describe("WidgetDetails: Download CSV", () => {
  const csv = { type: "table" as const, config: config(), range: "24h" as const };

  it("is the drawer footer's button, named exactly 'Download CSV', and repeats the widget's query", async () => {
    vi.useRealTimers();
    const { dialog } = open("table", valuesData({ type: "table" }), config(), { props: { csv } });
    await userEvent.click(within(dialog()).getByRole("button", { name: "Download CSV" }));
    expect(downloadCsv).toHaveBeenCalledWith("/api/widget-data/csv", { method: "POST", body: { type: "table", config: config(), range: "24h" } });
  });

  it("is not offered when the widget has no CSV (the editor preview)", () => {
    const { dialog } = open("table", valuesData({ type: "table" }), config());
    expect(within(dialog()).queryByRole("button", { name: /CSV/ })).not.toBeInTheDocument();
  });

  it("says when the export failed, and waits (aria-disabled, not disabled) while it runs", async () => {
    vi.useRealTimers();
    let fail: (e: Error) => void = () => {};
    vi.mocked(downloadCsv).mockReturnValue(new Promise<void>((_, reject) => { fail = reject; }));
    const { dialog } = open("table", valuesData({ type: "table" }), config(), { props: { csv } });
    const button = within(dialog()).getByRole("button", { name: "Download CSV" });
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    await userEvent.click(button);
    expect(downloadCsv).toHaveBeenCalledTimes(1);
    await act(async () => { fail(new Error("boom")); });
    expect(within(dialog()).getByRole("alert")).toHaveTextContent("CSV export failed: boom");
    expect(button).not.toHaveAttribute("aria-disabled");
  });
});

describe("WidgetDetails: a comparison and a breakdown (w24)", () => {
  const COMPARE = (): WidgetConfig => config({ source: "energy", metric: null, aggregation: "sum", range: "this_month", compare: "same_days_last_month" });
  const KIND = (): WidgetConfig => config({ assets: [], source: "energy", metric: null, aggregation: "sum", range: "this_month", bars: "kind", kind: "Rack" });

  it("lists both measures for both windows by date, the changes and a note for each thing worth saying", () => {
    const data = compareStatData({
      compare: compareBlock({
        left_out_days: ["2026-10-31"], last_month: { month: "2026-09", closed: true },
        assets: [compareAsset({ this: compareSide({ kwh: 12.3, cost: 4.5, estimated: true, partial: true }), kwh: compareChange({ abs: 2.5, percent: 25 }), cost: compareChange({ abs: 1, why_none: "partial" }) })],
      }),
    });
    const { dialog } = open("stat", data, COMPARE());
    const view = within(dialog());
    expect(view.getByRole("heading", { name: "Comparison" })).toBeInTheDocument();
    const rows = view.getAllByRole("row").map((row) => within(row).queryAllByRole("cell").map((c) => c.textContent));
    expect(rows).toContainEqual(["This month so far", "2026-10-01 to 2026-10-17", "~12.30", "~4.50*"]);
    expect(rows).toContainEqual(["Same days last month", "2026-09-01 to 2026-09-17", "1,300.00", "260.00"]);
    expect(rows).toContainEqual(["Change", "", "up ~25.0 % (~+2.50 kWh)", "up ~1.00* QAR"]); // the change carries the marks of its figures (the kWh column never a star)
    expect(view.getByRole("columnheader", { name: "Cost (QAR)" })).toBeInTheDocument();
    expect(view.getByText("Cost: No percentage: some of the cost has no rate.")).toBeInTheDocument();
    expect(view.getByText("31 October has no matching day in September.")).toBeInTheDocument();
    expect(view.getByText("Last month is closed: these are its closed figures.")).toBeInTheDocument();
    // the markers the figures use are explained here too
    expect(view.getByText("~ estimated from power, not measured")).toBeInTheDocument();
  });

  it("explains a star and a dash of the cost column on an energy widget, where the card draws neither (and so its footer says nothing of them)", () => {
    const side = compareSide({ partial: true });
    const { dialog } = open("stat", compareStatData({ compare: compareBlock({ assets: [compareAsset({ this: side, last: compareSide({ cost: null }) })] }) }), COMPARE());
    const view = within(dialog());
    const rows = view.getAllByRole("row").map((row) => within(row).queryAllByRole("cell").map((c) => c.textContent));
    expect(rows).toContainEqual(["This month so far", "2026-10-01 to 2026-10-17", "1,500.00", "300.00*"]);
    expect(rows).toContainEqual(["Same days last month", "2026-09-01 to 2026-09-17", "1,500.00", "—"]);
    expect(view.getByText("* partial: some energy in the period had no rate, so the cost is incomplete")).toBeInTheDocument();
    expect(view.getByText("— no rate: no tariff applies to this figure")).toBeInTheDocument();
  });

  it("says nothing of a missing rate for a currency change after a close, in the markers and in the link to Tariffs (w24 review C-1)", () => {
    held.ids = new Set(["assets.view", "tariffs.view"]);
    const currency = compareAsset({ last: compareSide({ cost: null }), cost: compareChange({ why_none: "currency" }) });
    const data = compareStatData({ source: "cost", unit: "QAR", compare: compareBlock({ last_month: { month: "2026-09", closed: true }, assets: [currency] }) });
    const { dialog } = open("stat", data, config({ source: "cost", metric: null, aggregation: "sum", range: "this_month", compare: "same_days_last_month" }));
    const view = within(dialog());
    const rows = view.getAllByRole("row").map((row) => within(row).queryAllByRole("cell").map((c) => c.textContent));
    expect(rows).toContainEqual(["Same days last month", "2026-09-01 to 2026-09-17", "1,500.00", "—"]);
    expect(dialog().textContent).not.toMatch(/no rate/i);
    expect(view.queryByRole("link", { name: "Set a rate in Tariffs" })).not.toBeInTheDocument();
    expect(view.getByText("Cost: No cost comparison: the currency changed since last month closed.")).toBeInTheDocument();
    held.ids = new Set(["assets.view"]);
  });

  it("still explains a dash that is a missing rate (the cost is null and the reason is no_cost), on a cost widget", () => {
    const missing = compareAsset({ last: compareSide({ cost: null }), cost: compareChange({ why_none: "no_cost" }) });
    const data = compareStatData({ source: "cost", unit: "QAR", compare: compareBlock({ assets: [missing] }) });
    const { dialog } = open("stat", data, config({ source: "cost", metric: null, aggregation: "sum", range: "this_month", compare: "same_days_last_month" }));
    expect(within(dialog()).getByText("— no rate: no tariff applies to this figure")).toBeInTheDocument();
  });

  it("says nothing of a star or a missing rate when the cost column has neither", () => {
    const { dialog } = open("stat", compareStatData(), COMPARE());
    expect(within(dialog()).queryByText(/^\* partial/)).not.toBeInTheDocument();
    expect(within(dialog()).queryByText(/^— no rate/)).not.toBeInTheDocument();
  });

  it("says 'Nothing to compare yet' on the first of the month, with no table", () => {
    const data = compareStatData({ compare: compareBlock({ state: "nothing_yet", elapsed_days: 0, days: 0, this_window: null, last_window: null, assets: [] }), values: [] });
    const { dialog } = open("stat", data, COMPARE());
    expect(within(dialog()).getByText("Nothing to compare yet")).toBeInTheDocument();
    expect(within(dialog()).queryByRole("columnheader", { name: "Dates" })).not.toBeInTheDocument();
  });

  it("lists the counts of a breakdown: bars, those left out with their total, those with no data and those inside others", () => {
    const data = breakdownData(3, { breakdown: breakdownBlock({ inside_others: 3, no_data: 2, more: { count: 10, with_value: 7, value: 40, estimated: true, partial: false } }) });
    const { dialog } = open("bar", data, KIND());
    const view = within(dialog());
    expect(view.getByRole("heading", { name: "Breakdown" })).toBeInTheDocument();
    const list = view.getByText("Looking under").closest("dl")!;
    const pairs = [...list.querySelectorAll(":scope > div")].map((row) => [row.querySelector("dt")!.textContent, row.querySelector("dd")!.textContent]);
    expect(pairs).toEqual([
      ["Kind", "Rack"], ["Looking under", "Hall 1"], ["Assets of this kind", "117"], ["Bars drawn", "10"],
      ["Not drawn", "10 Racks: ~40.00 kWh in all (3 with no data)"], ["With no data", "2"],
      ["Inside others", "3 Racks are inside other Racks and are counted there."],
    ]);
  });

  it("keeps the exact face on large figures: grouped digits, two decimals, never MWh, with the marks (w27)", () => {
    const data = compareStatData({
      values: [valueRow({ value: 275_430.2575, estimated: true, point_id: null })],
      compare: compareBlock({
        assets: [compareAsset({
          this: compareSide({ kwh: 275_430.2575, cost: 33_051.6309, estimated: true }), last: compareSide({ kwh: 275_993.077, cost: 33_119.1692, estimated: true }),
          kwh: compareChange({ abs: -562.8195, percent: -0.2039 }), cost: compareChange({ abs: -67.5383, percent: -0.2039 }),
        })],
      }),
    });
    const { dialog } = open("stat", data, COMPARE());
    const rows = within(dialog()).getAllByRole("row").map((row) => within(row).queryAllByRole("cell").map((c) => c.textContent));
    expect(rows).toContainEqual(["This month so far", "2026-10-01 to 2026-10-17", "~275,430.26", "~33,051.63"]);
    expect(rows).toContainEqual(["Same days last month", "2026-09-01 to 2026-09-17", "~275,993.08", "~33,119.17"]);
    expect(rows).toContainEqual(["Change", "", "down ~0.2 % (~-562.82 kWh)", "down ~0.2 % (~-67.54 QAR)"]);
  });

  it("writes a large change in full, with its sign and without a scale letter (w27)", () => {
    const data = compareStatData({ compare: compareBlock({ assets: [compareAsset({ kwh: compareChange({ abs: 150_000, percent: 54.3 }), cost: compareChange({ abs: 1_234_567.891, percent: 12.5 }) })] }) });
    const { dialog } = open("stat", data, COMPARE());
    const rows = within(dialog()).getAllByRole("row").map((row) => within(row).queryAllByRole("cell").map((c) => c.textContent));
    expect(rows).toContainEqual(["Change", "", "up 54.3 % (+150,000.00 kWh)", "up 12.5 % (+1,234,567.89 QAR)"]);
  });

  it("lists the bars left out of a breakdown on the exact face, with their marks (w27)", () => {
    const data = breakdownData(3, { breakdown: breakdownBlock({ kind: "Circuit", count: 231, shown: 12, more: { count: 219, with_value: 207, value: 262_071.8, estimated: true, partial: false } }) });
    const { dialog } = open("bar", data, KIND());
    expect(within(dialog()).getByText("Not drawn").closest("div")!.querySelector("dd")!.textContent).toBe("219 Circuits: ~262,071.80 kWh in all (12 with no data)");
  });

  it("prints the per-asset value column of a large bar chart the same way: separators, two decimals, marks (w27)", () => {
    const data = valuesData({
      type: "bar", source: "energy", metric: null, unit: "kWh",
      values: [valueRow({ name: "Hall 1", value: 138_130.96, point_id: null }), valueRow({ asset_id: 6, name: "Hall 2", value: 150_503.32, estimated: true, point_id: null })],
    });
    const { dialog } = open("bar", data, config({ source: "energy", metric: null, aggregation: "sum" }));
    const table = within(dialog()).getByRole("table");
    expect(within(table).getAllByRole("row").slice(1).map(cellsOf)).toEqual([["Hall 1", "138,130.96"], ["Hall 2estimated", "~150,503.32"]]);
  });

  it("says the whole site when there is no root, and leaves out the rows that have nothing to say", () => {
    const data = breakdownData(3, { breakdown: breakdownBlock({ root: null, more: { count: 0, with_value: 0, value: null, estimated: false, partial: false } }) });
    const { dialog } = open("bar", data, KIND());
    const view = within(dialog());
    expect(view.getByText("The whole site", { selector: "dd" })).toBeInTheDocument();
    expect(view.queryByText("Not drawn")).not.toBeInTheDocument();
    expect(view.queryByText("Inside others")).not.toBeInTheDocument();
  });

  it("has neither section for an ordinary widget", () => {
    const { dialog } = open("stat", valuesData({ type: "stat" }), LAST());
    expect(within(dialog()).queryByRole("heading", { name: "Comparison" })).not.toBeInTheDocument();
    expect(within(dialog()).queryByRole("heading", { name: "Breakdown" })).not.toBeInTheDocument();
  });
});
