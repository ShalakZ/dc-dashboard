import type { WidgetData } from "../api/types";
import type { WidgetReply } from "./displayApi";
import type { Timers } from "./displayLoop";
import { createWidgetQueue, type QueueResult } from "./wallQueue";

// A clock the test moves by hand, with the `now` the queue reads: both move together, so a timer that fires sees the instant it was set for.
function makeClock() {
  let now = 0;
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
    get pending() { return pending.size; },
  };
}
/** Lets the promise callbacks the queue hangs on a settled request run. */
const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

const FIGURES = { type: "stat", mode: "values", source: "energy", series: [], values: [] } as unknown as WidgetData;
const reply = (over: Partial<WidgetReply> = {}): WidgetReply => ({ status: 200, data: FIGURES, retryAfter: null, serverDate: 1_000, ...over });

interface Call { item: number; widget: number; at: number; resolve: (value: WidgetReply) => void; reject: (reason?: unknown) => void }

/** A queue over a fake `fetchWidget` whose requests the test settles by hand (or `auto`: every request fails/answers at once). */
function setup(options: { random?: () => number; auto?: (call: { item: number; widget: number; n: number }) => WidgetReply | "network" } = {}) {
  const clock = makeClock();
  const calls: Call[] = [];
  const results: { key: string; result: QueueResult }[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let n = 0;
  const queue = createWidgetQueue({
    timers: clock.timers,
    now: clock.now,
    random: options.random ?? (() => 0),
    fetchWidget: (item, widget) => {
      n += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const done = <T,>(value: T) => { concurrent -= 1; return value; };
      if (options.auto) {
        const answer = options.auto({ item, widget, n });
        calls.push({ item, widget, at: clock.now(), resolve: () => {}, reject: () => {} });
        return answer === "network" ? Promise.reject(new TypeError("network")).catch((e) => { concurrent -= 1; throw e; }) : Promise.resolve(done(answer));
      }
      return new Promise<WidgetReply>((resolve, reject) => {
        calls.push({
          item, widget, at: clock.now(),
          resolve: (value) => { concurrent -= 1; resolve(value); },
          reject: (reason) => { concurrent -= 1; reject(reason); },
        });
      });
    },
    onResult: (key, result) => { results.push({ key, result }); },
  });
  const job = (id: number, urgent = false) => ({ key: `k${id}`, item: 1, widget: id, urgent });
  return { clock, queue, calls, results, job, max: () => maxConcurrent };
}

describe("createWidgetQueue: the two in flight", () => {
  it("never has more than 2 requests at once with 10 jobs, and answers all 10", async () => {
    const t = setup();
    for (let id = 1; id <= 10; id += 1) t.queue.enqueue(t.job(id));
    expect(t.calls).toHaveLength(2);
    expect(t.queue.inFlight()).toBe(2);
    expect(t.queue.waiting()).toBe(8);
    for (let done = 0; done < 10; done += 1) {
      t.calls[done].resolve(reply());
      await settle();
      expect(t.queue.inFlight()).toBeLessThanOrEqual(2);
    }
    expect(t.calls).toHaveLength(10);
    expect(t.max()).toBe(2);
    expect(t.results.map((entry) => entry.key)).toEqual(["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9", "k10"]);
    expect(t.results.every((entry) => entry.result.kind === "ok")).toBe(true);
    expect(t.queue.inFlight()).toBe(0);
    expect(t.queue.waiting()).toBe(0);
  });

  it("asks for each job's own item and widget, and reports the figures and the server date", async () => {
    const t = setup();
    t.queue.enqueue({ key: "a", item: 7, widget: 9, urgent: false });
    expect(t.calls[0]).toMatchObject({ item: 7, widget: 9 });
    t.calls[0].resolve(reply({ serverDate: 5_000 }));
    await settle();
    expect(t.results).toEqual([{ key: "a", result: { kind: "ok", data: FIGURES, serverDate: 5_000 } }]);
  });

  it("starts the waiting jobs first in first out", async () => {
    const t = setup();
    for (let id = 1; id <= 5; id += 1) t.queue.enqueue(t.job(id));
    t.calls[0].resolve(reply()); await settle();
    t.calls[1].resolve(reply()); await settle();
    expect(t.calls.map((call) => call.widget)).toEqual([1, 2, 3, 4]);
  });

  it("starts urgent jobs before the others", async () => {
    const t = setup();
    for (let id = 1; id <= 4; id += 1) t.queue.enqueue(t.job(id)); // 1 and 2 run, 3 and 4 wait
    t.queue.enqueue(t.job(5, true));
    t.queue.enqueue(t.job(6, true));
    t.calls[0].resolve(reply()); await settle();
    t.calls[1].resolve(reply()); await settle();
    expect(t.calls.map((call) => call.widget)).toEqual([1, 2, 5, 6]);
    t.calls[2].resolve(reply()); await settle();
    t.calls[3].resolve(reply()); await settle();
    expect(t.calls.map((call) => call.widget)).toEqual([1, 2, 5, 6, 3, 4]);
  });

  it("lets an urgent enqueue of a waiting key overtake the other waiting jobs", async () => {
    const t = setup();
    for (let id = 1; id <= 5; id += 1) t.queue.enqueue(t.job(id)); // 3, 4, 5 wait
    t.queue.enqueue(t.job(5, true));
    expect(t.queue.waiting()).toBe(3);
    t.calls[0].resolve(reply()); await settle();
    expect(t.calls[2].widget).toBe(5);
  });

  it("treats the same key twice as one job, waiting or running", async () => {
    const t = setup();
    t.queue.enqueue(t.job(1));
    t.queue.enqueue(t.job(1));
    t.queue.enqueue(t.job(2));
    t.queue.enqueue(t.job(3));
    t.queue.enqueue(t.job(3, true));
    expect(t.calls).toHaveLength(2);
    expect(t.queue.waiting()).toBe(1);
    t.calls[0].resolve(reply()); await settle();
    t.calls[1].resolve(reply()); await settle();
    t.calls[2].resolve(reply()); await settle();
    expect(t.calls.map((call) => call.widget)).toEqual([1, 2, 3]);
    expect(t.results.map((entry) => entry.key)).toEqual(["k1", "k2", "k3"]);
  });

  it("can ask for a key again once its job is done", async () => {
    const t = setup();
    t.queue.enqueue(t.job(1));
    t.calls[0].resolve(reply()); await settle();
    t.queue.enqueue(t.job(1));
    expect(t.calls).toHaveLength(2);
  });

  it("sits idle with no timer", async () => {
    const t = setup();
    expect(t.clock.pending).toBe(0);
    t.queue.enqueue(t.job(1));
    t.calls[0].resolve(reply()); await settle();
    expect(t.clock.pending).toBe(0);
  });
});

describe("createWidgetQueue: cancel, clear, pause", () => {
  it("drops a waiting job on cancel: it is never requested and never reported", async () => {
    const t = setup();
    for (let id = 1; id <= 3; id += 1) t.queue.enqueue(t.job(id));
    t.queue.cancel("k3");
    expect(t.queue.waiting()).toBe(0);
    t.calls[0].resolve(reply()); await settle();
    t.calls[1].resolve(reply()); await settle();
    expect(t.calls).toHaveLength(2);
    expect(t.results.map((entry) => entry.key)).toEqual(["k1", "k2"]);
  });

  it("ignores the answer of a running job on cancel, which still holds its slot until it answers", async () => {
    const t = setup();
    for (let id = 1; id <= 3; id += 1) t.queue.enqueue(t.job(id));
    t.queue.cancel("k1");
    expect(t.queue.inFlight()).toBe(2); // the request is still on the wire
    expect(t.calls).toHaveLength(2);
    t.calls[0].resolve(reply()); await settle();
    expect(t.results).toEqual([]);
    expect(t.calls).toHaveLength(3); // its slot went to the waiting job
    expect(t.calls[2].widget).toBe(3);
  });

  it("does not retry a cancelled job that fails, and reports nothing for it", async () => {
    const t = setup();
    t.queue.enqueue(t.job(1));
    t.queue.cancel("k1");
    t.calls[0].reject(new TypeError("network")); await settle();
    t.clock.advance(600_000);
    expect(t.calls).toHaveLength(1);
    expect(t.results).toEqual([]);
  });

  it("does not retry a job cancelled while it waits out a cool-down", async () => {
    const t = setup();
    t.queue.enqueue(t.job(1));
    t.calls[0].reject(new TypeError("network")); await settle();
    expect(t.results).toEqual([{ key: "k1", result: { kind: "failed", status: null, serverDate: null } }]);
    t.queue.cancel("k1");
    t.clock.advance(600_000);
    expect(t.calls).toHaveLength(1);
    expect(t.clock.pending).toBe(0);
  });

  it("starts a job at the end of the cool-down even while cancelled requests are still on the wire", async () => {
    const t = setup();
    t.queue.enqueue(t.job(1));
    t.queue.enqueue(t.job(2));
    t.queue.enqueue(t.job(3)); // waits: both slots are taken
    t.queue.cancel("k1");
    t.queue.cancel("k2");
    t.calls[0].reject(new TypeError("network")); await settle(); // a cool-down of 5 s; k2's request hangs on
    expect(t.queue.inFlight()).toBe(1);
    t.clock.advance(4_999);
    expect(t.calls).toHaveLength(2);
    t.clock.advance(1);
    expect(t.calls.map((call) => call.widget)).toEqual([1, 2, 3]);
  });

  it("starts a new request for a key cancelled while running and enqueued again", async () => {
    const t = setup();
    t.queue.enqueue(t.job(1));
    t.queue.cancel("k1");
    t.queue.enqueue(t.job(1));
    expect(t.calls).toHaveLength(2);
    t.calls[0].resolve(reply()); await settle();
    expect(t.results).toEqual([]); // the old answer belongs to the cancelled job
    t.calls[1].resolve(reply()); await settle();
    expect(t.results.map((entry) => entry.key)).toEqual(["k1"]);
  });

  it("clear cancels every job, waiting and running", async () => {
    const t = setup();
    for (let id = 1; id <= 5; id += 1) t.queue.enqueue(t.job(id));
    t.queue.clear();
    expect(t.queue.waiting()).toBe(0);
    t.calls[0].resolve(reply());
    t.calls[1].resolve(reply());
    await settle();
    expect(t.calls).toHaveLength(2);
    expect(t.results).toEqual([]);
    expect(t.queue.inFlight()).toBe(0);
  });

  it("starts nothing while paused, does not abort a running request, and goes on at resume", async () => {
    const t = setup();
    t.queue.enqueue(t.job(1));
    t.queue.pause();
    t.queue.enqueue(t.job(2));
    t.queue.enqueue(t.job(3));
    expect(t.calls).toHaveLength(1);
    expect(t.queue.waiting()).toBe(2);
    t.calls[0].resolve(reply()); await settle();
    expect(t.results.map((entry) => entry.key)).toEqual(["k1"]); // the running one is still answered and reported
    expect(t.calls).toHaveLength(1);
    t.clock.advance(60_000);
    expect(t.calls).toHaveLength(1);
    t.queue.resume();
    expect(t.calls.map((call) => call.widget)).toEqual([1, 2, 3]); // both waiting jobs start: two slots are free
    expect(t.queue.inFlight()).toBe(2);
  });
});

describe("createWidgetQueue: answers that are not figures", () => {
  it("reports a 404 as moved, with no cool-down: the next job starts at once", async () => {
    const t = setup();
    for (let id = 1; id <= 3; id += 1) t.queue.enqueue(t.job(id));
    t.calls[0].resolve(reply({ status: 404, data: null, serverDate: 2_000 })); await settle();
    expect(t.results).toEqual([{ key: "k1", result: { kind: "moved", serverDate: 2_000 } }]);
    expect(t.calls).toHaveLength(3);
    expect(t.clock.pending).toBe(0);
    t.clock.advance(600_000); // a moved job is done, not retried
    expect(t.calls).toHaveLength(3);
  });

  it.each([409, 422])("reports a %i as rejected once and never asks again", async (status) => {
    const t = setup();
    t.queue.enqueue(t.job(1));
    t.calls[0].resolve(reply({ status, data: null })); await settle();
    expect(t.results).toEqual([{ key: "k1", result: { kind: "rejected", status, serverDate: 1_000 } }]);
    t.clock.advance(3_600_000);
    expect(t.calls).toHaveLength(1);
    expect(t.clock.pending).toBe(0);
    t.queue.enqueue(t.job(2)); // no cool-down either
    expect(t.calls).toHaveLength(2);
  });

  it("reports a 401 as unauthorized, then asks again after the first backoff", async () => {
    const t = setup();
    t.queue.enqueue(t.job(1));
    t.calls[0].resolve(reply({ status: 401, data: null })); await settle();
    expect(t.results).toEqual([{ key: "k1", result: { kind: "unauthorized", serverDate: 1_000 } }]);
    t.clock.advance(4_999);
    expect(t.calls).toHaveLength(1);
    t.clock.advance(1);
    expect(t.calls).toHaveLength(2);
  });

  it.each([
    ["a 500", reply({ status: 500, data: null }), 500],
    ["a 502 from the proxy", reply({ status: 502, data: null }), 502],
    ["a 503", reply({ status: 503, data: null, retryAfter: 1 }), 503],
    ["a 200 with no figures", reply({ status: 200, data: null }), 200],
    ["a 400", reply({ status: 400, data: null }), 400],
  ])("reports %s as failed and asks again after 5 s", async (_name, answer, status) => {
    const t = setup();
    t.queue.enqueue(t.job(1));
    t.calls[0].resolve(answer); await settle();
    expect(t.results).toEqual([{ key: "k1", result: { kind: "failed", status, serverDate: 1_000 } }]);
    t.clock.advance(4_999);
    expect(t.calls).toHaveLength(1);
    t.clock.advance(1);
    expect(t.calls).toHaveLength(2);
  });

  it("reports a request that never completed (a network error, a timeout) as failed with no status", async () => {
    const t = setup();
    t.queue.enqueue(t.job(1));
    t.calls[0].reject(new DOMException("timed out", "TimeoutError")); await settle();
    expect(t.results).toEqual([{ key: "k1", result: { kind: "failed", status: null, serverDate: null } }]);
  });

  it("treats a fetchWidget that throws at once as a failure", async () => {
    const clock = makeClock();
    const results: QueueResult[] = [];
    const queue = createWidgetQueue({
      timers: clock.timers, now: clock.now, random: () => 0,
      fetchWidget: () => { throw new Error("broken"); },
      onResult: (_key, result) => { results.push(result); },
    });
    queue.enqueue({ key: "a", item: 1, widget: 1, urgent: false });
    await settle();
    expect(results).toEqual([{ kind: "failed", status: null, serverDate: null }]);
    expect(queue.inFlight()).toBe(0);
  });
});

describe("createWidgetQueue: a 429 (R4)", () => {
  it("waits the Retry-After before ANY job starts, reports nothing, and then asks again", async () => {
    const t = setup({ random: () => 0 });
    t.queue.enqueue(t.job(1));
    t.queue.enqueue(t.job(2));
    t.calls[0].resolve(reply({ status: 429, data: null, retryAfter: 7 })); await settle();
    expect(t.results).toEqual([]);
    t.queue.enqueue(t.job(3));
    t.calls[1].resolve(reply()); await settle(); // a free slot, still no start
    expect(t.calls).toHaveLength(2);
    t.clock.advance(6_999);
    expect(t.calls).toHaveLength(2);
    t.clock.advance(1);
    expect(t.calls.slice(2).map((call) => [call.widget, call.at])).toEqual([[1, 7_000], [3, 7_000]]); // the busy job first (it kept its place)
  });

  it("adds up to 30 percent of random: 7 s becomes 9.098 s at random 0.999", async () => {
    const t = setup({ random: () => 0.999 });
    t.queue.enqueue(t.job(1));
    t.calls[0].resolve(reply({ status: 429, data: null, retryAfter: 7 })); await settle();
    t.clock.advance(9_097);
    expect(t.calls).toHaveLength(1);
    t.clock.advance(1);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1].at).toBe(9_098);
  });

  it("waits 60 s without a Retry-After", async () => {
    const t = setup();
    t.queue.enqueue(t.job(1));
    t.calls[0].resolve(reply({ status: 429, data: null, retryAfter: null })); await settle();
    t.clock.advance(59_999);
    expect(t.calls).toHaveLength(1);
    t.clock.advance(1);
    expect(t.calls).toHaveLength(2);
  });

  it("is not a failure: the next failure still waits the first step, 5 s", async () => {
    const t = setup();
    t.queue.enqueue(t.job(1));
    t.calls[0].resolve(reply({ status: 429, data: null, retryAfter: 1 })); await settle();
    t.clock.advance(1_000);
    t.calls[1].reject(new TypeError("network")); await settle();
    t.clock.advance(4_999);
    expect(t.calls).toHaveLength(2);
    t.clock.advance(1);
    expect(t.calls).toHaveLength(3);
  });

  it("holds the queue after a 429 for a job that was cancelled meanwhile, and does not ask for it again", async () => {
    const t = setup();
    t.queue.enqueue(t.job(1));
    t.queue.cancel("k1");
    t.calls[0].resolve(reply({ status: 429, data: null, retryAfter: 5 })); await settle();
    t.queue.enqueue(t.job(2));
    expect(t.calls).toHaveLength(1);
    t.clock.advance(5_000);
    expect(t.calls.map((call) => call.widget)).toEqual([1, 2]);
  });
});

