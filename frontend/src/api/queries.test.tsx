import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { NO_FILTERS } from "../lib/auditFilters";
import { isStaleMove, moveRefusals } from "../lib/moveText";
import { holdFetch } from "../test/holdFetch";
import { mockFetch } from "../test/fetchMock";
import {
  auditPageOptions, auditPosition, buildReport, useBuildReport, useStartCheck, useAudit, useAuditEntry, useAuditOptions, useBillingCosts, useCreateTariff, useCreateUser, useDashboard, useDashboards, useDeleteUser, useFleetSummary, useGraph, usePatchUser,
  usePutBillingSettings, usePutGeneralSettings, usePutSignInPolicy, useRowsPerDay, useSaveDashboard, useScan, useSeries, useSignInPolicy, useSite, useStatus, useTariffs, useUnblockUser, useUsers, useWidgetData,
  useCreateRole, useDeleteRole, useDuplicateRole, usePatchRole, usePermissions, useRoles, keys,
  useAddStarterKinds, useAssetKinds, useAssets, useBulkDeleteAssetKinds, useCreateAssetKind, useDeleteAssetKind, usePatchAssetKind, useSummary,
  loadMovePreview, useMoveAssets, useRemoveDiscoveredSources, useTidyLayout, useBillingMonths, useBillingMonthCheck, useCloseBillingMonth, useReopenBillingMonth, monthCheckRefetchMs,
} from "./queries";
import { ApiError } from "./client";
import type { MoveBody, RangePreset, WidgetConfig } from "./types";

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

