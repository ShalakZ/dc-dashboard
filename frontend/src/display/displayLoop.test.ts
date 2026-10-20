import { manualTimers } from "../test/manualTimers";
import { claimMemoSnapshot, resetClaimMemo, startDisplay, type DisplayDeps, type DisplayState, type Timers } from "./displayLoop";
import { holdSecret, type SecretHandle } from "./secretHandle";
import { jittered } from "./wallRules";

// The loop on its own (no React): the claim and the playlist poll on a clock the test moves by hand, `now` and `random` injected. The responses
// are plain objects (a `Response` reads its body over several macrotasks), so a few microtask turns settle one request.

// jsdom has no navigation (location.replace is "not implemented"): a good claim only records the call.
vi.mock("./reloadClean", () => ({ reloadClean: vi.fn() }));

const SECRET = "abc_DEF-123";
const CLAIM = "POST /api/display/claim";
const PLAYLIST = "GET /api/display/playlist";
const MINUTE = 60_000;

type Plain = { status: number; body?: unknown; headers?: Record<string, string> };
type Entry = number | "network" | Plain | ((init: RequestInit) => Promise<Response>);
type Call = { key: string; init: RequestInit };
let calls: Call[] = [];

const BODY = { display: { name: "Hall TV" }, playlist: { name: "Wall A", items: [] }, site: null, build: "test", status: null };
const good = (headers: Record<string, string> = {}): Plain => ({ status: 200, body: BODY, headers });
const revokedLink: Plain = { status: 401, body: { detail: "this display link is not valid" } };
const tooMany = (retryAfter: string): Plain => ({ status: 429, body: { detail: "x" }, headers: { "Retry-After": retryAfter } });

function respond(entry: number | Plain): Response {
  const plain: Plain = typeof entry === "number" ? { status: entry, body: { detail: "x" } } : entry;
  return { status: plain.status, headers: new Headers(plain.headers), json: async () => plain.body ?? {} } as unknown as Response;
}

/** One queue of replies per route; the last one repeats. A function is a reply the test controls (a hung request, a late answer). */
function stubFetch(script: Partial<Record<string, Entry[]>>) {
  calls = [];
  const left = new Map(Object.entries(script).map(([key, replies]) => [key, [...replies!]]));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const key = `${(init.method ?? "GET").toUpperCase()} ${String(input)}`;
      calls.push({ key, init });
      const queue = left.get(key);
      if (!queue) throw new Error(`unexpected request ${key}`);
      const entry = queue.length > 1 ? queue.shift()! : queue[0];
      if (typeof entry === "function") return entry(init);
      if (entry === "network") throw new TypeError("Failed to fetch");
      return respond(entry);
    }),
  );
}
const count = (key: string) => calls.filter((call) => call.key === key).length;

/** A request that stays open until the test answers it. */
function hung() {
  let answer!: (reply: number | Plain) => void;
  const entry = () => new Promise<Response>((resolve) => { answer = (reply) => resolve(respond(reply)); });
  return { entry, answer: (reply: number | Plain) => answer(reply) };
}

