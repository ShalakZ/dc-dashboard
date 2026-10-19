import { compareAsset, compareChange, compareSeriesData, compareSide, seriesPoint } from "../../../test/dashboardFixtures";
import { compareOption } from "./TimeSeriesWidget";

// A close followed by a change of the site currency (w24 whole-wave review C-1): the server takes last month's cost and the cost of its daily points away and says
// `cost.why_none: "currency"`. The tooltip of such a day shows no figure and says why, never "no rate" (no tariff is missing). In its own file because the chart's cases
// are in charts.test.tsx.
interface Opt { legend: { data: string[] }; tooltip: { formatter: (params: unknown) => string } }
const rows = (html: string) => [...new DOMParser().parseFromString(html, "text/html").body.querySelectorAll(":scope > div")]
  .map((row) => [...row.children].map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()).join(" | "));
const tip = (option: Opt, dataIndex: number) => option.tooltip.formatter([{ dataIndex, seriesIndex: 0, marker: "" }, { dataIndex, seriesIndex: 1, marker: "" }]);

/** A cost chart of 2 days: this month priced, last month's days taken away (value null, not no_data) because of the currency. */
function currencyChart(over: Partial<ReturnType<typeof compareAsset>> = {}) {
  const data = compareSeriesData(2, 2, { source: "cost", unit: "QAR" });
  const asset = data.compare!.assets[0];
  data.compare!.assets[0] = {
    ...asset, last: compareSide({ cost: null }), cost: compareChange({ why_none: "currency" }),
    last_points: asset.last_points.map((p) => ({ ...p, value: null, no_data: false })), ...over,
  };
  return data;
}

describe("the daily chart after a currency change since the close", () => {
  it("shows last month's day with no figure and the words 'other currency', and this month's day as before", () => {
    const option = compareOption(currencyChart(), "Asia/Qatar") as unknown as Opt;
    expect(rows(tip(option, 0))).toEqual(["1 Oct | 100.00 QAR", "1 Sep | — other currency"]);
    expect(tip(option, 0)).not.toContain("no rate");
  });

  it("drops the estimated and partial words of a day that has no figure to describe", () => {
    const data = currencyChart();
    data.compare!.assets[0].last_points[1] = seriesPoint({ ts: "2026-09-02T00:00:00+03:00", value: null, estimated: true, partial: true });
    const option = compareOption(data, "Asia/Qatar") as unknown as Opt;
    expect(rows(tip(option, 1))[1]).toBe("2 Sep | — other currency");
  });

  it("still says 'no rate' for this month's day that has readings but no rate", () => {
    const data = currencyChart();
    data.series[0].points[0] = seriesPoint({ ts: "2026-10-01T00:00:00+03:00", value: null });
    const option = compareOption(data, "Asia/Qatar") as unknown as Opt;
    expect(rows(tip(option, 0))).toEqual(["1 Oct | — no rate", "1 Sep | — other currency"]);
  });

  it("says 'no rate' for last month's day of a cost that really has no rate (no_cost)", () => {
    const data = currencyChart({ cost: compareChange({ why_none: "no_cost" }) });
    const option = compareOption(data, "Asia/Qatar") as unknown as Opt;
    expect(rows(tip(option, 0))[1]).toBe("1 Sep | — no rate");
  });

  it("leaves a day with no readings out, as always", () => {
    const data = currencyChart();
    data.compare!.assets[0].last_points[0] = seriesPoint({ ts: "2026-09-01T00:00:00+03:00", value: null, no_data: true });
    const option = compareOption(data, "Asia/Qatar") as unknown as Opt;
    expect(rows(tip(option, 0))).toEqual(["1 Oct | 100.00 QAR"]);
  });

  it("names the last month's line without marks, so a legend does not promise what the tooltip cannot show", () => {
    const data = currencyChart({ last: compareSide({ cost: null, estimated: true, partial: true }) });
    const option = compareOption(data, "Asia/Qatar") as unknown as Opt;
    expect(option.legend.data).toEqual(["October", "September"]);
  });

  it("does not touch an energy chart: its kWh are real", () => {
    const data = compareSeriesData(2, 2);
    data.compare!.assets[0] = { ...data.compare!.assets[0], cost: compareChange({ why_none: "currency" }) };
    const option = compareOption(data, "Asia/Qatar") as unknown as Opt;
    expect(rows(tip(option, 0))).toEqual(["1 Oct | 100.00 kWh", "1 Sep | 90.00 kWh"]);
  });
});
