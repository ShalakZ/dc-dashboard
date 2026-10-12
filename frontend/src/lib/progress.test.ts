import { manualTimers } from "../test/manualTimers";
import { createProgress, FADE_MS, FINISH_MS, MIN_SWEEP_MS, SETTLE_MS, SHOW_DELAY_MS } from "./progress";

/** A fresh store on a clock the test moves by hand, attached unless the test says otherwise. */
function setup(attach = true) {
  const clock = manualTimers();
  const store = createProgress(clock.timers);
  if (attach) store.attach();
  return { clock, store };
}

describe("progress: a load", () => {
  it("never shows for a load that ends before the delay", () => {
    const { clock, store } = setup();
    store.setCount("fetching", 1);
    clock.advance(SHOW_DELAY_MS - 1);
    store.setCount("fetching", 0);
    clock.advance(5000);
    expect(store.getPhase()).toBe("idle");
    expect(clock.count).toBe(0);
  });

  it("shows run for a load that lasts the delay", () => {
    const { clock, store } = setup();
    store.setCount("fetching", 1);
    clock.advance(SHOW_DELAY_MS - 1);
    expect(store.getPhase()).toBe("idle");
    clock.advance(1);
    expect(store.getPhase()).toBe("run");
  });

  it("finishes after the quiet time, fades, then goes idle", () => {
    const { clock, store } = setup();
    store.setCount("fetching", 1);
    clock.advance(SHOW_DELAY_MS);
    store.setCount("fetching", 0);
    clock.advance(SETTLE_MS - 1);
    expect(store.getPhase()).toBe("run");
    clock.advance(1);
    expect(store.getPhase()).toBe("finish");
    clock.advance(FINISH_MS);
    expect(store.getPhase()).toBe("fade");
    clock.advance(FADE_MS);
    expect(store.getPhase()).toBe("idle");
    expect(clock.count).toBe(0);
  });

  it("stays running through a gap shorter than the quiet time (chained loads)", () => {
    const { clock, store } = setup();
    store.setCount("fetching", 1);
    clock.advance(SHOW_DELAY_MS);
    store.setCount("fetching", 0);
    clock.advance(SETTLE_MS - 1);
    store.setCount("pending", 1);
    clock.advance(1000);
    expect(store.getPhase()).toBe("run");
    store.setCount("pending", 0);
    clock.advance(SETTLE_MS);
    expect(store.getPhase()).toBe("finish");
  });

  it("finishes only when every source is back at zero", () => {
    const { clock, store } = setup();
    store.setCount("fetching", 1);
    store.setCount("pending", 1);
    clock.advance(SHOW_DELAY_MS);
    store.setCount("fetching", 0);
    clock.advance(1000);
    expect(store.getPhase()).toBe("run");
    store.setCount("pending", 0);
    clock.advance(SETTLE_MS);
    expect(store.getPhase()).toBe("finish");
  });

  it("starts again from reset when a load begins during finish or fade, and advance() runs it", () => {
    for (const during of [SETTLE_MS, SETTLE_MS + FINISH_MS]) {
      const { clock, store } = setup();
      store.setCount("mutating", 1);
      clock.advance(SHOW_DELAY_MS);
      store.setCount("mutating", 0);
      clock.advance(during);
      expect(store.getPhase()).toBe(during === SETTLE_MS ? "finish" : "fade");
      store.setCount("mutating", 1);
      expect(store.getPhase()).toBe("reset");
      expect(clock.count).toBe(0); // the finish and fade timers are gone
      store.advance();
      expect(store.getPhase()).toBe("run");
      store.setCount("mutating", 0);
      clock.advance(SETTLE_MS);
      expect(store.getPhase()).toBe("finish"); // and it ends normally
    }
  });

  it("settles after a reset whose load ended before advance()", () => {
    const { clock, store } = setup();
    store.setCount("fetching", 1);
    clock.advance(SHOW_DELAY_MS);
    store.setCount("fetching", 0);
    clock.advance(SETTLE_MS);
    store.setCount("fetching", 1);
    expect(store.getPhase()).toBe("reset");
    store.setCount("fetching", 0);
    expect(store.getPhase()).toBe("reset");
    store.advance();
    expect(store.getPhase()).toBe("run");
    clock.advance(SETTLE_MS);
    expect(store.getPhase()).toBe("finish");
  });

  it("does nothing on advance() outside reset", () => {
    const { store } = setup();
    store.advance();
    expect(store.getPhase()).toBe("idle");
    store.pulse();
    store.advance();
    expect(store.getPhase()).toBe("run");
  });
});