async function flush() {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

/** The loop on a hand-moved clock: `now` moves with the timers, and every delay the loop asked for is recorded. */
async function rig(link: SecretHandle | null = null, deps: DisplayDeps = {}) {
  const hand = manualTimers();
  const clock = { now: 1_700_000_000_000 };
  const delays: number[] = [];
  const states: DisplayState[] = [];
  const timers: Timers = {
    set: (fn, ms) => {
      delays.push(ms);
      return hand.timers.set(fn, ms);
    },
    clear: (handle) => hand.timers.clear(handle),
  };
  const loop = startDisplay(link, (state) => states.push(state), { timers, now: () => clock.now, ...deps });
  await flush();
  return {
    hand, delays, states, loop, clock,
    kinds: () => states.map((state) => state.kind),
    advance: async (ms: number) => {
      clock.now += ms;
      hand.advance(ms);
      await flush();
    },
  };
}

beforeEach(() => {
  resetClaimMemo();
  window.history.replaceState(null, "", "/display");
});
afterEach(() => {
  vi.unstubAllGlobals();
  calls = [];
});

describe("the connected state", () => {
  it("carries the playlist, the local time of the answer and the server's Date header, as a new object after every read", async () => {
    const date = "Tue, 20 Oct 2026 14:02:03 GMT";
    stubFetch({ [PLAYLIST]: [good({ Date: date }), good()] });
    const r = await rig();
    const first = r.states[0];
    expect(first).toMatchObject({ kind: "connected", receivedAt: r.clock.now, serverDate: Date.parse(date) });
    expect(first.kind === "connected" && first.reply.playlist.name).toBe("Wall A");
    expect(first.kind === "connected" && first.reply.display.name).toBe("Hall TV");
    await r.advance(MINUTE);
    expect(r.kinds()).toEqual(["connected", "connected"]);
    expect(r.states[1]).not.toBe(r.states[0]);
    expect(r.states[1]).toMatchObject({ receivedAt: r.clock.now, serverDate: null });
  });
});

describe("after the first success a failed read is silent", () => {
  const bad: Array<[string, Entry]> = [
    ["a network error", "network"],
    ["a 500", 500],
    ["a 502 from the proxy", 502],
    ["a 200 that is not a playlist", { status: 200, body: { oops: true } }],
  ];

  it.each(bad)("%s emits nothing and the retries come after 5, 10, 20 and 20 seconds with 0 percent jitter", async (_name, failure) => {
    stubFetch({ [PLAYLIST]: [good(), failure, failure, failure, failure, good(), failure] });
    const r = await rig(null, { random: () => 0 });
    await r.advance(MINUTE);
    for (const wait of [5_000, 10_000, 20_000, 20_000]) {
      expect(r.kinds(), "no state for a failed read").toEqual(["connected"]);
      expect(r.delays.at(-1)).toBe(wait);
      await r.advance(wait);
    }
    expect(r.kinds()).toEqual(["connected", "connected"]); // the good answer: the next state, nothing in between
    expect(r.delays.at(-1)).toBe(MINUTE);
    await r.advance(MINUTE);
    expect(r.kinds()).toEqual(["connected", "connected"]);
    expect(r.delays.at(-1), "and the backoff begins again from 5 s").toBe(5_000);
  });

  it("adds a random 0 to 30 percent to each retry (random 0.999), the doubling itself without it", async () => {
    stubFetch({ [PLAYLIST]: [good(), "network", "network", "network", "network", good()] });
    const r = await rig(null, { random: () => 0.999 });
    await r.advance(MINUTE);
    const expected = [5_000, 10_000, 20_000, 20_000].map((ms) => jittered(ms, () => 0.999));
    for (const wait of expected) {
      expect(r.delays.at(-1)).toBe(wait);
      await r.advance(wait);
    }
    expect(r.delays.slice(1, 5)).toEqual(expected);
    expect(expected[0]).toBeGreaterThan(5_000);
    expect(expected[0]).toBeLessThanOrEqual(6_500);
    expect(expected[3]).toBeLessThanOrEqual(26_000);
    expect(r.kinds()).toEqual(["connected", "connected"]);
  });

  it("before the first success nothing changes: offline each time, 5, 10, 20, 40, 60, 60 seconds, no jitter even with a random of 0.999", async () => {
    stubFetch({ [PLAYLIST]: ["network"] });
    const r = await rig(null, { random: () => 0.999 });
    for (let i = 0; i < 5; i += 1) await r.advance(r.delays.at(-1)!);
    expect(r.delays).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(r.kinds()).toEqual(Array(6).fill("offline"));
  });

  it("a 401 after the screen was connected still says revoked", async () => {
    stubFetch({ [PLAYLIST]: [good(), 401] });
    const r = await rig();
    await r.advance(MINUTE);
    expect(r.kinds()).toEqual(["connected", "revoked"]);
  });
});

describe("the revoked schedule", () => {
  it("asks again after 5, 15 and 60 minutes, says revoked each time, and then schedules nothing", async () => {
    stubFetch({ [PLAYLIST]: [revokedLink] });
    const r = await rig();
    expect(r.delays).toEqual([5 * MINUTE]);
    await r.advance(5 * MINUTE);
    expect(r.delays).toEqual([5 * MINUTE, 15 * MINUTE]);
    await r.advance(15 * MINUTE);
    expect(r.delays).toEqual([5 * MINUTE, 15 * MINUTE, 60 * MINUTE]);
    await r.advance(60 * MINUTE);
    expect(r.kinds()).toEqual(["revoked", "revoked", "revoked", "revoked"]);
    expect(count(PLAYLIST)).toBe(4);
    expect(r.hand.count, "the fourth revoked answer sets no timer").toBe(0);
    await r.advance(10 * 60 * MINUTE);
    expect(count(PLAYLIST)).toBe(4);
    expect(r.delays).toHaveLength(3);
  });

  it("a refused claim is the first revoked answer of the same chain", async () => {
    stubFetch({ [CLAIM]: [401], [PLAYLIST]: [revokedLink] });
    const handle = holdSecret(SECRET)!;
    const r = await rig(handle);
    expect(r.delays).toEqual([5 * MINUTE]);
    await r.advance(5 * MINUTE);
    await r.advance(15 * MINUTE);
    await r.advance(60 * MINUTE);
    expect(r.delays).toEqual([5 * MINUTE, 15 * MINUTE, 60 * MINUTE]);
    expect(r.kinds()).toEqual(["revoked", "revoked", "revoked", "revoked"]);
    expect(r.hand.count).toBe(0);
    expect(count(CLAIM)).toBe(1);
    expect(handle.secret()).toBeNull();
  });

  it("a read that answers 200 starts the chain over", async () => {
    stubFetch({ [PLAYLIST]: [revokedLink, revokedLink, good(), revokedLink, revokedLink] });
    const r = await rig();
    await r.advance(5 * MINUTE);
    await r.advance(15 * MINUTE);
    await r.advance(MINUTE);
    await r.advance(5 * MINUTE);
    expect(r.delays).toEqual([5 * MINUTE, 15 * MINUTE, MINUTE, 5 * MINUTE, 15 * MINUTE]);
    expect(r.kinds()).toEqual(["revoked", "revoked", "connected", "revoked", "revoked"]);
  });

  it("only a 200 resets it: a busy answer in between does not", async () => {
    stubFetch({ [PLAYLIST]: [revokedLink, tooMany("1"), revokedLink, revokedLink] });
    const r = await rig();
    await r.advance(5 * MINUTE);
    await r.advance(1_000);
    expect(r.delays).toEqual([5 * MINUTE, 1_000, 15 * MINUTE]);
  });

  it("'not connected' (a fresh load, no link, no mark on the 401) still polls every 60 seconds and never goes silent", async () => {
    stubFetch({ [PLAYLIST]: [{ status: 401, body: { detail: "not connected" } }] });
    const r = await rig();
    for (let i = 0; i < 6; i += 1) await r.advance(MINUTE);
    expect(r.delays).toEqual(Array(7).fill(MINUTE));
    expect(r.kinds()).toEqual(Array(7).fill("notConnected"));
  });

  it("a blocked address is unchanged: the claim's own wait, again and again", async () => {
    stubFetch({ [CLAIM]: [tooMany("120"), tooMany("120"), 204], [PLAYLIST]: [good()] });
    const r = await rig(holdSecret(SECRET)!);
    await r.advance(120_000);
    expect(r.delays).toEqual([120_000, 120_000]);
    await r.advance(120_000);
    expect(r.kinds()).toEqual(["blocked", "blocked", "connected"]);
  });
});

describe("refresh()", () => {
  it("does nothing before the first success: a read in flight, a claim that is retried, a first read that failed", async () => {
    const wait = hung();
    stubFetch({ [PLAYLIST]: [wait.entry] });
    const first = await rig();
    first.loop.refresh();
    await flush();
    expect(count(PLAYLIST)).toBe(1);

    stubFetch({ [CLAIM]: ["network", 204], [PLAYLIST]: [good()] });
    const claiming = await rig(holdSecret(SECRET)!);
    claiming.loop.refresh();
    await flush();
    expect(count(PLAYLIST), "a claim retry reads no playlist").toBe(0);
    expect(count(CLAIM)).toBe(1);
    expect(claiming.hand.count).toBe(1);
    expect(claiming.delays).toEqual([5_000]);

    stubFetch({ [PLAYLIST]: [500, good()] });
    const failed = await rig();
    expect(failed.kinds()).toEqual(["offline"]);
    failed.loop.refresh();
    await flush();
    expect(count(PLAYLIST)).toBe(1);
    expect(failed.hand.count).toBe(1);
  });

  it("when the wall is up, reads at once, replaces the pending poll with a new one (never two chains) and leaves the claim alone", async () => {
    stubFetch({ [CLAIM]: [204], [PLAYLIST]: [good(), good(), good(), good()] });
    const handle = holdSecret(SECRET)!;
    const release = vi.spyOn(handle, "release");
    const r = await rig(handle);
    expect(r.kinds()).toEqual(["connected"]);
    expect(r.hand.count).toBe(1);

    r.loop.refresh();
    await flush();
    expect(count(PLAYLIST)).toBe(2);
    expect(r.kinds()).toEqual(["connected", "connected"]);
    expect(r.hand.count, "the old poll timer was cleared").toBe(1);
    await r.advance(MINUTE - 1);
    expect(count(PLAYLIST)).toBe(2);
    await r.advance(1);
    expect(count(PLAYLIST)).toBe(3);
    expect(r.hand.count).toBe(1);

    expect(count(CLAIM)).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(handle.secret()).toBeNull();
    expect(JSON.stringify(calls.slice(1)).includes(SECRET)).toBe(false);
    expect(calls.slice(1).every((call) => call.init.body === undefined)).toBe(true);
  });

  it("reads at once while the wall retries a failed read (the answer is a wake or a 404 and the server may be back)", async () => {
    stubFetch({ [PLAYLIST]: [good(), "network", good()] });
    const r = await rig(null, { random: () => 0 });
    await r.advance(MINUTE);
    expect(r.kinds()).toEqual(["connected"]);
    expect(r.delays.at(-1)).toBe(5_000);
    r.loop.refresh();
    await flush();
    expect(count(PLAYLIST)).toBe(3);
    expect(r.kinds()).toEqual(["connected", "connected"]);
    expect(r.hand.count).toBe(1);
    expect(r.delays.at(-1)).toBe(MINUTE);
  });

  it("does nothing while the screen is revoked, and a failed read in between does not change that", async () => {
    stubFetch({ [PLAYLIST]: [good(), 401, "network", revokedLink] });
    const r = await rig(null, { random: () => 0 });
    await r.advance(MINUTE);
    expect(r.kinds()).toEqual(["connected", "revoked"]);
    r.loop.refresh();
    await flush();
    expect(count(PLAYLIST)).toBe(2);
    expect(r.hand.count).toBe(1);
    expect(r.delays.at(-1)).toBe(5 * MINUTE);
    await r.advance(5 * MINUTE); // "network": silent, the sentence stays
    expect(r.kinds()).toEqual(["connected", "revoked"]);
    r.loop.refresh();
    await flush();
    expect(count(PLAYLIST)).toBe(3);
  });

  it("does nothing during a Retry-After wait, and works again after it", async () => {
    stubFetch({ [PLAYLIST]: [good(), tooMany("30"), good(), good()] });
    const r = await rig();
    await r.advance(MINUTE);
    expect(count(PLAYLIST)).toBe(2);
    expect(r.delays.at(-1)).toBe(30_000);
    r.loop.refresh();
    await flush();
    expect(count(PLAYLIST)).toBe(2);
    await r.advance(29_999);
    r.loop.refresh();
    await flush();
    expect(count(PLAYLIST)).toBe(2);
    await r.advance(1);
    expect(count(PLAYLIST)).toBe(3);
    r.loop.refresh();
    await flush();
    expect(count(PLAYLIST)).toBe(4);
  });

  it("does nothing while a read is in flight", async () => {
    const wait = hung();
    stubFetch({ [PLAYLIST]: [good(), wait.entry, good()] });
    const r = await rig();
    await r.advance(MINUTE);
    expect(count(PLAYLIST)).toBe(2);
    r.loop.refresh();
    await flush();
    expect(count(PLAYLIST)).toBe(2);
    wait.answer(good());
    await flush();
    expect(r.kinds()).toEqual(["connected", "connected"]);
    expect(r.hand.count).toBe(1);
    r.loop.refresh();
    await flush();
    expect(count(PLAYLIST)).toBe(3);
  });

  it("does nothing after stop(), and stop() still clears the timer", async () => {
    stubFetch({ [PLAYLIST]: [good()] });
    const r = await rig();
    r.loop();
    expect(r.hand.count).toBe(0);
    r.loop.refresh();
    await flush();
    expect(count(PLAYLIST)).toBe(1);
    expect(r.hand.count).toBe(0);
  });

  it("an answer that arrives after stop() is ignored, and refresh() on a stopped loop starts nothing", async () => {
    const wait = hung();
    stubFetch({ [PLAYLIST]: [good(), wait.entry] });
    const r = await rig();
    await r.advance(MINUTE);
    r.loop();
    wait.answer(good());
    await flush();
    expect(r.kinds()).toEqual(["connected"]);
    r.loop.refresh();
    await flush();
    expect(count(PLAYLIST)).toBe(2);
    expect(r.hand.count).toBe(0);
  });
});

describe("the claim path (unchanged), now with a timeout", () => {
  /** A claim that never answers but ends when its signal does, as a real fetch does. */
  const neverAnswers = (init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("The operation timed out.", "TimeoutError")));
    });

  it("passes a 20 second timeout signal; when it fires the claim is unreachable, the secret is still in the handle and the next try sends it", async () => {
    const timeouts: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      timeouts.push(controller);
      return controller.signal;
    });
    stubFetch({ [CLAIM]: [neverAnswers, 204], [PLAYLIST]: [good()] });
    const handle = holdSecret(SECRET)!;
    const release = vi.spyOn(handle, "release");
    const r = await rig(handle);

    expect(timeout).toHaveBeenCalledWith(20_000);
    expect(calls[0].key).toBe(CLAIM);
    expect(calls[0].init.signal).toBe(timeouts[0].signal);
    expect(r.kinds()).toEqual([]);
    expect(handle.secret() === SECRET).toBe(true);

    timeouts[0].abort(); // the 20 seconds are over
    await flush();
    expect(r.kinds()).toEqual(["offline"]);
    expect(r.delays).toEqual([5_000]);
    expect(release).not.toHaveBeenCalled();
    expect(handle.secret() === SECRET).toBe(true);
    expect(claimMemoSnapshot(), "no answer, so the next try is made").toBeNull();
    expect(count(PLAYLIST)).toBe(0);

    await r.advance(5_000);
    expect(count(CLAIM)).toBe(2);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ secret: SECRET });
    expect(r.kinds()).toEqual(["offline", "connected"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(handle.secret()).toBeNull();
  });

  it("two starts of the screen share one claim and release the secret once", async () => {
    stubFetch({ [CLAIM]: [204], [PLAYLIST]: [good()] });
    const handle = holdSecret(SECRET)!;
    const release = vi.spyOn(handle, "release");
    const first = await rig(handle);
    const second = await rig(handle);
    expect(count(CLAIM)).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(first.kinds()).toEqual(["connected"]);
    expect(second.kinds()).toEqual(["connected"]);
    expect(handle.secret()).toBeNull();
  });
});
