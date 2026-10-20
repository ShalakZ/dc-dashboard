import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { keys, useWidgetData } from "../api/queries";
import type { RangePreset, WidgetConfig } from "../api/types";
import { mockFetch } from "../test/fetchMock";
import { summarise, updatedClock, useDashboardFreshness, type AnswerState } from "./dashboardFreshness";

const answered = (at: number, over: Partial<AnswerState> = {}): AnswerState => ({ hasAnswer: true, at, pending: false, fetching: false, ...over });
const noAnswer: AnswerState = { hasAnswer: false, at: 0, pending: true, fetching: true };

describe("summarise (D4)", () => {
  it("is the time of the OLDEST answer on screen", () => {
    expect(summarise([answered(300), answered(100), answered(200)])).toEqual({ oldest: 100, pending: false, fetching: false });
  });

  it("skips a query that has no answer yet and says an answer is pending; with no answer at all there is no time", () => {
    expect(summarise([answered(300), noAnswer])).toEqual({ oldest: 300, pending: true, fetching: true });
    expect(summarise([noAnswer])).toEqual({ oldest: null, pending: true, fetching: true });
    expect(summarise([])).toEqual({ oldest: null, pending: false, fetching: false });
  });

  it("never counts an answer stamped 0 (nothing was received)", () => {
    expect(summarise([answered(0), answered(50)]).oldest).toBe(50);
    expect(summarise([answered(0)]).oldest).toBeNull();
  });

  it("keeps the old time of a query whose last read failed: it still draws that answer", () => {
    expect(summarise([answered(100), answered(900)]).oldest).toBe(100);
  });

  it("reports that something is being read, which is what Refresh waits for", () => {
    expect(summarise([answered(100, { fetching: true }), answered(200)]).fetching).toBe(true);
  });
});

describe("updatedClock", () => {
  it("is the site's wall clock to the minute, whatever the browser's zone", () => {
    const at = Date.UTC(2026, 9, 20, 17, 9, 59); // 17:09:59 UTC
    expect(updatedClock(at, "Asia/Qatar")).toBe("20:09");
    expect(updatedClock(at, "UTC")).toBe("17:09");
    expect(updatedClock(at, "America/New_York")).toBe("13:09");
  });

  it("is null for no time, and for a zone the browser does not know (the header says nothing rather than a wrong time)", () => {
    expect(updatedClock(null, "UTC")).toBeNull();
    expect(updatedClock(Date.now(), "Not/AZone")).toBeNull();
  });
});

const base: WidgetConfig = { assets: [5], source: "energy", metric: null, aggregation: "sum", range: "this_month", bars: "asset", min: 0, max: null };
const reply = { type: "stat", mode: "values", source: "energy", metric: null, unit: "kWh", range: { preset: "this_month", start: "s", end: "e" }, tier: null, bucket: null, series: [], values: [], missing: [], no_metric: [] };
const asked = (calls: { path: string }[]) => calls.filter((c) => c.path === "/api/widget-data").length;
const clientFor = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapperFor = (client: QueryClient) => ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
/** Two cards and the header's hook, as the viewer has them. */
const dashboard = () => ({ range, second }: { range: RangePreset; second: boolean }) => ({
  fresh: useDashboardFreshness("Asia/Qatar"),
  one: useWidgetData("stat", base, range),
  two: useWidgetData("stat", { ...base, assets: [6] }, range, second),
});

