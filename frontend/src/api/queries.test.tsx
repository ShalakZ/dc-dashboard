import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { NO_FILTERS } from "../lib/auditFilters";
import { holdFetch } from "../test/holdFetch";
import { mockFetch } from "../test/fetchMock";
import {
  auditPosition, useAudit, useAuditEntry, useAuditOptions, useBillingCosts, useCreateTariff, useDashboard, useDashboards, useDeleteUser, useGraph, usePatchUser,
  usePutGeneralSettings, usePutSignInPolicy, useSaveDashboard, useScan, useSeries, useSignInPolicy, useSite, useTariffs, useUnblockUser, useUsers, useWidgetData,
} from "./queries";
import type { RangePreset, WidgetConfig } from "./types";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("user queries", () => {
  it("lists users and refetches after a patch", async () => {
    let active = true;
    const calls = mockFetch({
      "GET /api/users": () => ({ body: [{ id: 2, username: "ops", role: "operator", active }] }),
      "PATCH /api/users/2": ({ body }) => { active = (body as { active: boolean }).active; return { body: { id: 2, username: "ops", role: "operator", active } }; },
    });
    const { result } = renderHook(() => ({ users: useUsers(), patch: usePatchUser() }), { wrapper });
    await waitFor(() => expect(result.current.users.data?.[0].active).toBe(true));
    await result.current.patch.mutateAsync({ id: 2, body: { active: false } });
    await waitFor(() => expect(result.current.users.data?.[0].active).toBe(false));
    expect(calls.filter((c) => c.path === "/api/users").length).toBe(2);
  });
});

