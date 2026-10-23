import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { mockFetch } from "../test/fetchMock";
import { ApiError } from "./client";
import { keys, useSaveWatchdogSettings, useSources, useStatus, useWatchdogSettings } from "./queries";
import type { WatchdogSettings } from "./types";

function stableWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const settings = (stale_floor_minutes: number, not_advancing_hours = 6): WatchdogSettings => ({
  stale_floor_minutes, not_advancing_hours, factory: { stale_floor_minutes: 5, not_advancing_hours: 6 },
  bounds: { stale_floor_minutes: [2, 60], not_advancing_hours: [1, 72] },
});
const watching = (calls: { method: string; path: string; body: unknown }[], method: string, path: string) => calls.filter((call) => call.method === method && call.path === path);

describe("the data watchdog setting (w35)", () => {
  it("keeps the setting under 'settings', with the other settings, and apart from the events reads", () => {
    expect(keys.watchdogSettings).toEqual(["settings", "watchdog"]);
    expect(keys.watchdogSettings).not.toEqual(keys.eventsSettings);
  });

  it("reads the setting, and not when it is not enabled", async () => {
    const calls = mockFetch({ "GET /api/settings/watchdog": { body: settings(5) } });
    const off = renderHook(() => useWatchdogSettings(false), { wrapper: stableWrapper() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(0);
    off.unmount();
    const { result } = renderHook(() => useWatchdogSettings(), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.data?.stale_floor_minutes).toBe(5));
    expect(result.current.data?.bounds.not_advancing_hours).toEqual([1, 72]);
  });

  it("saves the two numbers, then reads the setting, the status, the sources and the audit log again", async () => {
    let minutes = 5;
    const calls = mockFetch({
      "GET /api/settings/watchdog": () => ({ body: settings(minutes) }),
      "GET /api/status": { body: { collector_alive: true, readings_fresh: true, last_reading_age_seconds: 4 } },
      "GET /api/sources": { body: [] },
      "GET /api/audit": { body: { total: 0, offset: 0, limit: 50, items: [] } },
      "PUT /api/settings/watchdog": ({ body }) => { minutes = (body as { stale_floor_minutes: number }).stale_floor_minutes; return { body: settings(minutes) }; },
    });
    const { result } = renderHook(
      () => ({ setting: useWatchdogSettings(), status: useStatus(), sources: useSources(), save: useSaveWatchdogSettings() }),
      { wrapper: stableWrapper() },
    );
    await waitFor(() => expect(result.current.setting.data?.stale_floor_minutes).toBe(5));
    await waitFor(() => expect(result.current.status.data).toBeDefined());
    await waitFor(() => expect(result.current.sources.data).toBeDefined());
    await act(async () => { await result.current.save.mutateAsync({ stale_floor_minutes: 10, not_advancing_hours: 6 }); });
    await waitFor(() => expect(result.current.setting.data?.stale_floor_minutes).toBe(10));
    expect(watching(calls, "PUT", "/api/settings/watchdog")[0].body).toEqual({ stale_floor_minutes: 10, not_advancing_hours: 6 });
    await waitFor(() => expect(watching(calls, "GET", "/api/status")).toHaveLength(2));
    await waitFor(() => expect(watching(calls, "GET", "/api/sources")).toHaveLength(2));
    expect(watching(calls, "GET", "/api/settings/watchdog")).toHaveLength(2);
  });

  it("reads the same things again when the server refuses (422), because it settles and does not only succeed", async () => {
    const calls = mockFetch({
      "GET /api/settings/watchdog": { body: settings(5) },
      "GET /api/status": { body: { collector_alive: true, readings_fresh: true, last_reading_age_seconds: 4 } },
      "GET /api/sources": { body: [] },
      "PUT /api/settings/watchdog": { status: 422, body: { detail: [{ loc: ["body", "stale_floor_minutes"], msg: "Input should be greater than or equal to 2" }] } },
    });
    const { result } = renderHook(
      () => ({ setting: useWatchdogSettings(), status: useStatus(), sources: useSources(), save: useSaveWatchdogSettings() }),
      { wrapper: stableWrapper() },
    );
    await waitFor(() => expect(result.current.setting.data).toBeDefined());
    await waitFor(() => expect(result.current.status.data).toBeDefined());
    await waitFor(() => expect(result.current.sources.data).toBeDefined());
    let caught: unknown;
    await act(async () => {
      try { await result.current.save.mutateAsync({ stale_floor_minutes: 1, not_advancing_hours: 6 }); } catch (e) { caught = e; }
    });
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(422);
    expect((caught as ApiError).message).toBe("stale_floor_minutes: Input should be greater than or equal to 2");
    await waitFor(() => expect(watching(calls, "GET", "/api/settings/watchdog")).toHaveLength(2));
    await waitFor(() => expect(watching(calls, "GET", "/api/status")).toHaveLength(2));
    await waitFor(() => expect(watching(calls, "GET", "/api/sources")).toHaveLength(2));
  });
});

describe("the status and sources reads keep the watchdog fields (w35)", () => {
  it("hands on the optional meter fields of /api/status as they came, and an older answer without them as it came", async () => {
    const newer = { collector_alive: true, readings_fresh: true, last_reading_age_seconds: 4, meters: 48, meters_stale: 3, meters_not_advancing: 2, meters_waiting: 1, oldest_stale_age_seconds: 7260, rollups_late: false };
    mockFetch({ "GET /api/status": { body: newer } });
    const first = renderHook(() => useStatus(), { wrapper: stableWrapper() });
    await waitFor(() => expect(first.result.current.data).toEqual(newer));
    first.unmount();
    const older = { collector_alive: true, readings_fresh: false, last_reading_age_seconds: 300 };
    mockFetch({ "GET /api/status": { body: older } });
    const second = renderHook(() => useStatus(), { wrapper: stableWrapper() });
    await waitFor(() => expect(second.result.current.data).toEqual(older));
  });
});
