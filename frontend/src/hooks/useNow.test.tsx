import { act, renderHook } from "@testing-library/react";
import { useNow } from "./useNow";

afterEach(() => vi.useRealTimers());

describe("useNow", () => {
  it("returns the current time and moves it on at the interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
    const { result, unmount } = renderHook(() => useNow(30_000));
    expect(result.current).toBe(Date.parse("2026-10-08T10:00:00Z"));
    act(() => { vi.advanceTimersByTime(29_999); });
    expect(result.current).toBe(Date.parse("2026-10-08T10:00:00Z"));
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(Date.parse("2026-10-08T10:00:30Z"));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
