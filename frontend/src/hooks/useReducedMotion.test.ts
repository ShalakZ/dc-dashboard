import { act, renderHook } from "@testing-library/react";
import { reducedMotion, useReducedMotion } from "./useReducedMotion";

// A matchMedia stand-in for one query whose answer the test can flip and announce.
function stubMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const state = { matches: initial };
  const queries: string[] = [];
  const matchMedia = vi.fn((query: string) => {
    queries.push(query);
    return {
      get matches() { return state.matches; },
      media: query,
      addEventListener: (_type: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_type: string, fn: () => void) => { listeners.delete(fn); },
    };
  });
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    queries,
    listeners,
    set(matches: boolean) { state.matches = matches; act(() => { for (const fn of [...listeners]) fn(); }); },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("reducedMotion", () => {
  it("is false where the browser has no matchMedia (jsdom)", () => {
    expect(typeof window.matchMedia).not.toBe("function");
    expect(reducedMotion()).toBe(false);
  });

  it.each([[true], [false]])("asks for the reduce preference and returns %s", (answer) => {
    const media = stubMedia(answer);
    expect(reducedMotion()).toBe(answer);
    expect(media.queries).toEqual(["(prefers-reduced-motion: reduce)"]);
  });

  it("is false when matchMedia throws", () => {
    vi.stubGlobal("matchMedia", () => { throw new Error("nope"); });
    expect(reducedMotion()).toBe(false);
  });
});

describe("useReducedMotion", () => {
  it("is false without matchMedia and registers nothing", () => {
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  it("starts from the current preference", () => {
    stubMedia(true);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it("follows a change of the preference while mounted", () => {
    const media = stubMedia(false);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
    media.set(true);
    expect(result.current).toBe(true);
    media.set(false);
    expect(result.current).toBe(false);
  });

  it("removes its listener on unmount", () => {
    const media = stubMedia(false);
    const { unmount } = renderHook(() => useReducedMotion());
    expect(media.listeners.size).toBe(1);
    unmount();
    expect(media.listeners.size).toBe(0);
  });
});
