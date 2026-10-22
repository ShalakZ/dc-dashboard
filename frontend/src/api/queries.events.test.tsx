import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { mockFetch } from "../test/fetchMock";
import { ApiError } from "./client";
import {
  eventsCsvUrl, eventsLoss, eventsQuery, EVENTS_REFETCH_MS, EVENT_PAGE_SIZE, keys, NO_EVENT_FILTERS, useEvent, useEventOptions, useEventPage, useEvents, useEventsSettings,
  useEventSummary, useSaveEventsSettings,
} from "./queries";
import type { EventFilters, EventPage, EventsSettings, SystemEvent } from "./types";

function stableWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const event = (id: number, extra: Partial<SystemEvent> = {}): SystemEvent => ({
  id, ts: "2026-10-22T08:00:00Z", level: "warning", component: "collector", source_id: 4, source_name: "Plant OPC", source_deleted: false,
  kind: "source.offline", code: "refused", message: "Could not connect.", detail: {}, incident: null, ...extra,
});
const page = (ids: number[], next: string | null, total: number | null = null): EventPage => ({ items: ids.map((id) => event(id)), next, total, total_capped: false });
const params = (url: string) => new URL(url, "http://x").searchParams;

describe("eventsQuery and eventsCsvUrl (w32)", () => {
  it("is empty for no filters, so the plain page asks for the plain list", () => {
    expect(eventsQuery(NO_EVENT_FILTERS)).toBe("");
  });

  it("writes every filter the contract names, repeating level and kind, and open as 1", () => {
    const filters: EventFilters = { source: "4", levels: ["warning", "error"], kinds: ["source.offline", "points.bad"], from: "2026-10-01", to: "2026-10-22", open: true };
    const query = new URLSearchParams(eventsQuery(filters));
    expect(query.get("source")).toBe("4");
    expect(query.getAll("level")).toEqual(["warning", "error"]);
    expect(query.getAll("kind")).toEqual(["source.offline", "points.bad"]);
    expect(query.get("from")).toBe("2026-10-01");
    expect(query.get("to")).toBe("2026-10-22");
    expect(query.get("open")).toBe("1");
  });

  it("leaves a filter that is not set out, and puts the extra values after the filters", () => {
    expect(eventsQuery({ ...NO_EVENT_FILTERS, levels: ["error"] }, { limit: 50, before: "" })).toBe("level=error&limit=50");
  });

  it("builds the CSV address from the filters alone: no cursor, no limit, no total", () => {
    const url = eventsCsvUrl({ ...NO_EVENT_FILTERS, source: "9", open: true });
    expect(url).toBe("/api/events.csv?source=9&open=1");
    expect(eventsCsvUrl(NO_EVENT_FILTERS)).toBe("/api/events.csv");
  });
});

