import { act, renderHook } from "@testing-library/react";
import { api } from "../api/client";
import { mockFetch } from "../test/fetchMock";
import { noteReach, resetServerReach, useServerDown } from "./serverReach";

/** Forgets the count while a component listens: the change of state is announced inside act. */
const reset = () => act(() => resetServerReach());
const fail = (path = "/api/status") => api.get(path).catch(() => undefined);

describe("serverReach", () => {
  beforeEach(() => resetServerReach());
  afterEach(() => {
    reset();
    vi.unstubAllGlobals();
  });

  it("one failed answer is not down, two in a row are, and one answer that came clears it", () => {
    const { result } = renderHook(() => useServerDown());
    expect(result.current).toBe(false);
    act(() => noteReach(false));
    expect(result.current).toBe(false);
    act(() => noteReach(false));
    expect(result.current).toBe(true);
    act(() => noteReach(false));
    expect(result.current).toBe(true);
    act(() => noteReach(true));
    expect(result.current).toBe(false);
  });

  it("an answer in between starts the count again: fail, answer, fail is not down", () => {
    const { result } = renderHook(() => useServerDown());
    act(() => { noteReach(false); noteReach(true); noteReach(false); });
    expect(result.current).toBe(false);
  });

  it("every request of the api client reports: 502, 503, 504 and a network failure count as failures", async () => {
    const { result } = renderHook(() => useServerDown());
    for (const status of [502, 503, 504]) {
      reset();
      mockFetch({ "GET /api/status": { status, body: { detail: "x" } } });
      await act(async () => { await fail(); });
      expect(result.current, `after one ${status}`).toBe(false);
      await act(async () => { await fail(); });
      expect(result.current, `after two ${status}`).toBe(true);
    }
    reset();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await act(async () => { await fail(); await fail(); });
    expect(result.current).toBe(true);
  });

  it("an answer below 500 resets the count, and so does a 500: the server answered", async () => {
    const { result } = renderHook(() => useServerDown());
    for (const status of [200, 401, 403, 404, 422, 500]) {
      reset();
      const routes = { "GET /api/status": { status: 502, body: {} }, "GET /api/other": { status, body: {} } };
      mockFetch(routes);
      await act(async () => { await fail(); await fail("/api/other"); await fail(); });
      expect(result.current, `fail, ${status}, fail`).toBe(false);
      await act(async () => { await fail(); await fail(); });
      expect(result.current, `then two more`).toBe(true);
      await act(async () => { await fail("/api/other"); });
      expect(result.current, `cleared by a ${status}`).toBe(false);
    }
  });

  it("a 204 is an answer too", async () => {
    const { result } = renderHook(() => useServerDown());
    mockFetch({ "GET /api/status": { status: 502, body: {} }, "DELETE /api/assets/3": { status: 204 } });
    await act(async () => { await fail(); await fail(); });
    expect(result.current).toBe(true);
    await act(async () => { await api.del("/api/assets/3"); });
    expect(result.current).toBe(false);
  });

  it("starts no timer of its own", () => {
    const set = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    act(() => { noteReach(false); noteReach(false); noteReach(true); });
    expect(set).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});
