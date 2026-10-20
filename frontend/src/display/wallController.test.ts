import type { WidgetData } from "../api/types";
import type { DisplayItem, DisplayPlaylist, DisplayWidget, WidgetReply } from "./displayApi";
import type { Timers } from "./displayLoop";
import { createWall, probeWall } from "./wallController";
import type { WallSnapshot } from "./wallTypes";

// The controller under a clock the test moves by hand and a fake `fetchWidget`. Every instant below is an offset from T0 (12:00:00 UTC), so the
// thresholds can be asserted to the second. `run` steps one second at a time (the tick's own period) and lets the promises settle after each step,
// so a request made by a tick is answered at that tick's instant.

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const FIGURES = { type: "stat", mode: "values", source: "energy", series: [], values: [] } as unknown as WidgetData;
const reply = (over: Partial<WidgetReply> = {}): WidgetReply => ({ status: 200, data: FIGURES, retryAfter: null, serverDate: null, ...over });
const settle = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };

function makeClock(start: number) {
  let now = start;
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

// ---- fixtures ----
const stat = (id: number, over: Partial<DisplayWidget> = {}): DisplayWidget => ({ id, type: "stat", title: `Card ${id}`, config: { source: "energy" }, x: 0, y: 0, w: 3, h: 2, ...over });
const text = (id: number): DisplayWidget => stat(id, { type: "text", config: { style: "heading", text: "Hello" } });
const dash = (id: number, widgets: DisplayWidget[]) => ({ id, name: `Dashboard ${id}`, range: "today", widgets });
const item = (id: number, over: Partial<DisplayItem> = {}): DisplayItem => ({
  id, seconds: 20, skipped: null, focus: null, dashboard: dash(id, [stat(id * 10 + 1), stat(id * 10 + 2)]), ...over,
});
const skipped = (id: number) => item(id, { skipped: "dashboard_deleted", dashboard: null });
const textItem = (id: number) => item(id, { dashboard: dash(id, [text(id * 10 + 1)]) });
const list = (items: DisplayItem[], over: Partial<DisplayPlaylist> = {}): DisplayPlaylist => ({
  display: { name: "Wall 1" },
  playlist: { name: "Wall A", items },
  site: { name: "Hall", timezone: "UTC" },
  build: "build-1",
  status: { collectorAlive: true, readingsFresh: true, lastReadingAgeSeconds: 5 },
  ...over,
});
const badStatus = (over: Partial<NonNullable<DisplayPlaylist["status"]>> = {}) => ({ collectorAlive: true, readingsFresh: true, lastReadingAgeSeconds: 5, ...over });
const EMPTY_SENTENCE = "Nothing to show. Every dashboard in playlist Wall A is skipped or the playlist is empty. An administrator can change it on the Displays page.";

interface Call { item: number; widget: number; at: number }
type Answer = WidgetReply | "network" | "hang";

function setup(options: { random?: number; respond?: (call: Call, n: number) => Answer; start?: boolean } = {}) {
  const clock = makeClock(T0);
  const calls: Call[] = [];
  const refreshes: number[] = [];
  const reloads: number[] = [];
  // `shift` is how far this machine's clock is from the test's true time: a dead clock battery starts it far behind, a network sync then jumps it.
  const state = { hidden: false, reduce: false, shift: 0, respond: options.respond ?? ((): Answer => reply()) };
  const wall = createWall({
    timers: clock.timers,
    now: () => clock.now() + state.shift,
    random: () => options.random ?? 0,
    fetchWidget: (itemId, widget) => {
      const call = { item: itemId, widget, at: clock.now() };
      calls.push(call);
      const answer = state.respond(call, calls.length);
      if (answer === "network") return Promise.reject(new TypeError("network"));
      if (answer === "hang") return new Promise<WidgetReply>(() => {});
      return Promise.resolve(answer);
    },
    refreshPlaylist: () => { refreshes.push(clock.now()); },
    reload: () => { reloads.push(clock.now()); },
    reduceMotion: () => state.reduce,
    isHidden: () => state.hidden,
  });
  if (options.start !== false) wall.start();
  return {
    clock, calls, refreshes, reloads, state, wall,
    local: () => clock.now() + state.shift,
    snap: (): WallSnapshot => wall.snapshot(),
    feed(playlist: DisplayPlaylist, dateShift = 0) { wall.feed(playlist, clock.now(), clock.now() + dateShift); },
    async run(ms: number) {
      await settle(); // answers that are already on their way arrive at the instant the call was made
      let left = ms;
      while (left > 0) {
        const step = Math.min(left, 1_000);
        clock.advance(step);
        left -= step;
        await settle();
      }
    },
    asks: (itemId: number, widget?: number) => calls.filter((call) => call.item === itemId && (widget === undefined || call.widget === widget)).map((call) => call.at - T0),
  };
}
type Rig = ReturnType<typeof setup>;
/** Every item id the snapshot shows from now on, and every phase. */
function watch(t: Rig) {
  const seen = { items: [] as number[], phases: [] as string[], count: 0 };
  t.wall.subscribe(() => {
    const snap = t.snap();
    seen.count += 1;
    seen.phases.push(snap.phase);
    if (snap.item !== null && seen.items[seen.items.length - 1] !== snap.item.id) seen.items.push(snap.item.id);
  });
  return seen;
}

describe("the first feed", () => {
  it("pins the first item at once with skeleton cards, then draws the figures", async () => {
    const t = setup();
    t.feed(list([item(1), item(2)]));
    const first = t.snap();
    expect(first.item?.id).toBe(1);
    expect(first.position).toEqual({ index: 1, of: 2 });
    expect(first.phase).toBe("in");
    expect(first.timezone).toBe("UTC");
    expect(Object.keys(first.cards)).toEqual(["11", "12"]);
    expect(first.cards[11]).toMatchObject({ status: "loading", data: null, answeredAt: null });
    expect(t.calls.map((call) => [call.item, call.widget])).toEqual([[1, 11], [1, 12]]);
    await settle();
    expect(t.snap().cards[11]).toMatchObject({ status: "ok", data: FIGURES, answeredAt: T0, failingSince: null, notUpdated: false });
    expect(t.snap().updatedAt).toBe(T0);
  });

  it("never asks for a text widget or an unknown type, and gives them no card", async () => {
    const t = setup();
    t.feed(list([item(1, { dashboard: dash(1, [stat(11), text(12), stat(13, { type: "mystery" })]) })]));
    await settle();
    expect(t.calls.map((call) => call.widget)).toEqual([11]);
    expect(Object.keys(t.snap().cards)).toEqual(["11"]);
  });

  it("holds the empty sentence before any feed, and nothing runs before start()", async () => {
    const t = setup({ start: false });
    expect(t.snap()).toMatchObject({ item: null, position: null, emptyText: null, band: null, updatedAt: null, phase: "in" });
    t.feed(list([item(1)]));
    await t.run(60_000);
    expect(t.calls).toEqual([]);
    expect(t.clock.pending).toBe(0);
    t.wall.start();
    expect(t.calls).toHaveLength(2);
    await t.run(1_000);
    expect(t.snap().cards[11].status).toBe("ok");
  });
});

describe("rotation", () => {
  it("rotates two items at 20 s, asking for the second 8 s before its turn", async () => {
    const t = setup();
    const seen = watch(t);
    t.feed(list([item(1), item(2)]));
    await t.run(11_000);
    expect(t.asks(2)).toEqual([]);
    await t.run(1_000);
    expect(t.asks(2)).toEqual([12_000, 12_000]);
    await t.run(7_000); // 19 s
    expect(t.snap().item?.id).toBe(1);
    expect(t.snap().phase).toBe("in");
    await t.run(1_000); // 20 s: the fade starts, the item is still the old one
    expect(t.snap()).toMatchObject({ phase: "out" });
    expect(t.snap().item?.id).toBe(1);
    await t.run(1_000); // 150 ms later the item changes
    expect(t.snap().item?.id).toBe(2);
    expect(t.snap().phase).toBe("in");
    expect(t.snap().position).toEqual({ index: 2, of: 2 });
    expect(t.snap().cards[21]).toMatchObject({ status: "ok", answeredAt: T0 + 12_000 }); // the prefetched answer, no skeleton
    expect(seen.phases).toContain("out");
  });

  it("comes back to the first item at 40 s and asks again for the cards that are 30 s old", async () => {
    const t = setup();
    t.feed(list([item(1), item(2)]));
    await t.run(42_000);
    expect(t.snap().item?.id).toBe(1);
    expect(t.asks(1)).toEqual([0, 0, 33_000, 33_000]); // prefetched at 33 s (8 s before the turn at 40.15 s), when its kept answer is 33 s old
  });

  it("swaps a slow target 5 s after the turn, and draws its card as a skeleton", async () => {
    const t = setup({ respond: (call) => (call.item === 2 ? "hang" : reply()) });
    t.feed(list([item(1), item(2)]));
    await t.run(24_000);
    expect(t.snap().item?.id).toBe(1);
    expect(t.snap().phase).toBe("in");
    await t.run(1_000);
    expect(t.snap().phase).toBe("out");
    await t.run(1_000);
    expect(t.snap().item?.id).toBe(2);
    expect(t.snap().cards[21]).toMatchObject({ status: "loading", data: null });
  });

  it("swaps at the turn when the target's cards failed: a failure counts as an answer", async () => {
    const t = setup({ respond: (call) => (call.item === 2 ? "network" : reply()) });
    t.feed(list([item(1), item(2)]));
    await t.run(20_000);
    expect(t.snap().phase).toBe("out");
    await t.run(1_000);
    expect(t.snap().item?.id).toBe(2);
    expect(t.snap().cards[21].status).toBe("loading");
  });

  it("counts positions among the shown items only, and never pins a skipped item", async () => {
    const t = setup();
    const seen = watch(t);
    t.feed(list([item(1), skipped(2), item(3)]));
    expect(t.snap().position).toEqual({ index: 1, of: 2 });
    await t.run(21_000);
    expect(t.snap().item?.id).toBe(3);
    expect(t.snap().position).toEqual({ index: 2, of: 2 });
    await t.run(100_000);
    expect(new Set(seen.items)).toEqual(new Set([1, 3]));
  });

  it("uses a short item's seconds: an item of 6 s is asked for at once and swaps at 6 s", async () => {
    const t = setup();
    t.feed(list([item(1, { seconds: 6 }), item(2)]));
    await t.run(1_000);
    expect(t.asks(2)).toEqual([1_000, 1_000]);
    await t.run(5_000);
    expect(t.snap().phase).toBe("out");
    await t.run(1_000);
    expect(t.snap().item?.id).toBe(2);
  });

  it("with one shown item never swaps, and keeps refreshing its cards every 30 s", async () => {
    const t = setup();
    const seen = watch(t);
    t.feed(list([item(1), skipped(2)]));
    const first = t.snap().item;
    await t.run(300_000);
    expect(t.snap().item).toBe(first);
    expect(seen.phases).not.toContain("out");
    expect(t.asks(1, 11)).toEqual(Array.from({ length: 11 }, (_, n) => n * 30_000));
    expect(t.snap().position).toEqual({ index: 1, of: 1 });
  });

  it("asks a comparison card only every 60 s", async () => {
    const t = setup();
    t.feed(list([item(1, { dashboard: dash(1, [stat(11), stat(12, { config: { source: "energy", compare: "same_days_last_month" } })]) })]));
    await t.run(125_000);
    expect(t.asks(1, 11)).toEqual([0, 30_000, 60_000, 90_000, 120_000]);
    expect(t.asks(1, 12)).toEqual([0, 60_000, 120_000]);
  });

  it("keeps the same item object while the feeds say nothing changed", async () => {
    const t = setup();
    t.feed(list([item(1)]));
    const pinned = t.snap().item;
    t.feed(list([item(1)]));
    t.feed(list([item(1)]));
    expect(t.snap().item).toBe(pinned);
    expect(t.snap().phase).toBe("in");
  });
});

describe("edits, deletions and skips of the pinned item", () => {
  const edited = (id = 1) => item(id, { dashboard: dash(id, [stat(id * 10 + 21), stat(id * 10 + 22)]) });

  it("an edit of the only item swaps at once through a fade, with its new cards", async () => {
    const t = setup();
    const seen = watch(t);
    t.feed(list([item(1)]));
    await settle();
    t.feed(list([edited()]));
    expect(t.snap().item?.dashboard?.widgets[0].id).toBe(11); // still the old one until the new one has its figures
    expect(t.asks(1, 31)).toEqual([0]);
    await settle();
    await t.run(1_000);
    expect(t.snap().phase).toBe("out");
    await t.run(1_000);
    expect(t.snap().item?.dashboard?.widgets[0].id).toBe(31);
    expect(Object.keys(t.snap().cards)).toEqual(["31", "32"]);
    expect(t.snap().cards[31].status).toBe("ok");
    expect(t.snap().phase).toBe("in");
    expect(seen.phases).toContain("out");
  });

  it("an edit of the pinned item among three swaps at once with a fade", async () => {
    const t = setup();
    const seen = watch(t);
    t.feed(list([item(1), item(2), item(3)]));
    await t.run(3_000);
    t.feed(list([edited(1), item(2), item(3)]));
    await t.run(2_000);
    expect(t.snap().item?.dashboard?.widgets[0].id).toBe(31);
    expect(t.snap().position).toEqual({ index: 1, of: 3 });
    expect(seen.phases).toContain("out");
    await t.run(60_000);
    expect(new Set(seen.items)).toEqual(new Set([1, 2, 3])); // the rotation goes on through all three
  });

  it("a deleted pinned item among two goes to the other one at once", async () => {
    const t = setup();
    t.feed(list([item(1), item(2)]));
    await t.run(3_000);
    t.feed(list([item(2)]));
    await t.run(1_000);
    expect(t.snap().phase).toBe("out");
    await t.run(1_000);
    expect(t.snap().item?.id).toBe(2);
    expect(t.snap().position).toEqual({ index: 1, of: 1 });
    expect(t.snap().emptyText).toBeNull();
  });

  it("a pinned item that became skipped goes to the next shown item at once", async () => {
    const t = setup();
    t.feed(list([item(1), item(2), item(3)]));
    await t.run(3_000);
    t.feed(list([skipped(1), item(2), item(3)]));
    await t.run(2_000);
    expect(t.snap().item?.id).toBe(2);
    expect(t.snap().position).toEqual({ index: 1, of: 2 });
  });

  it("a deleted only item shows the empty sentence at once and asks for nothing more", async () => {
    const t = setup();
    t.feed(list([item(1)]));
    await settle();
    const asked = t.calls.length;
    t.feed(list([]));
    expect(t.snap()).toMatchObject({ item: null, position: null, emptyText: EMPTY_SENTENCE });
    expect(t.snap().cards).toEqual({});
    await t.run(300_000);
    expect(t.calls).toHaveLength(asked);
  });

  it("shows the same sentence for a playlist whose every dashboard is skipped, and pins again when an item returns", async () => {
    const t = setup();
    t.feed(list([skipped(1), skipped(2)]));
    expect(t.snap()).toMatchObject({ item: null, emptyText: EMPTY_SENTENCE });
    expect(t.calls).toEqual([]);
    t.feed(list([skipped(1), item(2)]));
    expect(t.snap()).toMatchObject({ emptyText: null });
    expect(t.snap().item?.id).toBe(2);
  });

  it("an item with a dashboard that has no widget is not shown", () => {
    const t = setup();
    t.feed(list([item(1, { dashboard: dash(1, []) })]));
    expect(t.snap().emptyText).toBe(EMPTY_SENTENCE);
  });

  it("changing the seconds of the pinned item is an edit too (it fades into itself)", async () => {
    const t = setup();
    t.feed(list([item(1)]));
    await settle();
    t.feed(list([item(1, { seconds: 40 })]));
    await t.run(2_000);
    expect(t.snap().item?.seconds).toBe(40);
  });
});

describe("a 404: the playlist moved", () => {
  it("re-reads the playlist once, keeps the card's figures, marks no failure and does not loop", async () => {
    const t = setup();
    t.feed(list([item(1)]));
    await settle();
    t.state.respond = (call) => (call.widget === 11 ? reply({ status: 404, data: null }) : reply());
    await t.run(30_000);
    expect(t.refreshes).toEqual([T0 + 30_000]);
    expect(t.snap().cards[11]).toMatchObject({ status: "ok", data: FIGURES, answeredAt: T0, failingSince: null, notUpdated: false });
    const asked = t.asks(1, 11).length;
    await t.run(5 * 60_000);
    expect(t.asks(1, 11)).toHaveLength(asked); // a moved card is not asked again before a feed
    expect(t.refreshes).toHaveLength(1);
    expect(t.snap().cards[11].failingSince).toBeNull();
    expect(t.snap().band).toBeNull();
  });

  it("asks for the playlist at most once in 10 s however many cards or feeds say 404", async () => {
    const t = setup();
    t.feed(list([item(1)]));
    await settle();
    t.state.respond = () => reply({ status: 404, data: null });
    await t.run(30_000); // both cards moved at 30 s: one re-read
    expect(t.refreshes).toEqual([T0 + 30_000]);
    await t.run(5_000);
    t.feed(list([item(1)])); // a feed that still lists them: asked again at the next tick, 404 again, 6 s after the last re-read
    await t.run(1_000);
    expect(t.refreshes).toEqual([T0 + 30_000]);
    await t.run(5_000);
    t.feed(list([item(1)]));
    await t.run(1_000);
    expect(t.refreshes).toEqual([T0 + 30_000, T0 + 42_000]);
  });

  it("does not re-read when the newest playlist no longer lists the widget (it was edited), and the card keeps drawing", async () => {
    const t = setup({ respond: (call) => (call.widget === 31 ? "hang" : reply()) });
    t.feed(list([item(1)]));
    await settle();
    await t.run(28_000);
    t.feed(list([item(1, { dashboard: dash(1, [stat(31)]) })])); // the edit; the new card never answers, so the old item stays 5 s
    t.state.respond = (call) => (call.widget === 31 ? "hang" : reply({ status: 404, data: null }));
    await t.run(2_000); // 30 s: the old cards are due and answer 404
    expect(t.asks(1, 11)).toContain(30_000);
    expect(t.refreshes).toEqual([]);
    expect(t.snap().cards[11]).toMatchObject({ status: "ok", data: FIGURES });
  });
});

describe("failures, 401 and refused cards", () => {
  it("tags a card 'not updated' only once its own failures are 120 s old, and keeps its figures", async () => {
    const t = setup();
    t.feed(list([item(1)]));
    await settle();
    t.state.respond = (call) => (call.widget === 11 ? "network" : reply());
    await t.run(30_000);
    expect(t.snap().cards[11]).toMatchObject({ status: "ok", data: FIGURES, failingSince: T0 + 30_000, notUpdated: false });
    await t.run(119_000); // 149 s: 119 s of failing
    expect(t.snap().cards[11].notUpdated).toBe(false);
    await t.run(1_000);
    expect(t.snap().cards[11]).toMatchObject({ notUpdated: true, status: "ok", data: FIGURES, failingSince: T0 + 30_000 });
    expect(t.snap().cards[12]).toMatchObject({ notUpdated: false, failingSince: null });
  });

  it("a card that never answered and fails is an error, not a skeleton for ever", async () => {
    const t = setup({ respond: () => "network" });
    t.feed(list([item(1)]));
    await settle();
    expect(t.snap().cards[11]).toMatchObject({ status: "error", data: null, failingSince: T0 });
  });

  it("clears the failure with the next good answer", async () => {
    const t = setup();
    t.feed(list([item(1)]));
    await settle();
    t.state.respond = () => "network";
    await t.run(30_000);
    expect(t.snap().cards[11].failingSince).not.toBeNull();
    t.state.respond = () => reply();
    await t.run(120_000);
    expect(t.snap().cards[11]).toMatchObject({ failingSince: null, notUpdated: false, status: "ok" });
  });

  it("on a 401 reports the failure and asks for the playlist, at most once in 10 s", async () => {
    const t = setup();
    t.feed(list([item(1)]));
    await settle();
    t.state.respond = () => reply({ status: 401, data: null });
    await t.run(120_000);
    expect(t.refreshes.length).toBeGreaterThanOrEqual(3);
    for (let at = 1; at < t.refreshes.length; at += 1) expect(t.refreshes[at] - t.refreshes[at - 1]).toBeGreaterThanOrEqual(10_000);
    expect(t.snap().cards[11].failingSince).toBe(T0 + 30_000);
  });

  it("makes a card the server refuses (409) unavailable and asks again only after 10 minutes", async () => {
    const t = setup({ respond: (call) => (call.widget === 11 ? reply({ status: 409, data: null }) : reply()) });
    t.feed(list([item(1)]));
    await settle();
    expect(t.snap().cards[11]).toMatchObject({ status: "unavailable", data: null, answeredAt: null, failingSince: null, notUpdated: false });
    await t.run(599_000);
    expect(t.asks(1, 11)).toEqual([0]);
    expect(t.refreshes).toEqual([]);
    await t.run(1_000);
    expect(t.asks(1, 11)).toEqual([0, 600_000]);
    expect(t.snap().cards[11].status).toBe("unavailable");
    expect(t.snap().cards[12].status).toBe("ok");
  });

  it("keeps a refused card unavailable when its item comes round again (no new request inside the 10 minutes)", async () => {
    const t = setup({ respond: (call) => (call.widget === 11 ? reply({ status: 422, data: null }) : reply()) });
    t.feed(list([item(1), item(2)]));
    await t.run(43_000);
    expect(t.snap().item?.id).toBe(1);
    expect(t.snap().cards[11].status).toBe("unavailable");
    expect(t.asks(1, 11)).toEqual([0]);
  });
});

describe("the bands", () => {
  it("shows the screen band after 120 s without a card answer, never inside 119 s, and clears it with an answer", async () => {
    const t = setup();
    t.feed(list([item(1)]));
    await settle();
    t.state.respond = () => "network";
    await t.run(119_000);
    expect(t.snap().band).toBeNull();
    await t.run(1_000);
    expect(t.snap().band).toEqual({ kind: "screen", text: "This screen has not been updated since 12:00. Trying again..." });
    t.state.respond = () => reply();
    await t.run(70_000); // the queue's backoff is at most 60 s
    expect(t.snap().band).toBeNull();
  });

  it("a widget-only outage (the playlist is fine) shows the screen band and the card tags", async () => {
    const t = setup();
    t.feed(list([item(1)]));
    await settle();
    t.state.respond = () => "network";
    await t.run(60_000);
    t.feed(list([item(1)])); // a playlist success does not clear it: the cards are what the screen is for
    await t.run(60_000);
    t.feed(list([item(1)]));
    expect(t.snap().band?.kind).toBe("screen");
    await t.run(30_000);
    expect(t.snap().cards[11].notUpdated).toBe(true);
    expect(t.snap().cards[12].notUpdated).toBe(true);
    expect(t.snap().band?.kind).toBe("screen");
  });

  it("for an item with no data card counts from the last playlist read: a feed clears the band", async () => {
    const t = setup();
    t.feed(list([textItem(1)]));
    await t.run(119_000);
    expect(t.snap().band).toBeNull();
    await t.run(1_000);
    expect(t.snap().band?.kind).toBe("screen");
    t.feed(list([textItem(1)]));
    expect(t.snap().band).toBeNull();
  });

  it("holds the screen band back for 10 s after a wake()", async () => {
    const t = setup();
    t.feed(list([item(1)]));
    await settle();
    t.state.respond = () => "network";
    await t.run(119_000);
    t.wall.wake();
    expect(t.refreshes).toEqual([T0 + 119_000]);
    await t.run(9_000);
    expect(t.snap().band).toBeNull();
    await t.run(1_000);
    expect(t.snap().band?.kind).toBe("screen");
  });

  it("raises the collector band only after two feeds at least 50 s apart say it is down, and clears it with a good feed", async () => {
    const t = setup();
    const down = list([item(1)], { status: badStatus({ collectorAlive: false }) });
    t.feed(down);
    expect(t.snap().band).toBeNull();
    await t.run(10_000);
    t.feed(down);
    expect(t.snap().band).toBeNull(); // two reads 10 s apart: never cry wolf
    await t.run(50_000);
    t.feed(down);
    expect(t.snap().band).toEqual({ kind: "collector", text: "The data collector stopped." });
    t.feed(list([item(1)]));
    expect(t.snap().band).toBeNull();
  });

  it("starts the collector count again after a good read", async () => {
    const t = setup();
    const down = list([item(1)], { status: badStatus({ collectorAlive: false }) });
    t.feed(down);
    await t.run(30_000);
    t.feed(list([item(1)]));
    await t.run(30_000);
    t.feed(down);
    expect(t.snap().band).toBeNull();
    await t.run(60_000);
    t.feed(down);
    expect(t.snap().band?.kind).toBe("collector");
  });

  it("says when the readings stopped and keeps that time while the band stays", async () => {
    const t = setup();
    t.feed(list([item(1)], { status: badStatus({ readingsFresh: false, lastReadingAgeSeconds: 600 }) }));
    expect(t.snap().band).toEqual({ kind: "readings", text: "Readings stopped arriving at 11:50." });
    await t.run(60_000);
    t.feed(list([item(1)], { status: badStatus({ readingsFresh: false, lastReadingAgeSeconds: 660 }) }));
    expect(t.snap().band?.text).toBe("Readings stopped arriving at 11:50.");
    t.feed(list([item(1)]));
    expect(t.snap().band).toBeNull();
    t.feed(list([item(1)], { status: badStatus({ readingsFresh: false, lastReadingAgeSeconds: 120 }) })); // fixed again at 12:01 - 2 minutes
    expect(t.snap().band?.text).toBe("Readings stopped arriving at 11:59.");
  });

  it("leaves the time out when the age is under 60 s or unknown, and shows nothing when nothing was ever read", () => {
    const t = setup();
    t.feed(list([item(1)], { status: badStatus({ readingsFresh: false, lastReadingAgeSeconds: 30 }) }));
    expect(t.snap().band?.text).toBe("Readings stopped arriving.");
    t.feed(list([item(1)], { status: badStatus({ readingsFresh: true }) }));
    t.feed(list([item(1)], { status: badStatus({ readingsFresh: false, lastReadingAgeSeconds: null }) }));
    expect(t.snap().band?.text).toBe("Readings stopped arriving.");
    t.feed(list([item(1)], { status: badStatus({ readingsFresh: null, lastReadingAgeSeconds: null }) }));
    expect(t.snap().band).toBeNull();
    t.feed(list([item(1)], { status: null }));
    expect(t.snap().band).toBeNull();
  });

  it("shows one band: the screen over the collector over the readings", async () => {
    const t = setup();
    const bad = list([item(1)], { status: badStatus({ collectorAlive: false, readingsFresh: false, lastReadingAgeSeconds: 600 }) });
    t.feed(bad);
    expect(t.snap().band?.kind).toBe("readings");
    await settle();
    t.state.respond = () => "network";
    await t.run(60_000);
    t.feed(bad);
    expect(t.snap().band?.kind).toBe("collector");
    await t.run(60_000);
    expect(t.snap().band?.kind).toBe("screen");
  });
});

describe("the clock", () => {
  it("takes the server's clock from a Date header 3 hours ahead", async () => {
    const t = setup();
    const ahead = 3 * 3_600_000;
    t.feed(list([item(1)]), ahead);
    expect(t.snap().now).toBe(T0 + ahead);
    await settle();
    expect(t.snap().cards[11].answeredAt).toBe(T0 + ahead);
    expect(t.snap().updatedAt).toBe(T0 + ahead);
    await t.run(30_000);
    expect(t.snap().cards[11].answeredAt).toBe(T0 + ahead + 30_000);
  });

  it("learns the offset from a widget answer too", async () => {
    const t = setup({ respond: () => reply({ serverDate: T0 + 3_600_000 }) });
    t.feed(list([item(1)]));
    await settle();
    expect(t.snap().cards[11].answeredAt).toBe(T0 + 3_600_000);
  });

  it("ignores a change of 2 s or less, and a missing Date", async () => {
    const t = setup();
    t.feed(list([item(1)]), 1_500);
    await settle();
    expect(t.snap().cards[11].answeredAt).toBe(T0);
    t.wall.feed(list([item(1)]), t.clock.now(), null);
    expect(t.snap().cards[11].answeredAt).toBe(T0);
  });

  it("advances 'now' only when the clock minute changes, and never shows 'updated' after it", async () => {
    const t = setup();
    t.feed(list([textItem(1)]));
    const first = t.snap();
    await t.run(59_000);
    expect(t.snap()).toBe(first);
    await t.run(2_000);
    expect(t.snap()).not.toBe(first);
    expect(t.snap().now).toBe(T0 + 60_000);
    const t2 = setup();
    t2.feed(list([item(1)]));
    for (let step = 0; step < 200; step += 1) {
      await t2.run(1_000);
      const snap = t2.snap();
      if (snap.updatedAt !== null) expect(snap.updatedAt).toBeLessThanOrEqual(snap.now);
    }
  });

  it("updatedAt is the oldest answer among the cards", async () => {
    const failing = new Set<number>();
    const t = setup({ respond: (call) => (failing.has(call.widget) ? "network" : reply()) });
    t.feed(list([item(1)]));
    await settle();
    failing.add(12);
    await t.run(100_000);
    const during = t.snap();
    expect(during.cards[12].answeredAt).toBe(T0);
    expect(during.cards[11].answeredAt).toBeGreaterThan(T0 + 30_000);
    expect(during.updatedAt).toBe(T0);
    failing.clear();
    await t.run(70_000);
    const after = t.snap();
    const oldest = Math.min(after.cards[11].answeredAt as number, after.cards[12].answeredAt as number);
    expect(after.updatedAt).toBe(Math.min(oldest, after.now));
    expect(oldest).toBeGreaterThan(T0 + 90_000);
  });
});

describe("the snapshot", () => {
  it("is the same object until something visible changed, and cards keep their identity until they change", async () => {
    const t = setup();
    const heard: number[] = [];
    t.wall.subscribe(() => heard.push(1));
    t.feed(list([item(1, { dashboard: dash(1, [stat(11), stat(12, { config: { source: "energy", compare: "same_days_last_month" } })]) })]));
    await settle();
    const first = t.snap();
    const count = heard.length;
    await t.run(29_000);
    expect(t.snap()).toBe(first);
    expect(heard).toHaveLength(count);
    await t.run(1_000); // 30 s: card 11 is asked again, card 12 (a comparison) is not
    const next = t.snap();
    expect(next).not.toBe(first);
    expect(next.cards).not.toBe(first.cards);
    expect(next.cards[12]).toBe(first.cards[12]);
    expect(next.cards[11]).not.toBe(first.cards[11]);
  });

  it("calls listeners after the change, never after stop(), and tells them at the next start()", async () => {
    const t = setup();
    let heard = 0;
    const off = t.wall.subscribe(() => { heard += 1; });
    t.feed(list([item(1)]));
    expect(heard).toBeGreaterThan(0);
    t.wall.stop();
    const before = heard;
    t.feed(list([item(1), item(2)]));
    expect(heard).toBe(before);
    expect(t.snap().position).toEqual({ index: 1, of: 2 });
    t.wall.start();
    expect(heard).toBe(before + 1);
    off();
    t.feed(list([item(1)]));
    expect(heard).toBe(before + 1);
  });
});

describe("wake, hidden, reduced motion, start and stop", () => {
  it("a wake asks for the playlist, forces the cards due and restarts the item's timer", async () => {
    const t = setup();
    t.feed(list([item(1), item(2)]));
    await t.run(10_000);
    const before = t.asks(1).length;
    t.wall.wake();
    expect(t.refreshes).toEqual([T0 + 10_000]);
    await t.run(1_000);
    expect(t.asks(1).length).toBe(before + 2); // both cards, 11 s old
    await t.run(10_000); // 21 s: the old turn (20 s) has passed, the restarted one (30 s) has not
    expect(t.snap().item?.id).toBe(1);
    expect(t.snap().phase).toBe("in");
    await t.run(9_000);
    expect(t.snap().phase).toBe("out");
  });

  it("while hidden asks for nothing and does not turn; wake() does nothing; unhiding and waking resumes", async () => {
    const t = setup();
    t.feed(list([item(1), item(2)]));
    await t.run(5_000);
    t.state.hidden = true;
    const asked = t.calls.length;
    await t.run(120_000);
    expect(t.calls).toHaveLength(asked);
    expect(t.snap().item?.id).toBe(1);
    t.wall.wake();
    expect(t.refreshes).toEqual([]);
    t.state.hidden = false;
    t.wall.wake();
    expect(t.refreshes).toHaveLength(1);
    await t.run(1_000);
    expect(t.calls.length).toBeGreaterThan(asked); // the cards are due again
    await t.run(15_000);
    expect(t.snap().item?.id).toBe(1); // the turn restarted at the wake
    await t.run(6_000);
    expect(t.snap().item?.id).toBe(2);
  });

  it("with reduced motion swaps at the tick with no 'out' phase", async () => {
    const t = setup();
    t.state.reduce = true;
    const seen = watch(t);
    t.feed(list([item(1), item(2)]));
    await t.run(19_000);
    expect(t.snap().item?.id).toBe(1);
    await t.run(1_000);
    expect(t.snap().item?.id).toBe(2);
    expect(seen.phases).not.toContain("out");
    expect(t.clock.pending).toBe(1); // only the tick
  });

  it("stop() leaves no timer, asks for nothing, and start() carries on with the state kept", async () => {
    const t = setup();
    t.feed(list([item(1), item(2)]));
    await t.run(5_000);
    const pinned = t.snap().item;
    t.wall.stop();
    expect(t.clock.pending).toBe(0);
    const asked = t.calls.length;
    await t.run(600_000);
    expect(t.calls).toHaveLength(asked);
    expect(t.clock.pending).toBe(0);
    expect(t.snap().item).toBe(pinned);
    t.wall.start();
    t.wall.start();
    expect(t.clock.pending).toBe(1);
    await t.run(3_000);
    expect(t.calls.length).toBeGreaterThan(asked);
  });

  it("stop() in the middle of a fade does not leave the screen dark: the swap is decided again after start()", async () => {
    const t = setup();
    t.feed(list([item(1), item(2)]));
    await t.run(20_000);
    expect(t.snap().phase).toBe("out");
    t.wall.stop();
    expect(t.clock.pending).toBe(0);
    t.wall.start();
    await t.run(2_000);
    expect(t.snap().item?.id).toBe(2);
    expect(t.snap().phase).toBe("in");
  });

  it("starts after stop() with the queue running even when it was stopped while hidden", async () => {
    const t = setup();
    t.state.hidden = true;
    t.feed(list([item(1)]));
    await t.run(2_000);
    t.wall.stop();
    t.state.hidden = false;
    t.wall.start();
    await t.run(2_000);
    expect(t.snap().cards[11].status).toBe("ok");
  });
});

describe("a new build", () => {
  const withBuild = (build: string | null, items = [item(1)]) => list(items, { build });

  it("with one item reloads at the turn once the 10 s wait is over, and not twice inside 10 s", async () => {
    const t = setup(); // random 0: a wait of 10 s
    t.feed(withBuild("a"));
    await t.run(30_000);
    t.feed(withBuild("b")); // seen at 30 s; the item's turns are at 20 s, 40 s ...
    await t.run(9_000);
    expect(t.reloads).toEqual([]);
    await t.run(1_000); // 40 s: the turn, and the 10 s are over
    expect(t.reloads).toEqual([T0 + 40_000]);
    await t.run(9_000);
    expect(t.reloads).toHaveLength(1);
  });

  it("waits the jittered delay: 30 s with the largest jitter", async () => {
    const t = setup({ random: 0.999999 });
    t.feed(withBuild("a"));
    t.feed(withBuild("b"));
    await t.run(29_000);
    expect(t.reloads).toEqual([]);
    await t.run(2_000);
    expect(t.reloads).toHaveLength(1);
    expect(t.reloads[0] - T0).toBeGreaterThanOrEqual(30_000 - 1_000);
  });

  it("does not swap while it waits, reloads at the swap that was about to happen, then carries on", async () => {
    const t = setup(); // 10 s
    t.feed(withBuild("a", [item(1), item(2)]));
    await t.run(5_000);
    t.feed(withBuild("b", [item(1), item(2)])); // seen at 5 s, the wait ends at 15 s
    await t.run(15_000); // 20 s: the swap is due, and the wait is over
    expect(t.reloads).toEqual([T0 + 20_000]);
    expect(t.snap().item?.id).toBe(1);
    expect(t.snap().phase).toBe("in");
    await t.run(2_000); // the reload is on its way (or declined): rotation goes on
    expect(t.snap().item?.id).toBe(2);
  });

  it("holds the swap while the wait runs (the old build keeps drawing)", async () => {
    const t = setup({ random: 0.9 }); // 28 s
    t.feed(withBuild("a", [item(1), item(2)]));
    t.feed(withBuild("b", [item(1), item(2)]));
    await t.run(27_000);
    expect(t.snap().item?.id).toBe(1);
    expect(t.reloads).toEqual([]);
    await t.run(1_000);
    expect(t.reloads).toEqual([T0 + 28_000]);
  });

  it("never reloads for dev to dev, or when the build did not change", async () => {
    const t = setup();
    t.feed(withBuild("dev"));
    t.feed(withBuild("dev"));
    await t.run(300_000);
    t.feed(withBuild("dev"));
    await t.run(300_000);
    expect(t.reloads).toEqual([]);
    const u = setup();
    u.feed(withBuild("a"));
    await u.run(120_000);
    u.feed(withBuild("a"));
    await u.run(120_000);
    u.feed(withBuild(null));
    await u.run(120_000);
    expect(u.reloads).toEqual([]);
  });

  it("reloads for a dev build that becomes a real one", async () => {
    const t = setup();
    t.feed(withBuild("dev"));
    t.feed(withBuild("b2"));
    await t.run(60_000);
    expect(t.reloads.length).toBeGreaterThan(0);
  });

  it("with nothing on screen reloads after the wait", async () => {
    const t = setup();
    t.feed(list([], { build: "a" }));
    await t.run(60_000);
    t.feed(list([], { build: "b" }));
    await t.run(9_000);
    expect(t.reloads).toEqual([]);
    await t.run(1_000);
    expect(t.reloads).toEqual([T0 + 70_000]);
  });
});

describe("a clock that jumps after a large offset was learned (a TV with a dead clock battery)", () => {
  const behind = 3 * 3_600_000;

  it("keeps rotating when the machine's clock syncs and a wake lands before the next Date header", async () => {
    const t = setup();
    t.state.shift = -behind; // the machine's clock is 3 hours behind the server's
    t.wall.feed(list([item(1), item(2)]), t.local(), T0);
    await settle();
    t.state.shift = 0; // the network sync: the machine is right now, the wall still adds the old offset (3 hours ahead)
    t.wall.wake(); // the heartbeat sees the jump
    t.wall.feed(list([item(1), item(2)]), t.local(), t.clock.now()); // the next read teaches the true offset
    await t.run(30_000);
    expect(t.snap().item?.id).toBe(2);
  });

  it("still reaches the build boundary of a single item after such a jump", async () => {
    const t = setup();
    t.state.shift = -behind;
    t.wall.feed(list([item(1)], { build: "a" }), t.local(), T0);
    await settle();
    t.state.shift = 0;
    await t.run(1_000); // the first tick with the old offset passes the item's turn
    t.wall.feed(list([item(1)], { build: "b" }), t.local(), t.clock.now());
    await t.run(40_000);
    expect(t.reloads.length).toBeGreaterThan(0);
    expect(t.reloads[0] - (T0 + 1_000)).toBeLessThanOrEqual(30_000);
  });

  it("does not hold the screen band back for the size of the jump", async () => {
    const t = setup();
    t.state.shift = -behind;
    t.wall.feed(list([item(1)]), t.local(), T0);
    await settle();
    t.state.shift = 0;
    t.wall.wake(); // hold until 10 s from the (wrong) present
    t.wall.feed(list([item(1)]), t.local(), t.clock.now());
    t.state.respond = () => "network";
    await t.run(131_000); // 120 s of silence plus the 10 s hold of the wake, not 3 hours
    expect(t.snap().band?.kind).toBe("screen");
  });
});

describe("a long run", () => {
  it("keeps what it holds bounded over 24 simulated hours and leaves one timer", { timeout: 120_000 }, async () => {
    const big = (id: number) => item(id, { dashboard: dash(id, [1, 2, 3, 4].map((n) => stat(id * 100 + n))) });
    const playlist = list([big(1), big(2), big(3)]);
    const t = setup();
    const seen = watch(t);
    t.feed(playlist);
    let worst = { kept: 0, queued: 0, moved: 0, unavailable: 0, waiting: 0 };
    let timers = 0;
    for (let second = 1; second <= 86_400; second += 1) {
      t.clock.advance(1_000);
      await settle();
      if (second % 60 === 0) t.feed(structuredClone(playlist)); // a real read is a fresh object each time
      const probe = probeWall(t.wall);
      worst = {
        kept: Math.max(worst.kept, probe.kept), queued: Math.max(worst.queued, probe.queued), moved: Math.max(worst.moved, probe.moved),
        unavailable: Math.max(worst.unavailable, probe.unavailable), waiting: Math.max(worst.waiting, probe.waiting),
      };
      timers = Math.max(timers, t.clock.pending);
    }
    expect(timers).toBeLessThanOrEqual(3);
    expect(worst.kept).toBeLessThanOrEqual(8); // two items of four widgets
    expect(worst.queued).toBeLessThanOrEqual(8);
    expect(worst.waiting).toBeLessThanOrEqual(4);
    expect(worst.moved + worst.unavailable).toBe(0);
    expect(seen.items.length).toBeGreaterThan(1000);
    expect(t.snap().band).toBeNull();
    t.wall.stop();
    expect(t.clock.pending).toBe(0);
  });
});