describe("user delete and unblock", () => {
  const row = (id: number, blocked: boolean) => ({ id, username: `u${id}`, role: "viewer", active: true, blocked });

  it("deletes a user and refetches the list", async () => {
    let users = [row(2, false), row(3, false)];
    const calls = mockFetch({
      "GET /api/users": () => ({ body: users }),
      "DELETE /api/users/2": () => { users = users.filter((u) => u.id !== 2); return { status: 204 }; },
    });
    const { result } = renderHook(() => ({ users: useUsers(), del: useDeleteUser() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.users.data).toHaveLength(2));
    await result.current.del.mutateAsync(2);
    await waitFor(() => expect(result.current.users.data?.map((u) => u.id)).toEqual([3]));
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/api/users/2"]);
  });

  it("unblocks a user with an empty POST and refetches the list", async () => {
    let blocked = true;
    const calls = mockFetch({
      "GET /api/users": () => ({ body: [row(2, blocked)] }),
      "POST /api/users/2/unblock": () => { blocked = false; return { body: { cleared: 2 } }; },
    });
    const { result } = renderHook(() => ({ users: useUsers(), unblock: useUnblockUser() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.users.data?.[0].blocked).toBe(true));
    await expect(result.current.unblock.mutateAsync(2)).resolves.toEqual({ cleared: 2 });
    await waitFor(() => expect(result.current.users.data?.[0].blocked).toBe(false));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({});
  });

  // Both write an audit row (user.deleted, login.unblocked), and the Audit "User" filter is cached for a minute: without
  // an invalidation it would lack "(deleted)" for that long.
  it("refetches the audit filter options after a delete", async () => {
    const calls = mockFetch({
      "GET /api/users": { body: [row(2, false)] },
      "GET /api/audit/options": { body: { actions: [], users: [], unattributed: false } },
      "DELETE /api/users/2": { status: 204 },
    });
    const { result } = renderHook(() => ({ options: useAuditOptions(), del: useDeleteUser() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.options.data).toBeDefined());
    await result.current.del.mutateAsync(2);
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/audit/options")).toHaveLength(2));
  });

  it("refetches the audit filter options after an unblock", async () => {
    const calls = mockFetch({
      "GET /api/audit/options": { body: { actions: [], users: [], unattributed: false } },
      "POST /api/users/2/unblock": { body: { cleared: 1 } },
    });
    const { result } = renderHook(() => ({ options: useAuditOptions(), unblock: useUnblockUser() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.options.data).toBeDefined());
    await result.current.unblock.mutateAsync(2);
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/audit/options")).toHaveLength(2));
  });
});

describe("sign-in policy queries", () => {
  const answer = (max_failures: number, block_minutes: number) => ({
    max_failures, block_minutes,
    limits: { max_failures: [3, 20], block_minutes: [1, 60] },
    defaults: { max_failures: 5, block_minutes: 5 },
  });

  it("reads the policy and refetches it after a save", async () => {
    let policy = answer(5, 5);
    const calls = mockFetch({
      "GET /api/settings/sign-in": () => ({ body: policy }),
      "PUT /api/settings/sign-in": ({ body }) => {
        const b = body as { max_failures: number; block_minutes: number };
        policy = answer(b.max_failures, b.block_minutes);
        return { body: policy };
      },
    });
    const { result } = renderHook(() => ({ policy: useSignInPolicy(), put: usePutSignInPolicy() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.policy.data?.max_failures).toBe(5));
    expect(result.current.policy.data?.limits.block_minutes).toEqual([1, 60]);
    await result.current.put.mutateAsync({ max_failures: 8, block_minutes: 15 });
    await waitFor(() => expect(result.current.policy.data?.block_minutes).toBe(15));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ max_failures: 8, block_minutes: 15 });
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/settings/sign-in")).toHaveLength(2);
  });
});

describe("discovery queries", () => {
  it("passes the page window to the audit endpoint", async () => {
    let url = "";
    mockFetch({ "GET /api/audit": (req) => { url = req.url; return { body: { total: 0, offset: 100, limit: 50, items: [] } }; } });
    const { result } = renderHook(() => useAudit(NO_FILTERS, 50, 100), { wrapper });
    await waitFor(() => expect(result.current.data?.total).toBe(0));
    expect(new URL(url, "http://x").searchParams.toString()).toBe("limit=50&offset=100");
  });

  it("sends the filters before the page window", async () => {
    let url = "";
    mockFetch({ "GET /api/audit": (req) => { url = req.url; return { body: { total: 0, offset: 100, limit: 50, items: [] } }; } });
    const filters = { user: "2", actions: ["*.deleted"], from: "2026-10-01", to: "2026-10-05", q: "say hi" };
    const { result } = renderHook(() => useAudit(filters, 50, 100), { wrapper });
    await waitFor(() => expect(result.current.data?.total).toBe(0));
    expect(new URL(url, "http://x").searchParams.toString())
      .toBe("user=2&action=*.deleted&from=2026-10-01&to=2026-10-05&q=say+hi&limit=50&offset=100");
  });

  it("reads the graph from the discovery endpoint", async () => {
    const calls = mockFetch({ "GET /api/discovery/graph": { body: { sources: [], unidentified: [], assets: [], layout: {} } } });
    const { result } = renderHook(() => useGraph(), { wrapper });
    await waitFor(() => expect(result.current.data?.sources).toEqual([]));
    expect(calls.map((c) => c.path)).toEqual(["/api/discovery/graph"]);
  });

  it("does not fetch a scan until it has an id, and stops polling once the scan has finished", async () => {
    const failed = { id: 7, status: "failed", error: "collector offline", findings: [], progress: {} };
    const calls = mockFetch({ "GET /api/scans/7": { body: failed } });
    const { result, rerender } = renderHook(({ id }: { id: number | null }) => useScan(id), { wrapper, initialProps: { id: null as number | null } });
    expect(calls).toHaveLength(0);
    rerender({ id: 7 });
    await waitFor(() => expect(result.current.data?.status).toBe("failed"));
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(calls).toHaveLength(1);
  });
});

// The shared `wrapper` above builds a new QueryClient whenever it re-renders, which would throw away the cache on `rerender`.
function stableWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("phase 3 queries", () => {
  it("reads the site and refetches it after the timezone is saved", async () => {
    let timezone = "UTC";
    const calls = mockFetch({
      "GET /api/site": () => ({ body: { timezone, currency: null } }),
      "PUT /api/settings/general": ({ body }) => { timezone = (body as { timezone: string }).timezone; return { body: { timezone } }; },
    });
    const { result } = renderHook(() => ({ site: useSite(), put: usePutGeneralSettings() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.site.data?.timezone).toBe("UTC"));
    await result.current.put.mutateAsync({ timezone: "Asia/Qatar" });
    await waitFor(() => expect(result.current.site.data?.timezone).toBe("Asia/Qatar"));
    expect(calls.filter((c) => c.path === "/api/site")).toHaveLength(2);
  });

  it("refetches tariffs and billing costs after a tariff is created", async () => {
    const empty = { month: "2026-10", timezone: "UTC", currency: null, days: [], assets: [] };
    const created = { id: 1, asset_id: null, asset_name: null, rate_per_kwh: 0.12, effective_from: "2026-10-01", created_by: 1, created_at: "t" };
    const calls = mockFetch({
      "GET /api/tariffs": { body: [] },
      "GET /api/billing/costs": { body: empty },
      "POST /api/tariffs": { status: 201, body: created },
    });
    const { result } = renderHook(() => ({ tariffs: useTariffs(), costs: useBillingCosts("2026-10"), create: useCreateTariff() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.costs.data?.month).toBe("2026-10"));
    await result.current.create.mutateAsync({ asset_id: null, rate_per_kwh: 0.12, effective_from: "2026-10-01" });
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.path === "/api/tariffs")).toHaveLength(2));
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/billing/costs")).toHaveLength(2));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ asset_id: null, rate_per_kwh: 0.12, effective_from: "2026-10-01" });
  });

  it("asks for the billing month it is given and stays idle without one", async () => {
    let url = "";
    const calls = mockFetch({
      "GET /api/billing/costs": (req) => {
        url = req.url;
        return { body: { month: "2026-09", timezone: "UTC", currency: null, days: [], assets: [] } };
      },
    });
    const { result, rerender } = renderHook(({ month }: { month: string | null }) => useBillingCosts(month), {
      wrapper: stableWrapper(), initialProps: { month: null as string | null },
    });
    expect(calls).toHaveLength(0);
    rerender({ month: "2026-09" });
    await waitFor(() => expect(result.current.data?.month).toBe("2026-09"));
    expect(new URL(url, "http://x").searchParams.get("month")).toBe("2026-09");
  });

  it("posts the widget config with the effective range and keeps the old figures while the range changes", async () => {
    const config = {
      assets: [5], source: "metric" as const, metric: "active_power_kw" as const, aggregation: "last" as const,
      range: null, bars: "asset" as const, min: 0, max: null,
    };
    const calls = mockFetch({
      "POST /api/widget-data": ({ body }) => ({
        body: {
          type: "stat", mode: "values", source: "metric", metric: "active_power_kw", unit: "kW",
          range: { preset: (body as { range: string }).range, start: "s", end: "e" },
          tier: null, bucket: null, series: [], values: [], missing: [], no_metric: [],
        },
      }),
    });
    const { result, rerender } = renderHook(({ preset }: { preset: RangePreset }) => useWidgetData("stat", config, preset), {
      wrapper: stableWrapper(), initialProps: { preset: "24h" as RangePreset },
    });
    await waitFor(() => expect(result.current.data?.range.preset).toBe("24h"));
    rerender({ preset: "7d" });
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.range.preset).toBe("24h");
    await waitFor(() => expect(result.current.data?.range.preset).toBe("7d"));
    expect(calls.map((c) => c.body)).toEqual([{ type: "stat", config, range: "24h" }, { type: "stat", config, range: "7d" }]);
  });

  it("keeps the old figures only for the same widget: a changed type or config shows nothing until its own answer arrives (an editor preview must not draw the old widget's data)", async () => {
    const stat: WidgetConfig = { assets: [5], source: "metric", metric: "active_power_kw", aggregation: "last", range: null, bars: "asset", min: 0, max: null };
    mockFetch({
      "POST /api/widget-data": ({ body }) => {
        const { type, config } = body as { type: string; config: { source: string } };
        return {
          body: {
            type, mode: type === "timeseries" ? "series" : "values", source: config.source, metric: "active_power_kw", unit: "kW",
            range: { preset: "24h", start: "s", end: "e" }, tier: null, bucket: null, series: [], values: [], missing: [], no_metric: [],
          },
        };
      },
    });
    const { result, rerender } = renderHook(
      ({ type, config }: { type: "timeseries" | "gauge"; config: WidgetConfig }) => useWidgetData(type, config, "24h"),
      { wrapper: stableWrapper(), initialProps: { type: "timeseries" as "timeseries" | "gauge", config: stat } },
    );
    await waitFor(() => expect(result.current.data?.type).toBe("timeseries"));
    rerender({ type: "gauge", config: stat }); // another type
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPlaceholderData).toBe(false);
    await waitFor(() => expect(result.current.data?.type).toBe("gauge"));
    rerender({ type: "gauge", config: { ...stat, source: "energy", aggregation: "sum" } }); // same type, another source
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.source).toBe("energy"));
    rerender({ type: "gauge", config: { ...stat, source: "energy", aggregation: "sum" } }); // an equal config (new object) is the same widget
    expect(result.current.data?.source).toBe("energy");
  });

  it("saves a dashboard with one PUT, updates the cached dashboard and refreshes only the list", async () => {
    const stored = { id: 5, name: "Hall A", range: "24h", updated_at: "2026-10-08T10:00:00Z", widgets: [] };
    const saved = { ...stored, name: "Hall B", updated_at: "2026-10-08T10:00:01Z" };
    const calls = mockFetch({
      "GET /api/dashboards/5": { body: stored },
      "GET /api/dashboards": { body: [] },
      "PUT /api/dashboards/5": { body: saved },
    });
    const { result } = renderHook(() => ({ d: useDashboard(5), list: useDashboards(), save: useSaveDashboard() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.d.data?.name).toBe("Hall A"));
    const body = { name: "Hall B", range: "24h" as const, updated_at: "2026-10-08T10:00:00Z", widgets: [] };
    await result.current.save.mutateAsync({ id: 5, body });
    await waitFor(() => expect(result.current.d.data?.updated_at).toBe("2026-10-08T10:00:01Z"));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual(body);
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/dashboards/5")).toHaveLength(1); // no refetch of the detail
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/dashboards")).toHaveLength(2));
  });
});