// user.created, user.updated and settings.sign_in_policy_changed each write an audit row and may add a name or an action to
// the Audit filters, which are cached for a minute.
describe("audit filter options refresh", () => {
  const options = { body: { actions: [], users: [], unattributed: false } };

  it("refetches the audit filter options after creating a user", async () => {
    const calls = mockFetch({
      "GET /api/audit/options": options,
      "POST /api/users": { body: { id: 5, username: "new", role: "viewer", active: true, blocked: false } },
    });
    const { result } = renderHook(() => ({ options: useAuditOptions(), create: useCreateUser() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.options.data).toBeDefined());
    await result.current.create.mutateAsync({ username: "new", password: "a-long-password", role: "viewer" });
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/audit/options")).toHaveLength(2));
  });

  it("refetches the audit filter options after editing a user", async () => {
    const calls = mockFetch({
      "GET /api/audit/options": options,
      "PATCH /api/users/2": { body: { id: 2, username: "ops", role: "viewer", active: true, blocked: false } },
    });
    const { result } = renderHook(() => ({ options: useAuditOptions(), patch: usePatchUser() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.options.data).toBeDefined());
    await result.current.patch.mutateAsync({ id: 2, body: { role: "viewer" } });
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/audit/options")).toHaveLength(2));
  });

  it("refetches the audit filter options after saving the sign-in policy", async () => {
    const calls = mockFetch({
      "GET /api/audit/options": options,
      "PUT /api/settings/sign-in": {
        body: {
          max_failures: 8, block_minutes: 15,
          limits: { max_failures: [3, 20], block_minutes: [1, 60] },
          defaults: { max_failures: 5, block_minutes: 5 },
        },
      },
    });
    const { result } = renderHook(() => ({ options: useAuditOptions(), put: usePutSignInPolicy() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.options.data).toBeDefined());
    await result.current.put.mutateAsync({ max_failures: 8, block_minutes: 15 });
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/audit/options")).toHaveLength(2));
  });
});

describe("sign-in policy queries", () => {
  const answer = (max_failures: number, block_minutes: number) => ({
    max_failures, block_minutes, enabled: true,
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

describe("sign-in policy: a 409 that asks for confirmation", () => {
  const answer = (enabled: boolean) => ({
    max_failures: 5, block_minutes: 5, enabled,
    limits: { max_failures: [3, 20], block_minutes: [1, 60] },
    defaults: { max_failures: 5, block_minutes: 5 },
  });

  it("refetches the policy, so a stale switch shows the server's state; the error still reaches the caller", async () => {
    let enabled = false; // what the page first read
    const calls = mockFetch({
      "GET /api/settings/sign-in": () => ({ body: answer(enabled) }),
      "PUT /api/settings/sign-in": () => {
        enabled = true; // someone switched it on in the meantime
        return { status: 409, body: { detail: "Sign-in protection is on. Switching it off needs confirmation: reload the Settings page and switch it off again.", needs_confirmation: true } };
      },
    });
    const { result } = renderHook(() => ({ policy: useSignInPolicy(), put: usePutSignInPolicy() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.policy.data?.enabled).toBe(false));
    await expect(result.current.put.mutateAsync({ max_failures: 5, block_minutes: 5, enabled: false })).rejects.toThrow("needs confirmation");
    await waitFor(() => expect(result.current.policy.data?.enabled).toBe(true));
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/settings/sign-in")).toHaveLength(2);
  });

  it("does not refetch for any other refusal", async () => {
    const calls = mockFetch({
      "GET /api/settings/sign-in": () => ({ body: answer(true) }),
      "PUT /api/settings/sign-in": () => ({ status: 422, body: { detail: "max_failures must be at least 3" } }),
    });
    const { result } = renderHook(() => ({ policy: useSignInPolicy(), put: usePutSignInPolicy() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.policy.data?.enabled).toBe(true));
    await act(async () => {
      await expect(result.current.put.mutateAsync({ max_failures: 1, block_minutes: 5 })).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 50)); // time for a refetch that would wrongly start
    });
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/settings/sign-in")).toHaveLength(1);
  });
});

describe("sign-in switch and rows per day", () => {
  const jsonReply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  it("sends confirm in the query string only, never in the body", async () => {
    const fetchSpy = vi.fn(async () => jsonReply({}));
    vi.stubGlobal("fetch", fetchSpy);
    const { result } = renderHook(() => usePutSignInPolicy(), { wrapper: stableWrapper() });
    await result.current.mutateAsync({ max_failures: 5, block_minutes: 5, enabled: false, confirm: true });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/settings/sign-in?confirm=true");
    expect(JSON.parse(init.body as string)).toEqual({ max_failures: 5, block_minutes: 5, enabled: false });
    await result.current.mutateAsync({ max_failures: 5, block_minutes: 5 });
    const [plain, plainInit] = fetchSpy.mock.calls[1] as unknown as [string, RequestInit];
    expect(plain).toBe("/api/settings/sign-in");
    expect(JSON.parse(plainInit.body as string)).toEqual({ max_failures: 5, block_minutes: 5 });
    vi.unstubAllGlobals();
  });

  it("asks for rows per day only when both days are given", async () => {
    const fetchSpy = vi.fn(async () => jsonReply({ start: "2026-10-01", end: "2026-10-03", days: [], total_rows: 0, first_day: null, last_day: "2026-10-12" }));
    vi.stubGlobal("fetch", fetchSpy);
    const idle = renderHook(() => useRowsPerDay(null, "2026-10-03"), { wrapper: stableWrapper() });
    expect(idle.result.current.fetchStatus).toBe("idle");
    const { result } = renderHook(() => useRowsPerDay("2026-10-01", "2026-10-03"), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.data?.last_day).toBe("2026-10-12"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0] as unknown as [string])[0]).toBe("/api/storage/rows-per-day?start=2026-10-01&end=2026-10-03");
    vi.unstubAllGlobals();
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

  it("reads a page with fetchQuery under the key useAudit uses, so the list finds it in the cache (the drawer's Previous and Next)", async () => {
    const filters = { user: "2", actions: ["*.deleted"], from: "", to: "", q: "" };
    expect(auditPageOptions(filters, 50, 100).queryKey).toEqual(keys.audit(filters, 50, 100));
    const calls = mockFetch({ "GET /api/audit": { body: { total: 120, offset: 100, limit: 50, items: [] } } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = await client.fetchQuery(auditPageOptions(filters, 50, 100));
    const { result } = renderHook(() => useAudit(filters, 50, 100), {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    expect(result.current.data).toBe(page); // there on the first render: no loading, no placeholder
    expect(result.current.isPlaceholderData).toBe(false);
    expect(calls.filter((c) => c.path === "/api/audit").length).toBeGreaterThanOrEqual(1);
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

describe("useStatus", () => {
  it("asks /api/status for the collector and reading state", async () => {
    const calls = mockFetch({ "GET /api/status": { body: { collector_alive: true, readings_fresh: false, last_reading_age_seconds: 300 } } });
    const { result } = renderHook(() => useStatus(), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.data).toEqual({ collector_alive: true, readings_fresh: false, last_reading_age_seconds: 300 }));
    expect(calls.filter((c) => c.path === "/api/status")).toHaveLength(1);
  });
});

describe("useFleetSummary", () => {
  afterEach(() => vi.useRealTimers());
  const body = {
    power: { kw: 12.5, counted: 2, of: 2 }, energy_today: null, cost_today: null, currency: "QAR", attention: { total: 0, items: [] },
  };
  const fetched = (calls: { path: string }[]) => calls.filter((c) => c.path === "/api/fleet/summary").length;

  it("reads the fleet summary from its endpoint", async () => {
    const calls = mockFetch({ "GET /api/fleet/summary": { body } });
    const { result } = renderHook(() => useFleetSummary(), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.data).toEqual(body));
    expect(fetched(calls)).toBe(1);
  });

  it("fetches again every 15 s, not after 10 s", async () => {
    vi.useFakeTimers();
    const calls = mockFetch({ "GET /api/fleet/summary": { body } });
    renderHook(() => useFleetSummary(), { wrapper: stableWrapper() });
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(fetched(calls)).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(10_000)); // 11 s
    expect(fetched(calls)).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(5_000)); // 16 s
    expect(fetched(calls)).toBe(2);
  });

  it("is fetched again after the currency or a rate changes, like the other cost figures", async () => {
    const calls = mockFetch({
      "GET /api/fleet/summary": { body },
      "PUT /api/settings/billing": { body: { currency: "USD" } },
    });
    const { result } = renderHook(() => ({ fleet: useFleetSummary(), put: usePutBillingSettings() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.fleet.data).toBeDefined());
    await result.current.put.mutateAsync({ currency: "USD" });
    await waitFor(() => expect(fetched(calls)).toBe(2));
  });
});

describe("useStartCheck", () => {
  it("posts to the source's check route and returns the job id", async () => {
    const calls = mockFetch({ "POST /api/sources/7/check": { status: 202, body: { job_id: 41 } } });
    const { result } = renderHook(() => useStartCheck(7), { wrapper: stableWrapper() });
    expect(await result.current.mutateAsync()).toEqual({ job_id: 41 });
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/api/sources/7/check"]);
  });

  it("keeps the 409 body, which names the check that is already running", async () => {
    mockFetch({ "POST /api/sources/7/check": { status: 409, body: { detail: "a connection check is already running for this source", job_id: 40 } } });
    const { result } = renderHook(() => useStartCheck(7), { wrapper: stableWrapper() });
    await expect(result.current.mutateAsync()).rejects.toMatchObject({ status: 409, body: { job_id: 40 } });
  });

  it("refreshes the audit log, since the start is audited", async () => {
    const calls = mockFetch({
      "POST /api/sources/7/check": { status: 202, body: { job_id: 41 } },
      "GET /api/audit/options": { body: { actions: [], users: [] } },
    });
    const { result } = renderHook(() => ({ options: useAuditOptions(), start: useStartCheck(7) }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.options.isSuccess).toBe(true));
    await result.current.start.mutateAsync();
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/audit/options")).toHaveLength(2));
  });
});

describe("buildReport", () => {
  /** The URLs the report route was asked for (mockFetch records paths without the query). */
  const urls = () => {
    const seen: string[] = [];
    mockFetch({
      "GET /api/diagnostics/report": ({ url }) => {
        seen.push(url);
        return { body: { format: "DCDASH-REPORT v1", build_id: "abc", detail: "summary", mask: false, checksum: "c", parts: [], legend: [] } };
      },
    });
    return seen;
  };

  it("asks for the JSON form with the chosen options and the browser's clock", async () => {
    const seen = urls();
    const before = Date.now();
    await buildReport({ detail: "full", mask: true, source: 4 });
    const query = new URL(seen[0], "http://x").searchParams;
    expect([query.get("detail"), query.get("mask"), query.get("format"), query.get("source")]).toEqual(["full", "1", "json", "4"]);
    const clock = Date.parse(query.get("client_time") ?? "");
    expect(clock).toBeGreaterThanOrEqual(before);
    expect(clock).toBeLessThanOrEqual(Date.now());
    expect(query.get("client_time")).toMatch(/Z$/); // an ISO instant with its zone
  });

  it("leaves source out for all sources and sends mask=0 unmasked", async () => {
    const seen = urls();
    await buildReport({ detail: "summary", mask: false, source: null });
    const query = new URL(seen[0], "http://x").searchParams;
    expect(query.has("source")).toBe(false);
    expect(query.get("mask")).toBe("0");
  });

  it("is a mutation: nothing is requested until it is called, and a refocus asks nothing", async () => {
    const seen = urls();
    const { result } = renderHook(() => useBuildReport(), { wrapper: stableWrapper() });
    expect(seen).toHaveLength(0);
    window.dispatchEvent(new Event("focus"));
    expect(seen).toHaveLength(0);
    await act(async () => { await result.current.mutateAsync({ detail: "summary", mask: false, source: null }); });
    expect(seen).toHaveLength(1);
  });
});

describe("role queries", () => {
  const role = (over: Record<string, unknown> = {}) => ({ id: 7, name: "Executive", description: "", builtin: false, user_count: 0, assignable: true, permissions: ["assets.view"], ...over });
  const userRow = { id: 2, username: "ops", role: "Executive", active: true, blocked: false };
  const PERMISSION = { id: "assets.view", area: "Assets Tree", kind: "see", label: "See the Assets Tree", description: "Open the Assets Tree." };
  const count = (calls: { method: string; path: string }[], path: string) => calls.filter((c) => c.method === "GET" && c.path === path).length; // reads only: POST /api/roles shares a path

  it("reads the catalogue once: it is never stale", async () => {
    const calls = mockFetch({ "GET /api/permissions": { body: [PERMISSION] } });
    const { result, rerender } = renderHook(() => usePermissions(), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.data).toEqual([PERMISSION]));
    rerender();
    window.dispatchEvent(new Event("focus"));
    expect(count(calls, "/api/permissions")).toBe(1);
  });

  // Every role change moves what the Users tab shows (the role select, its description, the Users column) and writes an audit row.
  it.each([
    ["creating a role", () => useCreateRole(), "POST /api/roles", { name: "Executive", description: "", permissions: ["assets.view"] }, (m: ReturnType<typeof useCreateRole>) => m.mutateAsync({ name: "Executive", description: "", permissions: ["assets.view"] })],
    ["saving a role", () => usePatchRole(), "PATCH /api/roles/7", { name: "Board" }, (m: ReturnType<typeof usePatchRole>) => m.mutateAsync({ id: 7, body: { name: "Board" } })],
    ["duplicating a role", () => useDuplicateRole(), "POST /api/roles/2/duplicate", {}, (m: ReturnType<typeof useDuplicateRole>) => m.mutateAsync({ id: 2 })],
  ] as const)("refetches the roles, the users and the audit options after %s", async (_name, hook, route, sent, run) => {
    const calls = mockFetch({
      "GET /api/roles": { body: [role()] },
      "GET /api/users": { body: [userRow] },
      "GET /api/audit/options": { body: { actions: [], users: [], unattributed: false } },
      [route]: { status: route.startsWith("POST") ? 201 : 200, body: role() },
    });
    const { result } = renderHook(() => ({ roles: useRoles(), users: useUsers(), options: useAuditOptions(), mutation: hook() }), { wrapper: stableWrapper() });
    await waitFor(() => expect([result.current.roles.data, result.current.users.data, result.current.options.data].every(Boolean)).toBe(true));
    await act(async () => { await run(result.current.mutation as never); });
    await waitFor(() => expect([count(calls, "/api/roles"), count(calls, "/api/users"), count(calls, "/api/audit/options")]).toEqual([2, 2, 2]));
    expect(calls.find((c) => c.method !== "GET")?.body).toEqual(sent);
  });

  it("sends the new name to the duplicate route only when one is given", async () => {
    const calls = mockFetch({ "POST /api/roles/2/duplicate": { status: 201, body: role({ name: "Mine" }) } });
    const { result } = renderHook(() => useDuplicateRole(), { wrapper: stableWrapper() });
    await act(async () => { await result.current.mutateAsync({ id: 2, name: "Mine" }); });
    expect(calls[0].body).toEqual({ name: "Mine" });
  });

  it("refetches after a delete and ALSO after a refused one (a 409 means the list on screen is out of date)", async () => {
    let refuse = true;
    const calls = mockFetch({
      "GET /api/roles": { body: [role()] },
      "GET /api/users": { body: [userRow] },
      "GET /api/audit/options": { body: { actions: [], users: [], unattributed: false } },
      "DELETE /api/roles/7": () => (refuse ? { status: 409, body: { detail: "role is in use by 1 account(s)" } } : { status: 204 }),
    });
    const { result } = renderHook(() => ({ roles: useRoles(), users: useUsers(), options: useAuditOptions(), del: useDeleteRole() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.options.data).toBeDefined());
    await waitFor(() => expect(result.current.roles.data).toBeDefined());
    await act(async () => { await expect(result.current.del.mutateAsync(7)).rejects.toThrow("role is in use by 1 account(s)"); });
    await waitFor(() => expect([count(calls, "/api/roles"), count(calls, "/api/users"), count(calls, "/api/audit/options")]).toEqual([2, 2, 2]));
    refuse = false;
    await act(async () => { await result.current.del.mutateAsync(7); });
    await waitFor(() => expect(count(calls, "/api/roles")).toBe(3));
  });

  it("refetches after a PATCH that finds the role gone (404), so the list drops it", async () => {
    const calls = mockFetch({
      "GET /api/roles": { body: [role()] },
      "PATCH /api/roles/7": { status: 404, body: { detail: "Role not found." } },
    });
    const { result } = renderHook(() => ({ roles: useRoles(), patch: usePatchRole() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.roles.data).toBeDefined());
    await act(async () => { await expect(result.current.patch.mutateAsync({ id: 7, body: { name: "x" } })).rejects.toThrow("Role not found."); });
    await waitFor(() => expect(count(calls, "/api/roles")).toBe(2));
  });

  // The other direction: an account gained, lost or changed its role, so the Users column of the Roles list and the delete button's state are stale.
  it.each([
    ["creating a user", () => useCreateUser(), "POST /api/users", (m: ReturnType<typeof useCreateUser>) => m.mutateAsync({ username: "new", password: "a-long-password", role: "Executive" })],
    ["changing a user", () => usePatchUser(), "PATCH /api/users/2", (m: ReturnType<typeof usePatchUser>) => m.mutateAsync({ id: 2, body: { role: "viewer" } })],
    ["deleting a user", () => useDeleteUser(), "DELETE /api/users/2", (m: ReturnType<typeof useDeleteUser>) => m.mutateAsync(2)],
  ] as const)("refetches the roles after %s", async (_name, hook, route, run) => {
    const calls = mockFetch({
      "GET /api/roles": { body: [role()] },
      [route]: route.startsWith("DELETE") ? { status: 204 } : { body: userRow },
    });
    const { result } = renderHook(() => ({ roles: useRoles(), mutation: hook() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.roles.data).toBeDefined());
    await act(async () => { await run(result.current.mutation as never); });
    await waitFor(() => expect(count(calls, "/api/roles")).toBe(2));
  });
});

describe("asset kind queries", () => {
  const kind = (over: Record<string, unknown> = {}) => ({ id: 3, name: "Rack", icon: "rack", asset_count: 2, ...over });
  const count = (calls: { method: string; path: string }[], path: string) => calls.filter((c) => c.method === "GET" && c.path === path).length;
  const AUDIT = { actions: [], users: [], unattributed: false };
  const reads = {
    "GET /api/assets": { body: [] },
    "GET /api/asset-kinds": { body: [kind()] },
    "GET /api/assets/4/summary": { body: {} },
    "GET /api/fleet/summary": { body: {} },
    "GET /api/audit/options": { body: AUDIT },
  };
  /** Everything a kind change can make stale: the asset list (kind_icon, kind text), the kinds with their counts, one asset's summary, the fleet and the audit options. */
  const mountReaders = (mutation: () => unknown) =>
    renderHook(
      () => ({ assets: useAssets(), kinds: useAssetKinds(), summary: useSummary(4), fleet: useFleetSummary(), options: useAuditOptions(), mutation: mutation() }),
      { wrapper: stableWrapper() },
    );
  const settled = async (result: { current: { assets: { data?: unknown }; kinds: { data?: unknown }; summary: { data?: unknown }; fleet: { data?: unknown }; options: { data?: unknown } } }) => {
    await waitFor(() => {
      const { assets, kinds, summary, fleet, options } = result.current; // read inside: result.current is replaced on every render
      expect([assets, kinds, summary, fleet, options].map((query) => query.data !== undefined)).toEqual(Array(5).fill(true));
    });
  };
  const everyReadTwice = (calls: { method: string; path: string }[]) =>
    [count(calls, "/api/assets"), count(calls, "/api/asset-kinds"), count(calls, "/api/assets/4/summary"), count(calls, "/api/fleet/summary"), count(calls, "/api/audit/options")];

  it("lives under the assets prefix, so every asset change refreshes the kinds and their counts", () => {
    expect(keys.assetKinds).toEqual(["assets", "kinds"]);
    expect(keys.assetKinds.slice(0, 1)).toEqual(keys.assets);
    expect(keys.summary(4).slice(0, 1)).toEqual(keys.assets);
  });

  it("reads the registry from its endpoint", async () => {
    const calls = mockFetch({ "GET /api/asset-kinds": { body: [kind()] } });
    const { result } = renderHook(() => useAssetKinds(), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.data).toEqual([kind()]));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/asset-kinds"]);
  });

  it("asks for nothing while it is not enabled (a role that may not see assets), and is not 'loading' then", async () => {
    const calls = mockFetch({ "GET /api/asset-kinds": { body: [kind()] } });
    const { result, rerender } = renderHook(({ on }) => useAssetKinds(on), { wrapper: stableWrapper(), initialProps: { on: false } });
    rerender({ on: false });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(calls).toHaveLength(0);
    rerender({ on: true });
    await waitFor(() => expect(result.current.data).toEqual([kind()]));
  });

  it.each([
    ["creating a kind", () => useCreateAssetKind(), "POST /api/asset-kinds", { name: "Rack", icon: "rack" }, 201, (m: ReturnType<typeof useCreateAssetKind>) => m.mutateAsync({ name: "Rack", icon: "rack" })],
    ["renaming or re-iconing a kind", () => usePatchAssetKind(), "PATCH /api/asset-kinds/3", { name: "Racks" }, 200, (m: ReturnType<typeof usePatchAssetKind>) => m.mutateAsync({ id: 3, body: { name: "Racks" } })],
    ["deleting a kind", () => useDeleteAssetKind(), "DELETE /api/asset-kinds/3", undefined, 204, (m: ReturnType<typeof useDeleteAssetKind>) => m.mutateAsync({ id: 3 })],
    ["adding the data-centre kinds", () => useAddStarterKinds(), "POST /api/asset-kinds/starter-pack", undefined, 200, (m: ReturnType<typeof useAddStarterKinds>) => m.mutateAsync()],
  ] as const)("refetches the assets, the kinds, a summary, the fleet and the audit options after %s", async (_name, hook, route, sent, status, run) => {
    const calls = mockFetch({ ...reads, [route]: { status, body: status === 204 ? undefined : kind() } });
    const { result } = mountReaders(hook);
    await settled(result);
    expect(everyReadTwice(calls)).toEqual([1, 1, 1, 1, 1]);
    await act(async () => { await run(result.current.mutation as never); });
    await waitFor(() => expect(everyReadTwice(calls)).toEqual([2, 2, 2, 2, 2]));
    expect(calls.find((c) => c.method !== "GET")?.body).toEqual(sent);
  });

  it("sends the id in the path and only the fields it is given", async () => {
    const calls = mockFetch({ "PATCH /api/asset-kinds/9": { body: kind({ id: 9 }) }, "DELETE /api/asset-kinds/9": { status: 204 } });
    const { result } = renderHook(() => ({ patch: usePatchAssetKind(), del: useDeleteAssetKind() }), { wrapper: stableWrapper() });
    await act(async () => { await result.current.patch.mutateAsync({ id: 9, body: { icon: "server" } }); });
    await act(async () => { await result.current.del.mutateAsync({ id: 9 }); });
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([["PATCH", "/api/asset-kinds/9", { icon: "server" }], ["DELETE", "/api/asset-kinds/9", undefined]]);
  });

  it.each([
    ["no choice: no query at all", { id: 3 }, "/api/asset-kinds/3"],
    ["a target and the count the person saw", { id: 3, moveTo: 5, expectAssets: 12 }, "/api/asset-kinds/3?move_to=5&expect_assets=12"],
    ["only a target", { id: 3, moveTo: 5 }, "/api/asset-kinds/3?move_to=5"],
    ["a count of nothing is still a count", { id: 3, moveTo: 5, expectAssets: 0 }, "/api/asset-kinds/3?move_to=5&expect_assets=0"],
  ])("deletes with %s", async (_name, variables, url) => {
    const sent: string[] = [];
    mockFetch({ "DELETE /api/asset-kinds/3": ({ url: u }) => { sent.push(u); return { status: 204 }; } });
    const { result } = renderHook(() => useDeleteAssetKind(), { wrapper: stableWrapper() });
    await act(async () => { await result.current.mutateAsync(variables); });
    expect(sent).toEqual([url]);
  });

  it("posts the starter pack with no body and hands back what the server answered", async () => {
    const answer = { added: ["UPS", "Battery"], already_there: 37 };
    const calls = mockFetch({ "POST /api/asset-kinds/starter-pack": { body: answer } });
    const { result } = renderHook(() => useAddStarterKinds(), { wrapper: stableWrapper() });
    await act(async () => { await expect(result.current.mutateAsync()).resolves.toEqual(answer); });
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([["POST", "/api/asset-kinds/starter-pack", undefined]]);
  });

  // A refused change (the count moved, the key is taken, the kind is gone) means the list on screen is out of date, as for roles.
  it.each([
    ["a delete refused because assets use the kind", "DELETE /api/asset-kinds/3", 409, { detail: "3 assets use this kind. Change their kind first.", assets: 3 }, (m: ReturnType<typeof useDeleteAssetKind>) => m.mutateAsync({ id: 3 }), "3 assets use this kind. Change their kind first."],
    ["a rename onto a taken name", "PATCH /api/asset-kinds/3", 409, { detail: 'A kind named "Racks" already exists' }, (m: ReturnType<typeof usePatchAssetKind>) => m.mutateAsync({ id: 3, body: { name: "Racks" } }), 'A kind named "Racks" already exists'],
    ["a change to a kind that is gone", "PATCH /api/asset-kinds/3", 404, { detail: "asset kind not found" }, (m: ReturnType<typeof usePatchAssetKind>) => m.mutateAsync({ id: 3, body: { icon: "pump" } }), "asset kind not found"],
    ["a starter pack the role may not add", "POST /api/asset-kinds/starter-pack", 403, { detail: "insufficient permission" }, (m: ReturnType<typeof useAddStarterKinds>) => m.mutateAsync(), "Your role does not allow this."],
  ] as const)("still refetches the kinds after %s, and the error reaches the caller", async (_name, route, status, body, run, message) => {
    const calls = mockFetch({ ...reads, [route]: { status, body } });
    const { result } = renderHook(
      () => ({ kinds: useAssetKinds(), del: useDeleteAssetKind(), patch: usePatchAssetKind(), pack: useAddStarterKinds() }),
      { wrapper: stableWrapper() },
    );
    await waitFor(() => expect(result.current.kinds.data).toBeDefined());
    const mutation = route.startsWith("DELETE") ? result.current.del : route.endsWith("starter-pack") ? result.current.pack : result.current.patch;
    await act(async () => { await expect(run(mutation as never)).rejects.toThrow(message); });
    await waitFor(() => expect(count(calls, "/api/asset-kinds")).toBe(2));
  });
});

describe("the starter pack's set", () => {
  const sentTo = async (hook: () => ReturnType<typeof useAddStarterKinds>) => {
    const urls: string[] = [];
    mockFetch({ "POST /api/asset-kinds/starter-pack": ({ url }) => { urls.push(url); return { body: { added: [], already_there: 16 } }; } });
    const { result } = renderHook(hook, { wrapper: stableWrapper() });
    await act(async () => { await result.current.mutateAsync(); });
    return urls;
  };

  it("sends no query for the common set (the server's default), explicit or not", async () => {
    expect(await sentTo(() => useAddStarterKinds())).toEqual(["/api/asset-kinds/starter-pack"]);
    expect(await sentTo(() => useAddStarterKinds("common"))).toEqual(["/api/asset-kinds/starter-pack"]);
  });

  it("asks for the whole catalogue with ?set=all", async () => {
    expect(await sentTo(() => useAddStarterKinds("all"))).toEqual(["/api/asset-kinds/starter-pack?set=all"]);
  });
});

describe("bulk delete of asset kinds", () => {
  const item = (id: number, assetCount = 0) => ({ id, name: `Kind ${id}`, assetCount });
  const UPS = { id: 90, name: "UPS" };
  const ok = { status: 204 } as const;

  /** A fake server for the deletions: `replies[id]` answers DELETE /api/asset-kinds/<id> (204 when not given); every url is recorded in order. */
  function fakeServer(replies: Record<number, { status: number; body?: unknown } | (() => { status: number; body?: unknown })> = {}) {
    const urls: string[] = [];
    const routes: Record<string, (req: { url: string }) => { status: number; body?: unknown }> = {};
    for (let id = 1; id <= 12; id += 1) {
      routes[`DELETE /api/asset-kinds/${id}`] = ({ url }) => {
        urls.push(url);
        const reply = replies[id] ?? ok;
        return typeof reply === "function" ? reply() : reply;
      };
    }
    mockFetch(routes);
    return urls;
  }
  const bulk = () => renderHook(() => useBulkDeleteAssetKinds(), { wrapper: stableWrapper() });
  const run = async (variables: Parameters<ReturnType<typeof useBulkDeleteAssetKinds>["mutateAsync"]>[0]) => {
    const { result } = bulk();
    let answer!: Awaited<ReturnType<typeof result.current.mutateAsync>>;
    await act(async () => { answer = await result.current.mutateAsync(variables); });
    return answer;
  };

  it("deletes one kind at a time, in the order given, and says what went", async () => {
    const urls = fakeServer();
    const answer = await run({ items: [item(3), item(1), item(2)], moveTo: null });
    expect(urls).toEqual(["/api/asset-kinds/3", "/api/asset-kinds/1", "/api/asset-kinds/2"]);
    expect(answer).toEqual({ deleted: [3, 1, 2], gone: [], failed: [], notTried: [], moved: null });
  });

  it("waits for each request before it sends the next", async () => {
    const order: string[] = [];
    mockFetch({
      "DELETE /api/asset-kinds/1": () => { order.push("1 sent"); return ok; },
      "DELETE /api/asset-kinds/2": () => { order.push("2 sent"); return ok; },
    });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => {
      const answer = await real(...args);
      order.push("answered");
      return answer;
    }));
    await run({ items: [item(1), item(2)], moveTo: null });
    expect(order).toEqual(["1 sent", "answered", "2 sent", "answered"]);
  });

  it.each([
    ["an unused kind goes with no query, with or without a target", [item(1, 0)], UPS, ["/api/asset-kinds/1"]],
    ["a kind in use goes with the target and the count it was shown", [item(1, 12)], UPS, ["/api/asset-kinds/1?move_to=90&expect_assets=12"]],
    ["each kind carries its own count, and only the ones in use a query", [item(1, 4), item(2, 0), item(3, 1)], UPS,
      ["/api/asset-kinds/1?move_to=90&expect_assets=4", "/api/asset-kinds/2", "/api/asset-kinds/3?move_to=90&expect_assets=1"]],
    ["a kind in use with no target goes plain (the server then refuses it)", [item(1, 3)], null, ["/api/asset-kinds/1"]],
  ])("%s", async (_name, items, moveTo, expected) => {
    const urls = fakeServer();
    await run({ items, moveTo });
    expect(urls).toEqual(expected);
  });

  it("counts the assets that moved with the kinds it deleted, and names where they went", async () => {
    fakeServer({ 2: { status: 409, body: { detail: "x", assets: 9 } } });
    const answer = await run({ items: [item(1, 4), item(2, 5), item(3, 0), item(4, 3)], moveTo: UPS });
    expect(answer.deleted).toEqual([1, 3, 4]);
    expect(answer.moved).toEqual({ assets: 7, to: "UPS" }); // 4 + 3: the refused kind's 5 did not move, the unused one had none
  });

  it("collects each refusal with its kind and goes on with the rest", async () => {
    const urls = fakeServer({ 2: { status: 500, body: { detail: "database is locked" } }, 3: { status: 400, body: { detail: "bad request" } } });
    const answer = await run({ items: [item(1), item(2), item(3), item(4)], moveTo: null });
    expect(urls).toHaveLength(4);
    expect(answer.deleted).toEqual([1, 4]);
    expect(answer.failed).toEqual([
      { id: 2, name: "Kind 2", reason: "Database is locked" },
      { id: 3, name: "Kind 3", reason: "Bad request" },
    ]);
    expect(answer.notTried).toEqual([]);
    expect(answer.stoppedBy).toBeUndefined();
  });

  it.each([
    ["one asset", { detail: "1 asset uses this kind now. Check the new count and try again.", assets: 1 }, "1 asset uses it now."],
    ["several assets", { detail: "14 assets use this kind now. Check the new count and try again.", assets: 14 }, "14 assets use it now."],
    ["assets that joined a kind that was empty", { detail: "3 assets use this kind. Change their kind first.", assets: 3 }, "3 assets use it now."],
    ["none left", { detail: "No assets use this kind now. Check the new count and try again.", assets: 0 }, "It has no assets now. Try again."],
  ])("words a 409 (the count moved) as the new count: %s", async (_name, body, reason) => {
    fakeServer({ 1: { status: 409, body } });
    const answer = await run({ items: [item(1, 2)], moveTo: UPS });
    expect(answer.failed).toEqual([{ id: 1, name: "Kind 1", reason }]);
  });

  it("falls back to the server's words for a 409 that carries no count", async () => {
    fakeServer({ 1: { status: 409, body: { detail: "a kind named x already exists" } } });
    expect((await run({ items: [item(1)], moveTo: null })).failed[0].reason).toBe("A kind named x already exists");
  });

  it("is not a failure when the server says the kind is gone: another tab deleted it", async () => {
    const urls = fakeServer({ 2: { status: 404, body: { detail: "asset kind not found" } } });
    const answer = await run({ items: [item(1), item(2, 5), item(3)], moveTo: UPS });
    expect(urls).toHaveLength(3);
    expect(answer).toEqual({ deleted: [1, 3], gone: [2], failed: [], notTried: [], moved: null }); // its 5 assets did not move here
  });

  it("rewords the 422 'That kind no longer exists.' with the name of the target the person chose", async () => {
    fakeServer({ 1: { status: 422, body: { detail: "That kind no longer exists." } }, 2: { status: 422, body: { detail: "That kind no longer exists." } } });
    const answer = await run({ items: [item(1, 2), item(2, 3), item(3, 0)], moveTo: UPS });
    expect(answer.deleted).toEqual([3]); // an unused kind needs no target
    expect(answer.failed.map((f) => f.reason)).toEqual(Array(2).fill('The kind chosen for their assets ("UPS") no longer exists.'));
  });

  it("shows any other 422 in the server's words with a capital", async () => {
    fakeServer({ 1: { status: 422, body: { detail: "pick another kind to move the assets to." } } });
    expect((await run({ items: [item(1, 2)], moveTo: UPS })).failed[0].reason).toBe("Pick another kind to move the assets to.");
  });

  // Each of these would answer the same to every later request, and a 401 or a 403 also makes the app check the account again each time.
  it.each([
    [401, "Your session has ended. Sign in again."],
    [403, "Your role does not allow this."],
    [502, "The server is not answering (status 502). It may be restarting; try again in a moment."],
    [503, "The server is not answering (status 503). It may be restarting; try again in a moment."],
    [504, "The server is not answering (status 504). It may be restarting; try again in a moment."],
  ])("stops at the first %i and leaves the rest untried", async (status, reason) => {
    const urls = fakeServer({ 3: { status, body: status === 403 ? { detail: "insufficient permission" } : { detail: "x" } } });
    const answer = await run({ items: [item(1), item(2), item(3), item(4), item(5)], moveTo: null });
    expect(urls).toHaveLength(3); // nothing was sent after the one that met the problem
    expect(answer.deleted).toEqual([1, 2]);
    expect(answer.notTried).toEqual([3, 4, 5]); // the kind whose request met it was not deleted either, and it did not fail by its own fault
    expect(answer.failed).toEqual([]);
    expect(answer.stoppedBy).toBe(reason);
  });

  it("stops when the network is gone (status 0)", async () => {
    let sent = 0;
    mockFetch({ "DELETE /api/asset-kinds/1": ok });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => {
      sent += 1;
      if (sent === 2) throw new TypeError("Failed to fetch");
      return real(...args);
    }));
    const answer = await run({ items: [item(1), item(1), item(1)], moveTo: null });
    expect(sent).toBe(2);
    expect(answer.deleted).toEqual([1]);
    expect(answer.notTried).toEqual([1, 1]);
    expect(answer.stoppedBy).toBe("Can't reach the server. Check the network and try again.");
  });

  it("keeps what failed before the stop as failed", async () => {
    fakeServer({ 1: { status: 500, body: { detail: "boom" } }, 2: { status: 503, body: "<html>" } });
    const answer = await run({ items: [item(1), item(2), item(3)], moveTo: null });
    expect(answer.failed.map((f) => f.id)).toEqual([1]);
    expect(answer.notTried).toEqual([2, 3]);
    expect(answer.deleted).toEqual([]);
  });

  it("resolves even when every deletion failed: the caller reads the answer", async () => {
    fakeServer({ 1: { status: 500, body: { detail: "boom" } }, 2: { status: 500, body: { detail: "boom" } } });
    const answer = await run({ items: [item(1), item(2)], moveTo: null });
    expect(answer.failed).toHaveLength(2);
  });

  describe("refetching", () => {
    const AUDIT = { actions: [], users: [], unattributed: false };
    /** What a kind change makes stale, each read through a hook that is on screen, plus a client whose `invalidateQueries` can be read. */
    function mountReaders(kinds: () => unknown[]) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidated = vi.spyOn(client, "invalidateQueries");
      const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
      const reads = {
        "GET /api/assets": () => ({ body: [] }),
        "GET /api/asset-kinds": () => ({ body: kinds() }),
        "GET /api/fleet/summary": () => ({ body: {} }),
        "GET /api/audit/options": () => ({ body: AUDIT }),
      };
      return { client, invalidated, wrapper, reads };
    }
    const reads = (calls: { method: string; path: string }[]) =>
      ["/api/assets", "/api/asset-kinds", "/api/fleet/summary", "/api/audit/options"].map((path) => calls.filter((c) => c.method === "GET" && c.path === path).length);

    it("refetches the assets, the kinds, the fleet and the audit log ONCE for the whole batch, not once per kind", async () => {
      let rows = [1, 2, 3, 4].map((id) => ({ id }));
      const { client, invalidated, wrapper, reads: readRoutes } = mountReaders(() => rows);
      const deletes = Object.fromEntries([1, 2, 3, 4].map((id) => [`DELETE /api/asset-kinds/${id}`, () => { rows = rows.filter((r) => r.id !== id); return ok; }]));
      const calls = mockFetch({ ...readRoutes, ...deletes });
      const { result } = renderHook(() => ({ assets: useAssets(), kinds: useAssetKinds(), fleet: useFleetSummary(), options: useAuditOptions(), bulk: useBulkDeleteAssetKinds() }), { wrapper });
      await waitFor(() => expect(result.current.options.data).toBeDefined());
      await waitFor(() => expect(reads(calls)).toEqual([1, 1, 1, 1]));
      invalidated.mockClear();
      await act(async () => { await result.current.bulk.mutateAsync({ items: [item(1), item(2), item(3), item(4)], moveTo: null }); });
      expect(invalidated.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([keys.assets, keys.fleet, keys.auditAll]);
      expect(reads(calls)).toEqual([2, 2, 2, 2]);
      // The refetch is awaited inside the mutation: the cache already holds the new list when mutateAsync resolves (the screen follows on its next render).
      expect(client.getQueryData(keys.assetKinds)).toEqual([]);
    });

    it("refetches after a batch that was refused as well: the list on screen is out of date", async () => {
      const { invalidated, wrapper, reads: readRoutes } = mountReaders(() => []);
      const calls = mockFetch({ ...readRoutes, "DELETE /api/asset-kinds/1": () => ({ status: 500, body: { detail: "boom" } }), "DELETE /api/asset-kinds/2": () => ({ status: 503, body: "x" }) });
      const { result } = renderHook(() => ({ kinds: useAssetKinds(), bulk: useBulkDeleteAssetKinds() }), { wrapper });
      await waitFor(() => expect(result.current.kinds.data).toBeDefined());
      invalidated.mockClear();
      await act(async () => { await result.current.bulk.mutateAsync({ items: [item(1), item(2)], moveTo: null }); });
      expect(invalidated.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([keys.assets, keys.fleet, keys.auditAll]);
      expect(calls.filter((c) => c.method === "GET" && c.path === "/api/asset-kinds")).toHaveLength(2);
    });
  });
});

describe("asset move queries", () => {
  const answer = { request_id: "r-1", assets: 2, unchanged: [], moved: [], undo: { moves: [], expect: { assets: 2, parents: {} } } };
  const body: MoveBody = { moves: [{ ids: [3], parent_id: 5, before_id: null }], expect: { assets: 2, parents: { "3": 2 }, rate_changes: false } };
  /** The seven things a move makes stale, in the order the hook names them. */
  const AFTER_A_MOVE = [keys.assets, keys.fleet, keys.billing, keys.widgetData, keys.tariffs, keys.auditAll, keys.graph];

  /** A client of the test's own, so the calls to `invalidateQueries` can be read. */
  function mounted() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidated = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    return { invalidated, wrapper, keysInvalidated: () => invalidated.mock.calls.map(([filters]) => filters?.queryKey) };
  }

  it("posts the body to the move route and hands back the answer", async () => {
    const calls = mockFetch({ "POST /api/assets/move": { body: answer } });
    const { wrapper } = mounted();
    const { result } = renderHook(() => useMoveAssets(), { wrapper });
    await act(async () => { await expect(result.current.mutateAsync(body)).resolves.toEqual(answer); });
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([["POST", "/api/assets/move", body]]);
  });

  it("sends an undo as the same route with undo_of", async () => {
    const calls = mockFetch({ "POST /api/assets/move": { body: answer } });
    const { wrapper } = mounted();
    const { result } = renderHook(() => useMoveAssets(), { wrapper });
    const undo: MoveBody = { moves: [{ ids: [3], parent_id: 2, before_id: 4 }], expect: { assets: 2, parents: { "3": 5 } }, undo_of: "r-1" };
    await act(async () => { await result.current.mutateAsync(undo); });
    expect(calls[0].body).toEqual(undo);
  });

  it("refetches the assets, fleet, billing, widget data, tariffs, audit log and graph after a move", async () => {
    mockFetch({ "POST /api/assets/move": { body: answer } });
    const { wrapper, keysInvalidated } = mounted();
    const { result } = renderHook(() => useMoveAssets(), { wrapper });
    await act(async () => { await result.current.mutateAsync(body); });
    expect(keysInvalidated()).toEqual(AFTER_A_MOVE);
  });

  // A refused move (a rule said no, or someone moved something first) means the tree on screen is out of date, as for kinds and roles.
  it.each([
    ["a rule refusal (422)", 422, { detail: 'Row A would have two assets named "Pump 3".', refusals: [{ id: 3, name: "Pump 3", reason: 'Row A would have two assets named "Pump 3".', code: "name_clash" }] }],
    ["a stale request (409)", 409, { detail: "an asset was deleted", stale: true }],
    ["a place that is gone (404)", 404, { detail: "not found" }],
  ])("still refetches all of them after %s", async (_name, status, reply) => {
    mockFetch({ "POST /api/assets/move": { status, body: reply } });
    const { wrapper, keysInvalidated } = mounted();
    const { result } = renderHook(() => useMoveAssets(), { wrapper });
    await act(async () => { await expect(result.current.mutateAsync(body)).rejects.toBeInstanceOf(ApiError); });
    expect(keysInvalidated()).toEqual(AFTER_A_MOVE);
  });

  it("keeps the status and the parsed body of a 422, so the refusals can be read", async () => {
    const refusal = { id: 3, name: "Pump 3", reason: 'Row A would have two assets named "Pump 3".', code: "name_clash" };
    mockFetch({ "POST /api/assets/move": { status: 422, body: { detail: refusal.reason, refusals: [refusal] } } });
    const { wrapper } = mounted();
    const { result } = renderHook(() => useMoveAssets(), { wrapper });
    let caught: unknown;
    await act(async () => { await result.current.mutateAsync(body).catch((error) => { caught = error; }); });
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(422);
    expect((caught as ApiError).message).toBe(refusal.reason);
    expect(moveRefusals(caught)).toEqual([refusal]);
    expect(isStaleMove(caught)).toBe(false);
  });

  it("tells a 409 stale from a 422, by the status and the stale flag in the body", async () => {
    mockFetch({ "POST /api/assets/move": { status: 409, body: { detail: "a rate changed since you looked", stale: true } } });
    const { wrapper } = mounted();
    const { result } = renderHook(() => useMoveAssets(), { wrapper });
    let caught: unknown;
    await act(async () => { await result.current.mutateAsync(body).catch((error) => { caught = error; }); });
    expect((caught as ApiError).status).toBe(409);
    expect((caught as ApiError).body).toEqual({ detail: "a rate changed since you looked", stale: true });
    expect(isStaleMove(caught)).toBe(true);
    expect(moveRefusals(caught)).toBeNull();
  });

  // The keys are the real ones: readers of the lists a move makes stale ask again, after a move and after a refused move.
  it.each([
    ["a move", 200, answer],
    ["a refused move", 422, { detail: "no", refusals: [] }],
  ])("makes real readers of the lists fetch again after %s", async (_name, status, reply) => {
    const calls = mockFetch({
      "GET /api/assets": { body: [] }, "GET /api/fleet/summary": { body: {} }, "GET /api/tariffs": { body: [] }, "GET /api/discovery/graph": { body: {} },
      "GET /api/audit/options": { body: { actions: [], users: [], unattributed: false } }, "GET /api/billing/costs": { body: {} },
      "POST /api/assets/move": { status, body: reply },
    });
    const { wrapper } = mounted();
    const { result } = renderHook(
      () => ({ assets: useAssets(), fleet: useFleetSummary(), tariffs: useTariffs(), graph: useGraph(), options: useAuditOptions(), costs: useBillingCosts("2026-10"), move: useMoveAssets() }),
      { wrapper },
    );
    const reads = () => ["/api/assets", "/api/fleet/summary", "/api/tariffs", "/api/discovery/graph", "/api/audit/options", "/api/billing/costs"]
      .map((path) => calls.filter((c) => c.method === "GET" && c.path === path).length);
    await waitFor(() => expect(reads()).toEqual([1, 1, 1, 1, 1, 1]));
    await act(async () => { await result.current.move.mutateAsync(body).catch(() => undefined); });
    await waitFor(() => expect(reads()).toEqual([2, 2, 2, 2, 2, 2]));
  });

  it("asks the preview route with the same body and writes nothing: no invalidation, no mutation", async () => {
    const plan = {
      assets: 2, unchanged: [], currency: "USD", rate_changes: true, roots: [],
      expect: { assets: 2, parents: { "3": 2 }, rate_changes: true },
    };
    const calls = mockFetch({ "POST /api/assets/move-preview": { body: plan } });
    const { invalidated } = mounted();
    await expect(loadMovePreview(body)).resolves.toEqual(plan);
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([["POST", "/api/assets/move-preview", body]]);
    expect(invalidated).not.toHaveBeenCalled();
  });

  it("lets a refused preview through with its refusals", async () => {
    mockFetch({ "POST /api/assets/move-preview": { status: 422, body: { detail: "x", refusals: [{ id: 3, name: "Pump 3", reason: "x", code: "cycle" }] } } });
    const error = await loadMovePreview(body).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(moveRefusals(error)).toEqual([{ id: 3, name: "Pump 3", reason: "x", code: "cycle" }]);
  });
});

describe("removing discovered sources (W7r)", () => {
  const answer = { removed: [{ id: 3, name: "Plant OPC" }], skipped: [{ id: 4, name: "Lab", reason: "mapped" as const }] };

  /** A client of the test's own, so the calls to `invalidateQueries` can be read. */
  function mounted() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidated = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    return { client, wrapper, keysInvalidated: () => invalidated.mock.calls.map(([filters]) => filters?.queryKey) };
  }

  it("posts the listed ids to the remove route and hands back what was removed and what was kept", async () => {
    const calls = mockFetch({ "POST /api/discovery/sources/remove": { body: answer } });
    const { wrapper } = mounted();
    const { result } = renderHook(() => useRemoveDiscoveredSources(), { wrapper });
    await act(async () => { await expect(result.current.mutateAsync([3, 4])).resolves.toEqual(answer); });
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([["POST", "/api/discovery/sources/remove", { source_ids: [3, 4] }]]);
  });

  it("sends a list longer than the route's 500 in calls of 500, in order, and joins the answers (one refetch)", async () => {
    const calls = mockFetch({
      "POST /api/discovery/sources/remove": ({ body }) => {
        const ids = (body as { source_ids: number[] }).source_ids;
        return { body: { removed: ids.map((id) => ({ id, name: `s${id}` })), skipped: [] } };
      },
    });
    const { wrapper, keysInvalidated } = mounted();
    const { result } = renderHook(() => useRemoveDiscoveredSources(), { wrapper });
    const ids = Array.from({ length: 1201 }, (_, i) => i + 1);
    let joined: { removed: { id: number }[]; skipped: unknown[] } | undefined;
    await act(async () => { joined = await result.current.mutateAsync(ids); });
    const sent = calls.map((c) => (c.body as { source_ids: number[] }).source_ids);
    expect(sent.map((part) => part.length)).toEqual([500, 500, 201]);
    expect(sent.flat()).toEqual(ids);
    expect(joined?.removed.map((r) => r.id)).toEqual(ids);
    expect(keysInvalidated()).toEqual([keys.graph, keys.sources, keys.auditAll]);
  });

  it("refetches the graph, the sources and the audit log once each", async () => {
    mockFetch({ "POST /api/discovery/sources/remove": { body: answer } });
    const { wrapper, keysInvalidated } = mounted();
    const { result } = renderHook(() => useRemoveDiscoveredSources(), { wrapper });
    await act(async () => { await result.current.mutateAsync([3, 4]); });
    expect(keysInvalidated()).toEqual([keys.graph, keys.sources, keys.auditAll]);
  });

  it("still refetches after a refusal (a running scan, 409), and the error keeps the server's words", async () => {
    mockFetch({ "POST /api/discovery/sources/remove": { status: 409, body: { detail: "A scan is running. Remove discovered sources when it has finished." } } });
    const { wrapper, keysInvalidated } = mounted();
    const { result } = renderHook(() => useRemoveDiscoveredSources(), { wrapper });
    let caught: unknown;
    await act(async () => { await result.current.mutateAsync([3]).catch((error) => { caught = error; }); });
    expect((caught as ApiError).message).toBe("A scan is running. Remove discovered sources when it has finished.");
    expect(keysInvalidated()).toEqual([keys.graph, keys.sources, keys.auditAll]);
  });

  it("resolves only after the lists are fetched again, so the removed nodes are gone when the caller goes on", async () => {
    let sources = [{ id: 3 }];
    mockFetch({
      "GET /api/discovery/graph": () => ({ body: { sources, unidentified: [], assets: [], layout: {} } }),
      "POST /api/discovery/sources/remove": () => { sources = []; return { body: { removed: [{ id: 3, name: "Plant OPC" }], skipped: [] } }; },
    });
    const { client, wrapper } = mounted();
    const { result } = renderHook(() => ({ graph: useGraph(), remove: useRemoveDiscoveredSources() }), { wrapper });
    await waitFor(() => expect(result.current.graph.data?.sources).toHaveLength(1));
    await act(async () => { await result.current.remove.mutateAsync([3]); });
    // Read from the cache at the moment the call resolved: the refetch had already landed.
    expect((client.getQueryData(keys.graph) as { sources: unknown[] }).sources).toEqual([]);
  });
});

describe("tidying the layout (W7t)", () => {
  function mounted() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidated = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    return { client, wrapper, keysInvalidated: () => invalidated.mock.calls.map(([filters]) => filters?.queryKey) };
  }
  const graphWith = (layout: object) => ({ body: { sources: [], unidentified: [], assets: [], layout } });

  it("sends DELETE to the layout route and refetches only the graph", async () => {
    const calls = mockFetch({ "DELETE /api/discovery/layout": { status: 204 } });
    const { wrapper, keysInvalidated } = mounted();
    const { result } = renderHook(() => useTidyLayout(), { wrapper });
    await act(async () => { await result.current.mutateAsync(); });
    expect(calls.map((c) => [c.method, c.path])).toEqual([["DELETE", "/api/discovery/layout"]]);
    expect(keysInvalidated()).toEqual([keys.graph]);
  });

  it("calls onDeleted once the route has answered and BEFORE the graph is read again, and the call resolves after the read", async () => {
    let layout: object = { "src:1": { x: 5, y: 5 } };
    const order: string[] = [];
    const calls = mockFetch({
      "GET /api/discovery/graph": () => { order.push("read"); return graphWith(layout); },
      "DELETE /api/discovery/layout": () => { layout = {}; order.push("deleted"); return { status: 204 }; },
    });
    const { client, wrapper } = mounted();
    const { result } = renderHook(() => ({ graph: useGraph(), tidy: useTidyLayout({ onDeleted: () => order.push("callback") }) }), { wrapper });
    await waitFor(() => expect(result.current.graph.data?.layout).toEqual({ "src:1": { x: 5, y: 5 } }));
    order.length = 0;
    await act(async () => { await result.current.tidy.mutateAsync(); });
    expect(order).toEqual(["deleted", "callback", "read"]);
    expect((client.getQueryData(keys.graph) as { layout: object }).layout).toEqual({}); // the refetch had already landed
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("a refusal does not call onDeleted, still reads the graph again, and the error keeps the server's words", async () => {
    const onDeleted = vi.fn();
    mockFetch({ "DELETE /api/discovery/layout": { status: 403, body: { detail: "You may not change the layout." } } });
    const { wrapper, keysInvalidated } = mounted();
    const { result } = renderHook(() => useTidyLayout({ onDeleted }), { wrapper });
    let caught: unknown;
    await act(async () => { await result.current.mutateAsync().catch((error) => { caught = error; }); });
    expect((caught as ApiError).message).toBe("You may not change the layout.");
    expect(onDeleted).not.toHaveBeenCalled();
    expect(keysInvalidated()).toEqual([keys.graph]);
  });
});

/** The smallest month check answer: no findings. */
const monthCheckBody = {
  month: "2026-09", timezone: "UTC", state: "finished", closed: false, from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z", month_end: "2026-10-01T00:00:00Z",
  hours: 720, meters: 1, meter_hours: 720, things: 0, limits: { flat_hours: 24, short_minutes: 60, short_share: 0.01, max_tolerated_hours: 24, cap: 50 },
  groups: Object.fromEntries(["silent", "gaps", "estimated", "resets", "started", "unpriced", "flat", "unmetered", "later"].map((name) => [name, { total: 0, items: [] }])),
};

describe("the month check query (w21)", () => {
  it("asks for the month it is given, stays idle without one and has its own key under the billing prefix", async () => {
    let url = "";
    mockFetch({ "GET /api/billing/month-check": (req) => { url = req.url; return { body: monthCheckBody }; } });
    const { result, rerender } = renderHook(({ month }: { month: string | null }) => useBillingMonthCheck(month), {
      wrapper: stableWrapper(), initialProps: { month: null as string | null },
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(url).toBe("");
    rerender({ month: "2026-09" });
    await waitFor(() => expect(result.current.data?.month).toBe("2026-09"));
    expect(new URL(url, "http://x").searchParams.get("month")).toBe("2026-09");
    expect(keys.billingMonthCheck("2026-09")).toEqual(["billing", "month-check", "2026-09"]);
    expect(keys.billingMonthCheckAll).toEqual(["billing", "month-check"]);
    expect(keys.billingCostsAll).toEqual(["billing", "costs"]);
    expect(keys.billingMonthCheck("2026-09").slice(0, 1)).toEqual(keys.billing); // so every `keys.billing` invalidation reaches it
  });

  it("is kept for five minutes, and re-read on a timer only through monthCheckRefetchMs (an open month)", async () => {
    const calls = mockFetch({ "GET /api/billing/month-check": { body: monthCheckBody } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const shared = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const first = renderHook(() => useBillingMonthCheck("2026-09"), { wrapper: shared });
    await waitFor(() => expect(first.result.current.data?.month).toBe("2026-09"));
    const options = client.getQueryCache().find({ queryKey: keys.billingMonthCheck("2026-09") })?.observers[0].options;
    expect(options?.staleTime).toBe(5 * 60_000);
    expect(typeof options?.refetchInterval).toBe("function"); // the interval follows the answer it holds
    const query = client.getQueryCache().find({ queryKey: keys.billingMonthCheck("2026-09") })!;
    expect((options!.refetchInterval as (q: typeof query) => unknown)(query)).toBe(false); // this answer is a finished month: no timer
    const second = renderHook(() => useBillingMonthCheck("2026-09"), { wrapper: shared }); // the drawer reading the same cache
    expect(second.result.current.data?.month).toBe("2026-09");
    expect(calls.filter((c) => c.path === "/api/billing/month-check")).toHaveLength(1);
  });
});

describe("monthCheckRefetchMs (w21 review M8): an open month's count follows the table, nothing else polls", () => {
  const answer = (state: "open" | "finished" | "not_begun") => ({ ...monthCheckBody, state }) as unknown as Parameters<typeof monthCheckRefetchMs>[0];

  it("is a quarter of an hour for an open month", () => {
    expect(monthCheckRefetchMs(answer("open"))).toBe(15 * 60_000);
  });

  it.each([["a finished month", answer("finished")], ["a month that has not begun", answer("not_begun")], ["no answer yet", undefined]])("is false for %s", (_name, data) => {
    expect(monthCheckRefetchMs(data)).toBe(false);
  });
});

describe("closing and reopening a billing month (W11)", () => {
  const closedBody = { month: "2026-09", timezone: "UTC", currency: null, days: [], assets: [], closed: null };

  it.each([
    ["a close", "close", useCloseBillingMonth, 201, { closed: { id: 1 } }],
    ["a reopen", "reopen", useReopenBillingMonth, 200, { month: "2026-09", reopened_at: "2026-10-15T10:00:00Z" }],
    ["a refused close", "close", useCloseBillingMonth, 409, { detail: "that month is already closed" }],
    ["a refused reopen", "reopen", useReopenBillingMonth, 409, { detail: "that month is not closed" }],
  ] as const)("posts the note to the month's route, and after %s the costs, the months list, the audit log and the month check are read again", async (_name, action, hook, status, reply) => {
    const calls = mockFetch({
      "GET /api/billing/costs": { body: closedBody },
      "GET /api/billing/months": { body: { first_month: "2026-09" } },
      "GET /api/billing/month-check": { body: monthCheckBody },
      "GET /api/audit/options": { body: { actions: [], users: [], unattributed: false } },
      [`POST /api/billing/months/2026-09/${action}`]: { status, body: reply },
    });
    const { result } = renderHook(
      () => ({ costs: useBillingCosts("2026-09"), months: useBillingMonths(), check: useBillingMonthCheck("2026-09"), options: useAuditOptions(), write: hook() }),
      { wrapper: stableWrapper() },
    );
    const reads = () => ["/api/billing/costs", "/api/billing/months", "/api/billing/month-check", "/api/audit/options"].map((path) => calls.filter((c) => c.method === "GET" && c.path === path).length);
    await waitFor(() => expect(reads()).toEqual([1, 1, 1, 1]));
    await act(async () => { await result.current.write.mutateAsync({ month: "2026-09", note: "  a reason " }).catch(() => undefined); });
    expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([[`/api/billing/months/2026-09/${action}`, { note: "  a reason " }]]);
    await waitFor(() => expect(reads()).toEqual([2, 2, 2, 2])); // onSettled, not onSuccess: a refusal means the page on screen is out of date
  });

  // The month check is a big read (every meter of the site). The dialog that does the close must not sit and wait for it: the costs and the months
  // list are what the page needs to show the new state, the check follows by itself.
  it.each([
    ["close", useCloseBillingMonth, 201, {}],
    ["reopen", useReopenBillingMonth, 200, { month: "2026-09", reopened_at: "2026-10-15T10:00:00Z" }],
  ] as const)("a %s resolves once the costs are read again, even when the month check never answers", async (action, hook, status, reply) => {
    let costsAnswered = 0;
    const calls = mockFetch({
      "GET /api/billing/costs": () => { costsAnswered += 1; return { body: closedBody }; },
      "GET /api/billing/months": { body: { first_month: "2026-09" } },
      "GET /api/billing/month-check": { body: monthCheckBody },
      "GET /api/audit/options": { body: { actions: [], users: [], unattributed: false } },
      [`POST /api/billing/months/2026-09/${action}`]: { status, body: reply },
    });
    const { result } = renderHook(
      () => ({ costs: useBillingCosts("2026-09"), months: useBillingMonths(), check: useBillingMonthCheck("2026-09"), options: useAuditOptions(), write: hook() }),
      { wrapper: stableWrapper() },
    );
    await waitFor(() => expect(result.current.check.data?.month).toBe("2026-09"));
    const checkReads = () => calls.filter((c) => c.method === "GET" && c.path === "/api/billing/month-check").length;
    expect(checkReads()).toBe(1);
    let asked = 0;
    const held = holdFetch((method, path) => method === "GET" && path === "/api/billing/month-check" && ++asked > 0); // every further read of the check hangs
    await act(async () => { await result.current.write.mutateAsync({ month: "2026-09", note: "" }); });
    expect(costsAnswered).toBe(2);
    await waitFor(() => expect(asked).toBe(1)); // the check was asked for again ...
    expect(result.current.check.isFetching).toBe(true); // ... and is still waiting, yet the close has already resolved
    held.release();
    await waitFor(() => expect(result.current.check.isFetching).toBe(false));
  });

  it("only the close and the reopen let go of the month check lazily: a tariff write still reads it again through the billing prefix", async () => {
    const calls = mockFetch({
      "GET /api/billing/month-check": { body: monthCheckBody },
      "POST /api/tariffs": { status: 201, body: { id: 1 } },
    });
    const { result } = renderHook(() => ({ check: useBillingMonthCheck("2026-09"), create: useCreateTariff() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.check.data?.month).toBe("2026-09"));
    await act(async () => { await result.current.create.mutateAsync({ asset_id: null, rate_per_kwh: 0.1, effective_from: "2026-09-01" }); });
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/billing/month-check")).toHaveLength(2));
  });

  it("resolves only after the month has been read again, so a dialog that closes then finds the page in its new state", async () => {
    let costsAnswered = 0;
    mockFetch({
      "GET /api/billing/costs": () => { costsAnswered += 1; return { body: closedBody }; },
      "POST /api/billing/months/2026-09/close": { status: 201, body: {} },
    });
    const { result } = renderHook(() => ({ costs: useBillingCosts("2026-09"), close: useCloseBillingMonth() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(costsAnswered).toBe(1));
    await act(async () => { await result.current.close.mutateAsync({ month: "2026-09", note: "" }); });
    expect(costsAnswered).toBe(2);
  });
});