describe("useEvents: the list, a keyset cursor at a time (w32)", () => {
  it("asks for the first page with the total, then for the next one by the cursor the first returned, without the total", async () => {
    const urls: string[] = [];
    mockFetch({
      "GET /api/events": ({ url }) => {
        urls.push(url);
        return { body: params(url).get("before") ? page([40, 39], null) : page([50, 49], "1760000000000000_49", 2) };
      },
    });
    const { result } = renderHook(() => useEvents({ ...NO_EVENT_FILTERS, levels: ["error"] }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(params(urls[0]).get("limit")).toBe(String(EVENT_PAGE_SIZE));
    expect(params(urls[0]).get("include_total")).toBe("1");
    expect(params(urls[0]).get("before")).toBeNull();
    expect(params(urls[0]).getAll("level")).toEqual(["error"]);
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => { await result.current.fetchNextPage(); });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(params(urls[1]).get("before")).toBe("1760000000000000_49");
    expect(params(urls[1]).get("include_total")).toBe("0");
    expect(result.current.data?.pages.flatMap((each) => each.items.map((item) => item.id))).toEqual([50, 49, 40, 39]);
    expect(result.current.hasNextPage).toBe(false); // `next` was null: the last page
  });
});

describe("useEventPage: one page, for the calm refresh and the open incidents (w32)", () => {
  it("asks for the page it is given, with no total unless asked", async () => {
    const urls: string[] = [];
    mockFetch({ "GET /api/events": ({ url }) => { urls.push(url); return { body: page([3], null) }; } });
    const { result } = renderHook(() => useEventPage({ ...NO_EVENT_FILTERS, open: true }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(1));
    expect(params(urls[0]).get("open")).toBe("1");
    expect(params(urls[0]).get("include_total")).toBe("0");
    expect(params(urls[0]).get("limit")).toBe(String(EVENT_PAGE_SIZE));
  });

  it("reads again on the interval it is given (and not at all without one)", async () => {
    let calls = 0;
    mockFetch({ "GET /api/events": () => { calls += 1; return { body: page([calls], null) }; } });
    const { result } = renderHook(() => useEventPage(NO_EVENT_FILTERS, { refetchMs: 40 }), { wrapper: stableWrapper() });
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(3));
    await waitFor(() => expect(result.current.data?.items[0].id).toBeGreaterThanOrEqual(3));
  });

  it("does not ask while it is disabled", async () => {
    const calls = mockFetch({ "GET /api/events": () => ({ body: page([], null) }) });
    renderHook(() => useEventPage(NO_EVENT_FILTERS, { enabled: false }), { wrapper: stableWrapper() });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(0);
  });

  it("keeps the previous rows on screen while another filter loads", async () => {
    mockFetch({ "GET /api/events": ({ url }) => ({ body: params(url).get("source") === "5" ? page([7], null) : page([1, 2], null) }) });
    const { result, rerender } = renderHook(({ source }) => useEventPage({ ...NO_EVENT_FILTERS, source }), { wrapper: stableWrapper(), initialProps: { source: "" } });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(2));
    rerender({ source: "5" });
    expect(result.current.data?.items).toHaveLength(2);
    await waitFor(() => expect(result.current.data?.items.map((item) => item.id)).toEqual([7]));
  });
});