describe("useSeries refetching", () => {
  afterEach(() => vi.useRealTimers());
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  const series = { metric: "active_power_kw", unit: "kW", points: [] };
  const fetched = (calls: { path: string }[]) => calls.filter((c) => c.path === "/api/assets/4/series").length;

  it("fetches a 1h series again after 10 s, not after 5 s", async () => {
    vi.useFakeTimers();
    const calls = mockFetch({ "GET /api/assets/4/series": { body: series } });
    renderHook(() => useSeries(4, "active_power_kw", "1h"), { wrapper: stableWrapper() });
    await advance(1_000);
    expect(fetched(calls)).toBe(1);
    await advance(5_000); // 6 s since the first answer
    expect(fetched(calls)).toBe(1);
    await advance(5_000); // 11 s
    expect(fetched(calls)).toBe(2);
  });

  it("fetches a 24h series every minute, not every 10 s", async () => {
    vi.useFakeTimers();
    const calls = mockFetch({ "GET /api/assets/4/series": { body: series } });
    renderHook(() => useSeries(4, "active_power_kw", "24h"), { wrapper: stableWrapper() });
    await advance(30_000);
    expect(fetched(calls)).toBe(1);
    await advance(35_000); // 65 s
    expect(fetched(calls)).toBe(2);
  });

  it("stops refetching while paused and goes on when resumed", async () => {
    vi.useFakeTimers();
    const calls = mockFetch({ "GET /api/assets/4/series": { body: series } });
    const { rerender } = renderHook(({ paused }: { paused: boolean }) => useSeries(4, "active_power_kw", "1h", undefined, paused), {
      wrapper: stableWrapper(), initialProps: { paused: true },
    });
    await advance(1_000);
    expect(fetched(calls)).toBe(1);
    await advance(60_000);
    expect(fetched(calls)).toBe(1); // paused: nothing for a whole minute
    rerender({ paused: false });
    await advance(11_000);
    expect(fetched(calls)).toBe(2);
  });
});

