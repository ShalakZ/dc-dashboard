import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { mockFetch } from "../test/fetchMock";
import { useMappingLatest, type MappingLatest } from "./useMappingLatest";

const ANSWER: MappingLatest = { mapping_id: 7, value: 12.4, unit: "kW", ts: "2026-10-17T10:00:00Z", quality: 0, age_seconds: 3, stale: false };

function setup(id: number | null) {
  // The app's own client retries nothing in tests; the hook must not retry on its own either, so the default (3 retries) is left in place here.
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(({ mappingId }: { mappingId: number | null }) => useMappingLatest(mappingId), { wrapper, initialProps: { mappingId: id } });
}

describe("useMappingLatest", () => {
  it("asks nothing for a null id", async () => {
    const calls = mockFetch({});
    const { result } = setup(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("reads the mapping's latest value once", async () => {
    const calls = mockFetch({ "GET /api/mappings/7/latest": { body: ANSWER } });
    const { result } = setup(7);
    await waitFor(() => expect(result.current.data).toEqual(ANSWER));
    expect(calls.map((c) => c.path)).toEqual(["/api/mappings/7/latest"]);
  });

  it("does not retry a failing read: the error is there after one request", async () => {
    const calls = mockFetch({ "GET /api/mappings/7/latest": { status: 500, body: { detail: "boom" } } });
    const { result } = setup(7);
    await waitFor(() => expect(result.current.isError).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(1);
  });

  it("follows the id: another mapping is another read, and the old answer is not shown for it", async () => {
    const calls = mockFetch({
      "GET /api/mappings/7/latest": { body: ANSWER },
      "GET /api/mappings/8/latest": { body: { ...ANSWER, mapping_id: 8, value: 99 } },
    });
    const { result, rerender } = setup(7);
    await waitFor(() => expect(result.current.data?.mapping_id).toBe(7));
    rerender({ mappingId: 8 });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.value).toBe(99));
    expect(calls.map((c) => c.path)).toEqual(["/api/mappings/7/latest", "/api/mappings/8/latest"]);
  });
});