describe("one event, the options and the summary (w32)", () => {
  it("reads one event by its id and asks for nothing for an id the API cannot hold", async () => {
    const calls = mockFetch({ "GET /api/events/7": { body: { ...event(7), started_by: { audit_id: 3, username: "ziad", ts: "2026-10-22T07:59:00Z" } } } });
    const { result, rerender } = renderHook(({ id }: { id: number | null }) => useEvent(id), { wrapper: stableWrapper(), initialProps: { id: null as number | null } });
    rerender({ id: 0 });
    rerender({ id: 1.5 });
    rerender({ id: 3_000_000_000 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(0);
    rerender({ id: 7 });
    await waitFor(() => expect(result.current.data?.started_by?.username).toBe("ziad"));
    expect(calls.map((call) => call.path)).toEqual(["/api/events/7"]);
  });

  it("reads the options, and not when it is not enabled", async () => {
    const calls = mockFetch({ "GET /api/events/options": { body: { kinds: ["source.offline"], sources: [{ id: 4, name: "Plant OPC" }] } } });
    const off = renderHook(() => useEventOptions(false), { wrapper: stableWrapper() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(0);
    off.unmount();
    const { result } = renderHook(() => useEventOptions(), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.data?.sources[0].name).toBe("Plant OPC"));
  });

  it("reads the summary, which then refreshes every 10 seconds", async () => {
    mockFetch({ "GET /api/events/summary": { body: { open_incidents: 1, warnings_24h: 5, errors_24h: 2, kept: 3412, oldest: "2026-07-24T00:00:00Z", retention_days: 90, max_rows: 100000 } } });
    const { result } = renderHook(() => useEventSummary(), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.data?.open_incidents).toBe(1));
    expect(EVENTS_REFETCH_MS).toBe(10_000);
  });

  it("keeps every events read under the one prefix, so a write can refresh them all", () => {
    for (const key of [keys.eventsList(NO_EVENT_FILTERS, 50), keys.eventsPage(NO_EVENT_FILTERS, null, false, 50), keys.eventsOptions, keys.eventsSummary, keys.event(3)]) {
      expect(key.slice(0, keys.eventsAll.length)).toEqual([...keys.eventsAll]);
    }
    expect(keys.eventsSettings).not.toEqual([...keys.eventsAll]); // the retention settings live under "settings", with the other settings
  });
});

describe("the events retention setting (w32)", () => {
  const settings = (retention_days: number): EventsSettings => ({
    retention_days, max_rows: 100000, factory: { retention_days: 90, max_rows: 100000 },
    bounds: { retention_days: [7, 400], max_rows: [10000, 1000000] }, kept: 3412, oldest: "2026-07-24T00:00:00Z",
  });

  it("reads the setting", async () => {
    mockFetch({ "GET /api/settings/events": { body: settings(90) } });
    const { result } = renderHook(() => useEventsSettings(), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.data?.retention_days).toBe(90));
  });

  it("saves with confirm in the query string only (never in the body), and reads the setting, the events and the audit log again", async () => {
    let days = 90;
    let putUrl = "";
    const calls = mockFetch({
      "GET /api/settings/events": () => ({ body: settings(days) }),
      "GET /api/events/summary": { body: { open_incidents: 0, warnings_24h: 0, errors_24h: 0, kept: 1, oldest: null, retention_days: 90, max_rows: 100000 } },
      "GET /api/audit": { body: { total: 0, offset: 0, limit: 50, items: [] } },
      "PUT /api/settings/events": ({ body, url }) => { putUrl = url; days = (body as { retention_days: number }).retention_days; return { body: settings(days) }; },
    });
    const { result } = renderHook(() => ({ setting: useEventsSettings(), summary: useEventSummary(), save: useSaveEventsSettings() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.summary.data).toBeDefined());
    await waitFor(() => expect(result.current.setting.data?.retention_days).toBe(90));
    await act(async () => { await result.current.save.mutateAsync({ values: { retention_days: 30, max_rows: 100000 }, confirm: true }); });
    await waitFor(() => expect(result.current.setting.data?.retention_days).toBe(30));
    const put = calls.find((call) => call.method === "PUT")!;
    expect(put.body).toEqual({ retention_days: 30, max_rows: 100000 });
    expect(params(putUrl).get("confirm")).toBe("true");
    expect(calls.filter((call) => call.path === "/api/settings/events" && call.method === "GET")).toHaveLength(2);
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/events/summary")).toHaveLength(2));
  });

  it("asks without confirm first, and the 409 reaches the caller with the number of events it would delete; the reads are refreshed on the refusal too", async () => {
    const calls = mockFetch({
      "GET /api/settings/events": { body: settings(90) },
      "PUT /api/settings/events": { status: 409, body: { detail: "Saving would delete 120 events.", will_delete: 120 } },
    });
    const { result } = renderHook(() => ({ setting: useEventsSettings(), save: useSaveEventsSettings() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.setting.data).toBeDefined());
    let caught: unknown;
    await act(async () => {
      try { await result.current.save.mutateAsync({ values: { retention_days: 7, max_rows: 100000 }, confirm: false }); } catch (e) { caught = e; }
    });
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(409);
    expect(eventsLoss(caught)).toEqual({ detail: "Saving would delete 120 events.", willDelete: 120 });
    expect(calls.find((call) => call.method === "PUT")).toBeDefined();
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/settings/events" && call.method === "GET")).toHaveLength(2));
  });

  it("eventsLoss is null for any other error", () => {
    expect(eventsLoss(new ApiError(409, "x", { detail: "x" }))).toBeNull();
    expect(eventsLoss(new ApiError(422, "x", { detail: "x", will_delete: 3 }))).toBeNull();
    expect(eventsLoss(new Error("boom"))).toBeNull();
    expect(eventsLoss(null)).toBeNull();
  });
});
