import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { mockFetch } from "../test/fetchMock";
import { useAudit, useGraph, usePatchUser, useScan, useUsers } from "./queries";

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

describe("discovery queries", () => {
  it("passes the page window to the audit endpoint", async () => {
    let url = "";
    mockFetch({ "GET /api/audit": (req) => { url = req.url; return { body: { total: 0, items: [] } }; } });
    const { result } = renderHook(() => useAudit(50, 100), { wrapper });
    await waitFor(() => expect(result.current.data?.total).toBe(0));
    expect(new URL(url, "http://x").searchParams.toString()).toBe("limit=50&offset=100");
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
