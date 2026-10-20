import type { Timers } from "./displayLoop";
import { installWakeEvents } from "./wakeEvents";
import { HEARTBEAT_MS, WAKE_JUMP_MS } from "./wallRules";

// A clock the test moves by hand. `jump` moves the time WITHOUT running the timers: a laptop that slept (its timers did not run, its clock moved on).
function makeClock() {
  let now = 1_000_000;
  let next = 0;
  const pending = new Map<number, { fn: () => void; at: number }>();
  const timers: Timers = {
    set(fn, ms) { next += 1; pending.set(next, { fn, at: now + ms }); return next; },
    clear(handle) { pending.delete(handle as number); },
  };
  return {
    timers,
    now: () => now,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending].filter(([, timer]) => timer.at <= end).sort(([a, x], [b, y]) => x.at - y.at || a - b)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    jump(ms: number) {
      now += ms;
      for (const timer of pending.values()) timer.at += ms; // a timer set before the sleep fires at the first chance after it
    },
    get pending() { return pending.size; },
  };
}

let hidden = false;
beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});
afterEach(() => {
  delete (document as unknown as Record<string, unknown>).hidden;
});

function setup() {
  const clock = makeClock();
  const woke: number[] = [];
  const stop = installWakeEvents({ timers: clock.timers, now: clock.now, onWake: () => woke.push(clock.now()), target: { document, window } });
  return { clock, woke, stop };
}
const fire = (target: Document | Window, type: string) => target.dispatchEvent(new Event(type));

describe("installWakeEvents: the events", () => {
  it("wakes once when the page becomes visible", () => {
    const t = setup();
    hidden = true;
    fire(document, "visibilitychange");
    expect(t.woke).toEqual([]);
    hidden = false;
    fire(document, "visibilitychange");
    expect(t.woke).toHaveLength(1);
    t.stop();
  });

  it("wakes once on pageshow and once on online", () => {
    const t = setup();
    fire(window, "pageshow");
    expect(t.woke).toHaveLength(1);
    fire(window, "online");
    expect(t.woke).toHaveLength(2);
    t.stop();
  });

  it("does not wake while the page is hidden: pageshow, online and the heartbeat's jump wait for the visibilitychange", () => {
    const t = setup();
    hidden = true;
    fire(window, "pageshow");
    fire(window, "online");
    t.clock.jump(60_000);
    t.clock.advance(HEARTBEAT_MS);
    expect(t.woke).toEqual([]);
    hidden = false;
    fire(document, "visibilitychange");
    expect(t.woke).toHaveLength(1);
    t.stop();
  });
});

describe("installWakeEvents: the heartbeat", () => {
  it("is quiet on ordinary beats, however long it runs", () => {
    const t = setup();
    t.clock.advance(10 * 60_000);
    expect(t.woke).toEqual([]);
    expect(t.clock.pending).toBe(1);
    t.stop();
  });

  it("wakes when the time between two beats is more than 15 s, not at exactly 15 s", () => {
    const t = setup();
    t.clock.advance(HEARTBEAT_MS); // a normal beat
    t.clock.jump(WAKE_JUMP_MS - HEARTBEAT_MS); // the next beat sees exactly 15 s
    t.clock.advance(HEARTBEAT_MS);
    expect(t.woke).toEqual([]);
    t.clock.jump(WAKE_JUMP_MS - HEARTBEAT_MS + 1); // one millisecond more
    t.clock.advance(HEARTBEAT_MS);
    expect(t.woke).toHaveLength(1);
    t.stop();
  });

  it("wakes once per jump, not on every beat after it", () => {
    const t = setup();
    t.clock.jump(3_600_000);
    t.clock.advance(HEARTBEAT_MS);
    t.clock.advance(10 * HEARTBEAT_MS);
    expect(t.woke).toHaveLength(1);
    t.stop();
  });

  it("ignores a clock that moved backwards", () => {
    const t = setup();
    t.clock.jump(-3_600_000);
    t.clock.advance(HEARTBEAT_MS);
    t.clock.advance(5 * HEARTBEAT_MS);
    expect(t.woke).toEqual([]);
    t.stop();
  });
});

describe("installWakeEvents: the uninstaller", () => {
  it("removes every listener and the heartbeat: nothing wakes and no timer is left", () => {
    const t = setup();
    t.stop();
    expect(t.clock.pending).toBe(0);
    fire(document, "visibilitychange");
    fire(window, "pageshow");
    fire(window, "online");
    t.clock.jump(3_600_000);
    t.clock.advance(60_000);
    expect(t.woke).toEqual([]);
    expect(t.clock.pending).toBe(0);
  });

  it("can be called twice", () => {
    const t = setup();
    t.stop();
    expect(() => t.stop()).not.toThrow();
  });

  it("stops the heartbeat that is running right now", () => {
    const clock = makeClock();
    const woke: number[] = [];
    let stop: () => void = () => {};
    stop = installWakeEvents({ timers: clock.timers, now: clock.now, onWake: () => { woke.push(1); stop(); }, target: { document, window } });
    clock.jump(60_000);
    clock.advance(HEARTBEAT_MS); // the wake uninstalls from inside the beat
    expect(woke).toEqual([1]);
    expect(clock.pending).toBe(0);
  });
});
