import { act, renderHook } from "@testing-library/react";
import { manualTimers } from "../test/manualTimers";
import { useValueTip, VALUE_DWELL_MS, VALUE_GRACE_MS } from "./useValueTip";

afterEach(() => vi.unstubAllGlobals());

function pointEl(left = 40) {
  const el = document.createElement("div");
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ left, top: 20, right: left + 100, bottom: 50, width: 100, height: 30, x: left, y: 20, toJSON: () => ({}) });
  return el;
}

function setup() {
  const clock = manualTimers();
  const hook = renderHook(() => useValueTip(clock.timers));
  const api = () => hook.result.current;
  const run = (fn: () => void) => act(fn);
  const advance = (ms: number) => act(() => clock.advance(ms));
  return { ...hook, clock, api, run, advance };
}

describe("useValueTip, hover", () => {
  it("shows nothing before the 350 ms dwell, then the target with the node's rectangle", () => {
    const { api, run, advance } = setup();
    const el = pointEl();
    run(() => api().enter("p:1", 7, el));
    advance(VALUE_DWELL_MS - 1);
    expect(api().target).toBeNull();
    advance(1);
    expect(api().target).toEqual({ nodeId: "p:1", mappingId: 7, rect: el.getBoundingClientRect() });
  });

  it("leaving before the dwell ends starts nothing and leaves no timer behind", () => {
    const { api, run, advance, clock } = setup();
    run(() => api().enter("p:1", 7, pointEl()));
    advance(200);
    run(() => api().leave());
    advance(1000);
    expect(api().target).toBeNull();
    expect(clock.count).toBe(0);
  });

  it("keeps the card for the 100 ms leave grace, and a new enter on the same node inside it keeps the very same card", () => {
    const { api, run, advance } = setup();
    run(() => api().enter("p:1", 7, pointEl()));
    advance(VALUE_DWELL_MS);
    const shown = api().target;
    run(() => api().leave());
    advance(VALUE_GRACE_MS - 1);
    expect(api().target).toBe(shown);
    run(() => api().enter("p:1", 7, pointEl()));
    advance(1000);
    expect(api().target).toBe(shown);
    run(() => api().leave());
    advance(VALUE_GRACE_MS);
    expect(api().target).toBeNull();
  });

  it("drops the old card at once when the pointer moves to another node, and shows the new one after its own dwell", () => {
    const { api, run, advance } = setup();
    run(() => api().enter("p:1", 7, pointEl()));
    advance(VALUE_DWELL_MS);
    run(() => { api().leave(); api().enter("p:2", 8, pointEl(200)); });
    expect(api().target).toBeNull();
    advance(VALUE_DWELL_MS - 1);
    expect(api().target).toBeNull();
    advance(1);
    expect(api().target).toMatchObject({ nodeId: "p:2", mappingId: 8 });
  });

  it("counts hover only where the device can hover: a touch screen arms no timer", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { api, run, advance, clock } = setup();
    run(() => api().enter("p:1", 7, pointEl()));
    advance(1000);
    expect(api().target).toBeNull();
    expect(clock.scheduled).toBe(0);
  });
});

describe("useValueTip, keyboard focus", () => {
  it("shows after the dwell for a focused node and goes with the blur", () => {
    const { api, run, advance } = setup();
    run(() => api().focus("p:1", 7, pointEl()));
    advance(VALUE_DWELL_MS);
    expect(api().target).toMatchObject({ nodeId: "p:1" });
    run(() => api().blur());
    advance(VALUE_GRACE_MS);
    expect(api().target).toBeNull();
  });

  it("a pointer leaving the focused node does not take the card away", () => {
    const { api, run, advance } = setup();
    run(() => api().focus("p:1", 7, pointEl()));
    advance(VALUE_DWELL_MS);
    run(() => api().enter("p:1", 7, pointEl()));
    run(() => api().leave());
    advance(1000);
    expect(api().target).toMatchObject({ nodeId: "p:1" });
  });

  it("the pointer wins over the focus while it rests on another node", () => {
    const { api, run, advance } = setup();
    run(() => api().focus("p:1", 7, pointEl()));
    advance(VALUE_DWELL_MS);
    run(() => api().enter("p:2", 8, pointEl(300)));
    advance(VALUE_DWELL_MS);
    expect(api().target).toMatchObject({ nodeId: "p:2" });
    run(() => api().leave());
    advance(VALUE_GRACE_MS + VALUE_DWELL_MS);
    expect(api().target).toMatchObject({ nodeId: "p:1" });
  });
});

describe("useValueTip, hide and unmount", () => {
  it("hide() takes the card away, cancels what is pending, and forgets the hover and the focus", () => {
    const { api, run, advance, clock } = setup();
    run(() => api().enter("p:1", 7, pointEl()));
    run(() => api().focus("p:1", 7, pointEl()));
    advance(VALUE_DWELL_MS);
    expect(api().target).not.toBeNull();
    run(() => api().hide());
    expect(api().target).toBeNull();
    advance(5000);
    expect(api().target).toBeNull();
    expect(clock.count).toBe(0);
  });

  it("hide() during the dwell cancels the card that was about to show", () => {
    const { api, run, advance, clock } = setup();
    run(() => api().enter("p:1", 7, pointEl()));
    run(() => api().hide());
    advance(1000);
    expect(api().target).toBeNull();
    expect(clock.count).toBe(0);
  });

  it("an unmount cancels the timers", () => {
    const { api, run, unmount, clock } = setup();
    run(() => api().enter("p:1", 7, pointEl()));
    expect(clock.count).toBe(1);
    unmount();
    expect(clock.count).toBe(0);
  });

  it("every function keeps its identity across renders and state changes", () => {
    const { api, run, advance, rerender } = setup();
    const first = api();
    rerender();
    run(() => api().enter("p:1", 7, pointEl()));
    advance(VALUE_DWELL_MS);
    expect(api().target).not.toBeNull();
    rerender();
    for (const name of ["enter", "leave", "focus", "blur", "hide"] as const) expect(api()[name], name).toBe(first[name]);
  });
});