describe("progress: a navigation", () => {
  it("shows run at once and holds it, with no counts, for the minimum sweep", () => {
    const { clock, store } = setup();
    store.pulse();
    expect(store.getPhase()).toBe("run");
    clock.advance(MIN_SWEEP_MS - 1);
    expect(store.getPhase()).toBe("run");
    clock.advance(1 + SETTLE_MS - 1);
    expect(store.getPhase()).toBe("run");
    clock.advance(1);
    expect(store.getPhase()).toBe("finish");
  });

  it("restarts the hold when another navigation comes while running", () => {
    const { clock, store } = setup();
    store.pulse();
    clock.advance(300);
    store.pulse();
    clock.advance(MIN_SWEEP_MS + SETTLE_MS - 1); // 799 ms after the first, 499 after the second
    expect(store.getPhase()).toBe("run");
    clock.advance(1);
    expect(store.getPhase()).toBe("finish");
  });

  it("goes to reset when it comes during finish", () => {
    const { clock, store } = setup();
    store.pulse();
    clock.advance(MIN_SWEEP_MS + SETTLE_MS);
    expect(store.getPhase()).toBe("finish");
    store.pulse();
    expect(store.getPhase()).toBe("reset");
    store.advance();
    expect(store.getPhase()).toBe("run");
  });

  it("is held by a load that outlasts it", () => {
    const { clock, store } = setup();
    store.pulse();
    store.setCount("fetching", 1);
    clock.advance(2000);
    expect(store.getPhase()).toBe("run");
    store.setCount("fetching", 0);
    clock.advance(SETTLE_MS);
    expect(store.getPhase()).toBe("finish");
  });
});

describe("progress: with no bar mounted", () => {
  it("leaves idle for neither a count nor a navigation, and arms no timer", () => {
    const { clock, store } = setup(false);
    store.setCount("fetching", 1);
    store.add("pending");
    store.pulse();
    clock.advance(10_000);
    expect(store.getPhase()).toBe("idle");
    expect(clock.scheduled).toBe(0);
    expect(clock.count).toBe(0);
  });

  it("shows a count that was set before attach()", () => {
    const { clock, store } = setup(false);
    store.setCount("fetching", 1);
    store.attach();
    clock.advance(SHOW_DELAY_MS);
    expect(store.getPhase()).toBe("run");
  });

  it("forgets a navigation that came before attach()", () => {
    const { clock, store } = setup(false);
    store.pulse();
    store.attach();
    expect(store.getPhase()).toBe("idle");
    expect(clock.count).toBe(0);
  });

  it("returns to idle on the last detach() with no timer left, and the counts survive", () => {
    const { clock, store } = setup();
    store.pulse();
    store.setCount("fetching", 2);
    clock.advance(MIN_SWEEP_MS + 50);
    expect(store.getPhase()).toBe("run");
    store.detach();
    expect(store.getPhase()).toBe("idle");
    expect(clock.count).toBe(0);
    expect(store.getCount("fetching")).toBe(2);
    clock.advance(10_000);
    expect(store.getPhase()).toBe("idle");
    store.attach(); // the load is still going
    clock.advance(SHOW_DELAY_MS);
    expect(store.getPhase()).toBe("run");
  });

  it("survives StrictMode's attach, detach, attach", () => {
    const { clock, store } = setup(false);
    store.attach();
    store.detach();
    store.attach();
    store.setCount("fetching", 1);
    clock.advance(SHOW_DELAY_MS);
    expect(store.getPhase()).toBe("run");
    store.detach();
    expect(store.getPhase()).toBe("idle");
    expect(clock.count).toBe(0);
  });

  it("keeps the bar while one of two mounted bars is still there", () => {
    const { clock, store } = setup();
    store.attach();
    store.pulse();
    store.detach();
    expect(store.getPhase()).toBe("run");
    store.detach();
    expect(store.getPhase()).toBe("idle");
    expect(clock.count).toBe(0);
    store.detach(); // one too many is harmless
    expect(store.getPhase()).toBe("idle");
  });
});

describe("progress: add, counts and subscribers", () => {
  it("add() counts one load and its remove is idempotent", () => {
    const { store } = setup();
    expect(store.getCount("pending")).toBe(0);
    const remove = store.add("pending");
    const other = store.add("pending");
    expect(store.getCount("pending")).toBe(2);
    remove();
    remove();
    expect(store.getCount("pending")).toBe(1);
    other();
    expect(store.getCount("pending")).toBe(0);
  });

  it("never counts below zero", () => {
    const { store } = setup();
    store.setCount("fetching", -3);
    expect(store.getCount("fetching")).toBe(0);
  });

  it("notifies once per phase change, and not after unsubscribing", () => {
    const { clock, store } = setup();
    const seen: string[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getPhase()));
    store.setCount("fetching", 1);
    store.setCount("fetching", 2); // no change of phase
    clock.advance(SHOW_DELAY_MS);
    store.setCount("fetching", 0);
    clock.advance(SETTLE_MS + FINISH_MS + FADE_MS);
    expect(seen).toEqual(["run", "finish", "fade", "idle"]);
    unsubscribe();
    store.pulse();
    expect(seen).toHaveLength(4);
  });
});

describe("progress: the real timers", () => {
  afterEach(() => vi.useRealTimers());

  it("run on setTimeout when none are injected", () => {
    vi.useFakeTimers();
    const store = createProgress();
    store.attach();
    store.setCount("fetching", 1);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(store.getPhase()).toBe("run");
    store.setCount("fetching", 0);
    vi.advanceTimersByTime(SETTLE_MS + FINISH_MS + FADE_MS);
    expect(store.getPhase()).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leave no timer when nothing is attached", () => {
    vi.useFakeTimers();
    const store = createProgress();
    store.setCount("fetching", 1);
    store.pulse();
    expect(vi.getTimerCount()).toBe(0);
    expect(store.getPhase()).toBe("idle");
  });
});