describe("audit queries", () => {
  const entry = (id: number) => ({ id, user_id: 1, actor_id: 1, username: "admin", action: "scan.finished", detail: {}, ts: "2026-10-07T10:00:00Z" });

  it("keeps the previous page on screen, marked as placeholder, while the next one loads", async () => {
    mockFetch({
      "GET /api/audit": ({ url }) => ({
        body: url.includes("offset=50")
          ? { total: 51, offset: 50, limit: 50, items: [entry(1)] }
          : { total: 51, offset: 0, limit: 50, items: [entry(51)] },
      }),
    });
    const { result, rerender } = renderHook(({ offset }) => useAudit(NO_FILTERS, 50, offset), {
      wrapper: stableWrapper(), initialProps: { offset: 0 },
    });
    await waitFor(() => expect(result.current.data?.items[0].id).toBe(51));
    expect(result.current.isPlaceholderData).toBe(false);
    const held = holdFetch((_method, path) => path === "/api/audit");
    rerender({ offset: 50 });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(result.current.data?.items[0].id).toBe(51);
    held.release();
    await waitFor(() => expect(result.current.data?.items[0].id).toBe(1));
    expect(result.current.isPlaceholderData).toBe(false);
  });

  it("reads the filter options and caches them for a minute", async () => {
    const options = { actions: ["scan.finished"], users: [{ id: 1, name: "admin" }], unattributed: true };
    const calls = mockFetch({ "GET /api/audit/options": { body: options } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const shared = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const first = renderHook(() => useAuditOptions(), { wrapper: shared });
    await waitFor(() => expect(first.result.current.data).toEqual(options));
    const second = renderHook(() => useAuditOptions(), { wrapper: shared });
    expect(second.result.current.data).toEqual(options);
    expect(calls.filter((c) => c.path === "/api/audit/options")).toHaveLength(1);
  });

  it("fetches one entry only for a usable id", async () => {
    const calls = mockFetch({ "GET /api/audit/7": { body: entry(7) } });
    for (const id of [null, 0, -1, 1.5, Number.NaN, 2_147_483_648]) {
      const { result } = renderHook(() => useAuditEntry(id), { wrapper });
      expect(result.current.fetchStatus).toBe("idle");
    }
    expect(calls).toHaveLength(0);
    const { result } = renderHook(() => useAuditEntry(7), { wrapper });
    await waitFor(() => expect(result.current.data?.id).toBe(7));
    expect(calls.map((c) => c.path)).toEqual(["/api/audit/7"]);
  });

  it("asks where a day starts in the filtered log", async () => {
    let url = "";
    mockFetch({ "GET /api/audit/position": (req) => { url = req.url; return { body: { offset: 73, total: 120, on_day: true } }; } });
    const answer = await auditPosition({ ...NO_FILTERS, actions: ["*.deleted"], q: "a b" }, "2026-10-05");
    expect(answer).toEqual({ offset: 73, total: 120, on_day: true });
    expect(new URL(url, "http://x").searchParams.toString()).toBe("action=*.deleted&q=a+b&date=2026-10-05");
  });
});