describe("useDashboardFreshness", () => {
  // Only the clock is faked: React Query's own timers must keep running.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-20T10:00:10Z")); });
  afterEach(() => vi.useRealTimers());

  it("says nothing before the first answer, then the site time of the answer", async () => {
    mockFetch({ "POST /api/widget-data": { body: reply } });
    const { result } = renderHook(dashboard(), { wrapper: wrapperFor(clientFor()), initialProps: { range: "this_month" as RangePreset, second: false } });
    expect(result.current.fresh.clock).toBeNull();
    expect(result.current.fresh.waiting).toBe(true);
    await waitFor(() => expect(result.current.fresh.clock).toBe("13:00"));
    expect(result.current.fresh.waiting).toBe(false);
  });

  it("names the oldest answer on screen when a card is added later", async () => {
    mockFetch({ "POST /api/widget-data": { body: reply } });
    const { result, rerender } = renderHook(dashboard(), { wrapper: wrapperFor(clientFor()), initialProps: { range: "this_month" as RangePreset, second: false } });
    await waitFor(() => expect(result.current.fresh.clock).toBe("13:00"));
    vi.setSystemTime(new Date("2026-10-20T10:07:10Z"));
    rerender({ range: "this_month", second: true });
    await waitFor(() => expect(result.current.two.data).toBeDefined());
    expect(result.current.fresh.clock, "the first answer is still the oldest").toBe("13:00");
  });

  it("keeps the previous time, dimmed, while a new range has no answer yet, and moves to the new one when it lands", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    mockFetch({
      "POST /api/widget-data": async () => {
        if (held) await gate;
        return { body: reply };
      },
    } as never);
    const { result, rerender } = renderHook(dashboard(), { wrapper: wrapperFor(clientFor()), initialProps: { range: "this_month" as RangePreset, second: false } });
    await waitFor(() => expect(result.current.fresh.clock).toBe("13:00"));
    held = true;
    vi.setSystemTime(new Date("2026-10-20T10:20:10Z"));
    rerender({ range: "7d", second: false });
    expect(result.current.one.isPlaceholderData, "the card draws the previous answer").toBe(true);
    expect(result.current.fresh.clock, "and the time stays what it was").toBe("13:00");
    expect(result.current.fresh.waiting, "dimmed").toBe(true);
    held = false;
    release();
    await waitFor(() => expect(result.current.fresh.clock).toBe("13:20"));
    expect(result.current.fresh.waiting).toBe(false);
  });

  it("a read that fails leaves the old time: the card still draws that answer", async () => {
    let fail = false;
    mockFetch({ "POST /api/widget-data": () => (fail ? { status: 500, body: { detail: "broken" } } : { body: reply }) });
    const client = clientFor();
    const { result } = renderHook(dashboard(), { wrapper: wrapperFor(client), initialProps: { range: "this_month" as RangePreset, second: true } });
    await waitFor(() => expect(result.current.fresh.clock).toBe("13:00"));
    fail = true;
    vi.setSystemTime(new Date("2026-10-20T10:30:10Z"));
    await act(async () => { await client.refetchQueries({ queryKey: keys.widgetData, type: "active" }); });
    expect(result.current.one.isError).toBe(true);
    expect(result.current.one.data, "the old figures are still there").toBeDefined();
    expect(result.current.fresh.clock).toBe("13:00");
  });

  it("one card failing does not make the page look newer: the failed card's answer is still the oldest on screen", async () => {
    let failFirst = false;
    mockFetch({ "POST /api/widget-data": ({ body }) => ((body as { config: WidgetConfig }).config.assets[0] === 5 && failFirst ? { status: 500, body: { detail: "broken" } } : { body: reply }) });
    const client = clientFor();
    const { result } = renderHook(dashboard(), { wrapper: wrapperFor(client), initialProps: { range: "this_month" as RangePreset, second: true } });
    await waitFor(() => expect(result.current.fresh.clock).toBe("13:00"));
    failFirst = true;
    vi.setSystemTime(new Date("2026-10-20T10:40:10Z"));
    await act(async () => { await client.refetchQueries({ queryKey: keys.widgetData, type: "active" }); });
    expect(result.current.two.dataUpdatedAt).toBeGreaterThan(result.current.one.dataUpdatedAt);
    expect(result.current.fresh.clock).toBe("13:00");
  });

  it("refresh reads the widget-data queries that are on screen again, and nothing else", async () => {
    const calls = mockFetch({ "POST /api/widget-data": { body: reply }, "GET /api/site": { body: { timezone: "UTC", currency: null } } });
    const client = clientFor();
    // A card of another dashboard visited earlier: cached, no one is watching it.
    client.setQueryData([...keys.widgetData, "stat", { ...base, assets: [99] }, "this_month"], reply);
    client.setQueryData(keys.site, { timezone: "UTC", currency: null });
    const { result } = renderHook(dashboard(), { wrapper: wrapperFor(client), initialProps: { range: "this_month" as RangePreset, second: true } });
    await waitFor(() => expect(asked(calls)).toBe(2));
    await waitFor(() => expect(result.current.fresh.fetching).toBe(false));
    act(() => result.current.fresh.refresh());
    await waitFor(() => expect(asked(calls)).toBe(4));
    await waitFor(() => expect(result.current.fresh.fetching).toBe(false));
    expect(asked(calls), "the cached card nobody watches was not read").toBe(4);
    expect(calls.some((c) => c.path === "/api/site")).toBe(false);
  });

  it("says a read is going on while one is, which is when Refresh waits", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockFetch({ "POST /api/widget-data": async () => { await gate; return { body: reply }; } } as never);
    const { result } = renderHook(dashboard(), { wrapper: wrapperFor(clientFor()), initialProps: { range: "this_month" as RangePreset, second: false } });
    expect(result.current.fresh.fetching).toBe(true);
    release();
    await waitFor(() => expect(result.current.fresh.fetching).toBe(false));
  });
});
