import { act, renderHook } from "@testing-library/react";
import { setUnauthorizedHandler } from "../api/client";
import { SITE } from "../test/dashboardFixtures";
import { mockFetch } from "../test/fetchMock";
import { useStream } from "./useStream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CLOSED = 2;
  readyState = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; this.readyState = 2; }
  /** What a browser does after a 401 or a 502: the connection is CLOSED and `error` fires, and it never retries. */
  fail(readyState = 2) { this.readyState = readyState; this.onerror?.(); }
}
const instances = () => FakeEventSource.instances;
const latest = () => instances()[instances().length - 1];
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  setUnauthorizedHandler(null);
});

describe("useStream", () => {
  it("opens one stream for the wanted points and reports when it is up", () => {
    mockFetch({});
    const { result } = renderHook(() => useStream(new Set([7, 8])));
    expect(instances().map((s) => s.url)).toEqual(["/api/stream"]);
    expect(result.current.connected).toBe(false);
    act(() => latest().onopen?.());
    expect(result.current.connected).toBe(true);
  });

  it("reopens a closed stream after 5 s, doubling up to 60 s, and starts over at 5 s once it is open again", async () => {
    mockFetch({ "GET /api/site": { body: SITE } });
    const { result } = renderHook(() => useStream(new Set([7])));
    act(() => latest().onopen?.());
    for (const seconds of [5, 10, 20, 40, 60, 60]) {
      const before = instances().length;
      act(() => latest().fail());
      expect(result.current.connected).toBe(false);
      await wait(seconds * 1000 - 1);
      expect(instances()).toHaveLength(before); // not yet
      await wait(1);
      expect(instances()).toHaveLength(before + 1);
    }
    act(() => latest().onopen?.());
    expect(result.current.connected).toBe(true);
    const before = instances().length;
    act(() => latest().fail());
    await wait(4_999);
    expect(instances()).toHaveLength(before);
    await wait(1);
    expect(instances()).toHaveLength(before + 1);
  });

  it("leaves a stream alone while the browser is still reconnecting by itself, and when the state is unknown", async () => {
    mockFetch({ "GET /api/site": { body: SITE } });
    const { result } = renderHook(() => useStream(new Set([7])));
    act(() => latest().fail(0));
    expect(result.current.connected).toBe(false);
    // A test double that has no readyState at all (the older fakes) must not arm a reopen either.
    act(() => { (latest() as unknown as { readyState?: number }).readyState = undefined; latest().onerror?.(); });
    await wait(120_000);
    expect(instances()).toHaveLength(1);
  });

  it("checks the session with a request whose 401 reaches the unauthorized handler (/api/me would not)", async () => {
    const calls = mockFetch({ "GET /api/site": { status: 401, body: { detail: "not authenticated" } } });
    const lost = vi.fn();
    setUnauthorizedHandler(lost);
    renderHook(() => useStream(new Set([7])));
    act(() => latest().fail());
    await wait(0);
    expect(calls.map((c) => c.path)).toEqual(["/api/site"]);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("stops everything when the caller goes away: no timer, no new stream", async () => {
    mockFetch({ "GET /api/site": { body: SITE } });
    const { unmount } = renderHook(() => useStream(new Set([7])));
    act(() => latest().fail());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(latest().closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await wait(120_000);
    expect(instances()).toHaveLength(1);
  });

  it("opens nothing for an empty set and follows a changed set with one new stream", () => {
    mockFetch({});
    const { rerender } = renderHook(({ ids }: { ids: number[] }) => useStream(new Set(ids)), { initialProps: { ids: [] as number[] } });
    expect(instances()).toHaveLength(0);
    rerender({ ids: [7] });
    expect(instances()).toHaveLength(1);
    rerender({ ids: [7, 8] });
    expect(instances().map((s) => s.closed)).toEqual([true, false]);
  });
});