describe("createWidgetQueue: failures back off (R4)", () => {
  it("waits 5, 10 and 20 s, then 20 s again, between the attempts of one failing job, and reports every failure", async () => {
    const t = setup({ random: () => 0, auto: () => "network" });
    t.queue.enqueue(t.job(1));
    await settle();
    const waits = [5_000, 10_000, 20_000, 20_000, 20_000, 20_000];
    for (const wait of waits) {
      const before = t.calls.length;
      t.clock.advance(wait - 1);
      expect(t.calls).toHaveLength(before);
      t.clock.advance(1);
      await settle();
      expect(t.calls).toHaveLength(before + 1);
    }
    expect(t.calls.map((call) => call.at)).toEqual([0, 5_000, 15_000, 35_000, 55_000, 75_000, 95_000]);
    expect(t.results).toHaveLength(7);
    expect(t.results.every((entry) => entry.result.kind === "failed")).toBe(true);
  });

  it("jitters every wait by the random value", async () => {
    const t = setup({ random: () => 0.999, auto: () => "network" });
    t.queue.enqueue(t.job(1));
    await settle();
    t.clock.advance(6_498);
    expect(t.calls).toHaveLength(1);
    t.clock.advance(1);
    await settle();
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1].at).toBe(6_499);
  });

  it("starts the steps again at 5 s after an answer", async () => {
    const t = setup({ auto: ({ n }) => (n === 3 ? reply() : n <= 2 ? "network" : n === 4 ? "network" : reply()) });
    t.queue.enqueue(t.job(1));
    await settle();
    t.clock.advance(5_000); await settle(); // 2nd attempt (fails again)
    t.clock.advance(10_000); await settle(); // 3rd attempt answers
    expect(t.calls).toHaveLength(3);
    expect(t.results.at(-1)?.result.kind).toBe("ok");
    t.queue.enqueue(t.job(2)); // its first attempt (4th request) fails
    await settle();
    t.clock.advance(4_999);
    expect(t.calls).toHaveLength(4);
    t.clock.advance(1); await settle();
    expect(t.calls).toHaveLength(5);
  });

  it("makes every job wait for one queue-wide cool-down: nothing starts early when a slot is free", async () => {
    const t = setup();
    t.queue.enqueue(t.job(1));
    t.queue.enqueue(t.job(2));
    t.calls[0].reject(new TypeError("network")); await settle(); // cool-down 5 s from t=0
    t.queue.enqueue(t.job(3));
    t.clock.advance(2_000);
    t.calls[1].resolve(reply()); await settle(); // an answer in the cool-down does not end it
    expect(t.calls).toHaveLength(2);
    t.clock.advance(2_999);
    expect(t.calls).toHaveLength(2);
    t.clock.advance(1);
    expect(t.calls.slice(2).map((call) => call.widget)).toEqual([1, 3]);
  });

  it("keeps the cool-down across a clear: a re-enqueued job still waits it out", async () => {
    const t = setup();
    t.queue.enqueue(t.job(1));
    t.calls[0].reject(new TypeError("network")); await settle();
    t.queue.clear();
    t.queue.enqueue(t.job(2));
    expect(t.calls).toHaveLength(1);
    t.clock.advance(5_000);
    expect(t.calls).toHaveLength(2);
  });

  it("does not stay stuck when the clock moves back by more than any wait could be", async () => {
    const clock = makeClock();
    let skew = 10_000_000; // a local time well after the epoch, so a jump back stays positive
    const calls: Call[] = [];
    const queue = createWidgetQueue({
      timers: clock.timers, now: () => clock.now() + skew, random: () => 0,
      fetchWidget: (item, widget) => new Promise<WidgetReply>((resolve, reject) => { calls.push({ item, widget, at: clock.now(), resolve, reject }); }),
      onResult: () => {},
    });
    queue.enqueue({ key: "a", item: 1, widget: 1, urgent: false });
    calls[0].reject(new TypeError("network")); await settle();
    skew = 6_400_000; // the machine's clock jumps back an hour inside the cool-down
    clock.advance(5_000);
    expect(calls).toHaveLength(2);
  });
});

describe("createWidgetQueue: ten walls do not return in lockstep", () => {
  it("spreads the restart of ten queues that failed together at t=0 over at least 20 percent of the wait", async () => {
    const restarts: number[] = [];
    for (let wall = 0; wall < 10; wall += 1) {
      const random = [0, 0.11, 0.23, 0.34, 0.45, 0.56, 0.67, 0.78, 0.89, 0.999][wall];
      const clock = makeClock();
      let attempts = 0;
      const queue = createWidgetQueue({
        timers: clock.timers, now: clock.now, random: () => random,
        fetchWidget: () => {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new TypeError("network"));
          restarts.push(clock.now());
          return new Promise<WidgetReply>(() => {});
        },
        onResult: () => {},
      });
      queue.enqueue({ key: "a", item: 1, widget: 1, urgent: false });
      await settle();
      clock.advance(10_000);
    }
    expect(restarts).toHaveLength(10);
    expect(new Set(restarts).size).toBe(10);
    expect(Math.max(...restarts) - Math.min(...restarts)).toBeGreaterThanOrEqual(0.2 * 5_000);
    expect(Math.min(...restarts)).toBe(5_000);
    expect(Math.max(...restarts)).toBeLessThanOrEqual(5_000 * 1.3);
  });
});
