import type { RangePreset, WidgetType } from "../api/types";
import { valueRow, valuesData } from "../test/dashboardFixtures";
import { isLiveWidget, liveOrFetched, pointIdsOf } from "./live";

const last = { source: "metric", aggregation: "last" } as const;

describe("isLiveWidget", () => {
  it.each<[RangePreset, boolean]>([
    ["1h", true], ["6h", true], ["24h", true], ["7d", true], ["30d", true],
    ["today", true], ["this_month", true], ["yesterday", false], ["last_month", false],
  ])("stat showing the latest metric value over %s: live = %s", (preset, expected) => {
    expect(isLiveWidget("stat", last, preset)).toBe(expected);
  });
  it("is live for a gauge too", () => expect(isLiveWidget("gauge", last, "24h")).toBe(true));
  it.each<WidgetType>(["timeseries", "bar", "table"])("is never live for %s", (type) => {
    expect(isLiveWidget(type, last, "24h")).toBe(false);
  });
  it("needs source metric and aggregation last", () => {
    expect(isLiveWidget("stat", { source: "metric", aggregation: "avg" }, "24h")).toBe(false);
    expect(isLiveWidget("stat", { source: "energy", aggregation: "sum" }, "24h")).toBe(false);
  });
});

describe("liveOrFetched", () => {
  const entry = (value: number | null, quality = 0, ts = "2026-10-08T06:00:00.000Z") => ({ ts, value, quality });
  const fetched = (over = {}) => valueRow({ value: 10.5, ...over });

  it("keeps the fetched figure, reading time and staleness until the stream has an entry", () => {
    const row = fetched({ ts: "2026-10-08T09:00:00.000000+03:00", stale: true });
    expect(liveOrFetched(undefined, row)).toEqual({ value: 10.5, ts: "2026-10-08T09:00:00.000000+03:00", stale: true, noData: false });
    expect(liveOrFetched(undefined, fetched({ value: null, no_data: true })).noData).toBe(true);
  });
  it("lets a stream entry win and takes its age from the stream", () => {
    expect(liveOrFetched(entry(11.25), fetched())).toEqual({ value: 11.25, ts: "2026-10-08T06:00:00.000Z", stale: false, noData: false });
  });
  it("lets a null stream value win too (the reading went bad), and treats bad quality as no value", () => {
    expect(liveOrFetched(entry(null), fetched()).value).toBeNull();
    expect(liveOrFetched(entry(7, 1), fetched()).value).toBeNull();
  });
  it("compares instants, not strings: a newer stream entry beats a fetched row written with the site offset and microseconds", () => {
    // As strings "2026-10-08T07:30..." sorts before "2026-10-08T10:20...", yet 07:30Z is later than 10:20+03:00 (= 07:20Z).
    const row = fetched({ value: 10.5, ts: "2026-10-08T10:20:00.000000+03:00", stale: true });
    expect(liveOrFetched(entry(11.25, 0, "2026-10-08T07:30:00.000Z"), row)).toEqual({
      value: 11.25, ts: "2026-10-08T07:30:00.000Z", stale: false, noData: false,
    });
  });
  it("lets the fetched row win as a whole when it is the newer reading (the stream missed it, or the entry is left over from before a reconnect)", () => {
    const row = fetched({ value: 10.5, ts: "2026-10-08T10:20:00.000000+03:00", stale: true });
    expect(liveOrFetched(entry(11.25, 0, "2026-10-08T07:10:00.000Z"), row)).toEqual({
      value: 10.5, ts: "2026-10-08T10:20:00.000000+03:00", stale: true, noData: false,
    });
  });
});

describe("pointIdsOf", () => {
  it("collects the mapped points of a values response", () => {
    expect(pointIdsOf(undefined)).toEqual([]);
    const data = valuesData({ values: [valueRow({ name: "A" }), valueRow({ asset_id: 6, name: "B", point_id: null })] });
    expect(pointIdsOf(data)).toEqual([7]);
  });
});
