import type { WidgetConfig, WidgetData } from "../api/types";
import type { DisplayItem, DisplayPlaylist, DisplayWidget } from "./displayApi";
import { createWidgetQueue, type QueueResult } from "./wallQueue";
import {
  FADE_HALF_MS, FETCH_AHEAD_MS, NOT_UPDATED_MS, REREAD_MIN_MS, SWAP_WAIT_MS, WAKE_HOLD_MS,
  bandFor, buildChanged, clockOffset, isDataWidget, itemsDiffer, nextShown, positionOf, readingsStoppedAt, refetchDue, reloadAllowed, shownItems,
} from "./wallRules";
import type { CardState, Wall, WallDeps, WallSnapshot } from "./wallTypes";

// The wall's state machine: which item is on screen, what each card shows, when to swap, which band to raise. No React, no DOM; the time comes
// only through `deps.timers` and `deps.now`, so a test moves a manual clock. One self-rescheduling tick of one second drives everything; the
// decisions compare SERVER-clock times (local time plus the offset the `Date` headers teach), so a TV with a dead clock battery is still right.

const TICK_MS = 1_000;
/** A card the server refuses (409 or 422) is asked about again this rarely. */
const UNAVAILABLE_RETRY_MS = 600_000;
/** A new build is acted on 10 to 30 s after it is first seen (it spreads ten screens). */
const BUILD_DELAY_MIN_MS = 10_000;
const BUILD_DELAY_SPREAD_MS = 20_000;

const LOADING: CardState = { status: "loading", data: null, answeredAt: null, failingSince: null, notUpdated: false };
const UNAVAILABLE: CardState = { status: "unavailable", data: null, answeredAt: null, failingSince: null, notUpdated: false };
const NO_CARDS: Readonly<Record<number, CardState>> = Object.freeze({});

interface Kept { data: WidgetData; answeredAt: number }
interface Target { item: DisplayItem; chosenAt: number; immediate: boolean }

const keyOf = (item: number, widget: number) => `${item}:${widget}`;
const itemOfKey = (key: string) => Number(key.slice(0, key.indexOf(":")));
const widgetOfKey = (key: string) => Number(key.slice(key.indexOf(":") + 1));

/** The widgets of an item whose figures the server computes (a text widget and an unknown type are drawn without a request). */
function dataWidgetsOf(item: DisplayItem | null): DisplayWidget[] {
  return item?.dashboard?.widgets.filter((widget) => isDataWidget(widget.type)) ?? [];
}
/** The stored config of a widget, or an empty one when the playlist carried none (the rules read `compare` from it). */
function configOf(widget: DisplayWidget): WidgetConfig {
  return (typeof widget.config === "object" && widget.config !== null ? widget.config : {}) as WidgetConfig;
}
function emptyTextFor(playlistName: string): string {
  return `Nothing to show. Every dashboard in playlist ${playlistName} is skipped or the playlist is empty. An administrator can change it on the Displays page.`;
}
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "";
  }
}

/** What a wall holds in its maps, for a test that watches it over a long run. */
export interface WallProbe { kept: number; queued: number; moved: number; unavailable: number; waiting: number }
const probes = new WeakMap<Wall, () => WallProbe>();
export function probeWall(wall: Wall): WallProbe {
  const probe = probes.get(wall);
  if (probe === undefined) throw new Error("not a wall made by createWall");
  return probe();
}

export function createWall(deps: WallDeps): Wall {
  const { timers, fetchWidget, refreshPlaylist, reload, reduceMotion, isHidden } = deps;
  const localNow = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;

  // Lifecycle.
  let running = false; // between start() and stop()
  let stopped = false; // after a stop(): listeners hear nothing until the next start()
  let missed = false; // something changed while stopped: tell the listeners at the next start()
  let tickHandle: unknown = null;
  let fadeHandle: unknown = null;
  let queuePaused = true;

  // The clock: server time = local time + offset.
  let offset = 0;
  const serverNow = () => localNow() + offset;

  // What the server said last.
  let reply: DisplayPlaylist | null = null;
  let shown: DisplayItem[] = [];
  let emptyText: string | null = null;

  // What is on screen.
  let pinned: DisplayItem | null = null;
  let pinnedAt = 0; // server ms; the item's turn is pinnedAt + seconds
  let phase: "in" | "out" = "in";
  let cards: Readonly<Record<number, CardState>> = NO_CARDS;
  let target: Target | null = null;
  const waiting = new Set<string>(); // keys of the target the swap still waits for (no result yet)

  // Requests.
  const queued = new Set<string>(); // keys this controller put into the queue whose job is not done
  const kept = new Map<string, Kept>(); // the last answer of (item, widget), for the pinned, the target and the next item only
  const moved = new Set<string>(); // keys that answered 404 since the last feed: not asked again before a feed
  const unavailableUntil = new Map<string, number>(); // keys the server refused: not asked again before this server time
  let forceDue = false; // a wake: every pinned card is due at the next tick
  let lastRereadAt: number | null = null; // server ms of the last refreshPlaylist() this controller asked for
  let lastWakeAt: number | null = null; // server ms of the last wake that was acted on (a burst of events is one wake)

  // The honesty bands.
  let lastFeedAt: number | null = null; // server ms of the last playlist read
  let bandClock: number | null = null; // server ms of the last answer the screen band counts from (A3)
  let wakeHoldUntil = 0;
  let collectorRunStart: number | null = null;
  let collectorDownMs: number | null = null;
  let readingsStop: { at: number | null } | null = null; // fixed once when the readings band opens

  // A new build.
  let firstBuild: string | null = null;
  let buildSeenAt: number | null = null;
  let buildDelay = 0;
  let lastReloadAt: number | null = null;

  let snap: WallSnapshot = {
    item: null, position: null, phase: "in", cards: NO_CARDS, timezone: "", now: serverNow(), updatedAt: null, band: null, emptyText: null,
  };
  const listeners = new Set<() => void>();

  const queue = createWidgetQueue({ timers, now: localNow, random, fetchWidget, onResult });
  queue.pause(); // nothing is requested before start()

  // ---- the queue ----

  function ask(key: string, item: number, widget: number, urgent: boolean) {
    queued.add(key);
    queue.enqueue({ key, item, widget, urgent });
  }
  function pauseQueue() {
    if (!queuePaused) {
      queue.pause();
      queuePaused = true;
    }
  }
  function resumeQueue() {
    if (queuePaused) {
      queuePaused = false;
      queue.resume();
    }
  }
  /** Keys the controller may still want answers for: the pinned item's widgets and the target's. */
  function wantedKeys(): Set<string> {
    const wanted = new Set<string>();
    for (const item of [pinned, target?.item ?? null]) {
      for (const widget of dataWidgetsOf(item)) wanted.add(keyOf((item as DisplayItem).id, widget.id));
    }
    return wanted;
  }
  /** Cancels the jobs of items (or widgets) nobody draws or prefetches any more. */
  function dropUnwantedJobs() {
    const wanted = wantedKeys();
    for (const key of [...queued]) {
      if (wanted.has(key)) continue;
      queue.cancel(key);
      queued.delete(key);
      waiting.delete(key);
    }
  }
  function blockedKey(key: string, t: number): boolean {
    if (moved.has(key)) return true;
    const until = unavailableUntil.get(key);
    return until !== undefined && until > t;
  }
  /** The pinned item's due cards, urgent. */
  function requestPinned(t: number, force: boolean) {
    if (pinned === null) return;
    for (const widget of dataWidgetsOf(pinned)) {
      const key = keyOf(pinned.id, widget.id);
      if (blockedKey(key, t)) continue;
      const card = cards[widget.id] as CardState | undefined;
      if (force || refetchDue(configOf(widget), card?.answeredAt ?? null, t)) ask(key, pinned.id, widget.id, true);
    }
  }
  /** The target's cards that are not fresh from the last showing, not urgent; the swap waits for each of them to answer (or fail). */
  function prefetchTarget(t: number) {
    if (target === null) return;
    for (const widget of dataWidgetsOf(target.item)) {
      const key = keyOf(target.item.id, widget.id);
      if (blockedKey(key, t)) continue;
      if (!refetchDue(configOf(widget), kept.get(key)?.answeredAt ?? null, t)) continue;
      waiting.add(key);
      ask(key, target.item.id, widget.id, false);
    }
  }
  /** At most one refreshPlaylist() in 10 s (a clock that moved back does not hold it off). */
  function reread(t: number) {
    if (lastRereadAt !== null && t >= lastRereadAt && t - lastRereadAt < REREAD_MIN_MS) return;
    lastRereadAt = t;
    refreshPlaylist();
  }
  function newestLists(item: number, widget: number): boolean {
    return reply?.playlist.items.some((entry) => entry.id === item && (entry.dashboard?.widgets.some((w) => w.id === widget) ?? false)) ?? false;
  }

  // ---- cards ----

  function setCard(widget: number, state: CardState) {
    cards = { ...cards, [widget]: state };
  }
  /** What a card shows the moment its item is pinned: a kept answer, the refusal still in force, or the skeleton. */
  function initialCard(key: string, t: number): CardState {
    const until = unavailableUntil.get(key);
    if (until !== undefined) {
      if (until > t) return UNAVAILABLE;
      unavailableUntil.delete(key);
    }
    const old = kept.get(key);
    return old === undefined ? LOADING : { status: "ok", data: old.data, answeredAt: old.answeredAt, failingSince: null, notUpdated: false };
  }
  function refreshNotUpdated(t: number) {
    for (const [id, card] of Object.entries(cards)) {
      if (card.failingSince === null) continue;
      const flag = t - card.failingSince >= NOT_UPDATED_MS;
      if (flag !== card.notUpdated) setCard(Number(id), { ...card, notUpdated: flag });
    }
  }

  // ---- what is kept ----

  /** Kept answers only for the pinned item, the target and the next shown item, and only for (item, widget) pairs the newest playlist lists. */
  function pruneMaps() {
    const pairs = new Set<string>();
    for (const item of reply?.playlist.items ?? []) for (const widget of dataWidgetsOf(item)) pairs.add(keyOf(item.id, widget.id));
    const hold = new Set<number>();
    if (pinned !== null) {
      hold.add(pinned.id);
      const next = nextShown(shown, pinned.id);
      if (next !== null) hold.add(next.id);
    }
    if (target !== null) hold.add(target.item.id);
    for (const key of [...kept.keys()]) if (!pairs.has(key) || !hold.has(itemOfKey(key))) kept.delete(key);
    for (const key of [...unavailableUntil.keys()]) if (!pairs.has(key)) unavailableUntil.delete(key);
  }
  function forgetItem(id: number) {
    for (const key of [...kept.keys()]) if (itemOfKey(key) === id) kept.delete(key);
    for (const key of [...unavailableUntil.keys()]) if (itemOfKey(key) === id) unavailableUntil.delete(key);
  }

  // ---- rotation ----

  function pin(item: DisplayItem, t: number) {
    pinned = item;
    pinnedAt = t;
    target = null;
    waiting.clear();
    const next: Record<number, CardState> = {};
    for (const widget of dataWidgetsOf(item)) next[widget.id] = initialCard(keyOf(item.id, widget.id), t);
    cards = next;
    if (bandClock === null) bandClock = t;
    if (dataWidgetsOf(item).length === 0 && lastFeedAt !== null) bandClock = Math.max(bandClock, lastFeedAt);
    pruneMaps();
    dropUnwantedJobs();
    requestPinned(t, false);
  }

  function setTarget(item: DisplayItem, immediate: boolean, t: number) {
    const previous = target;
    if (previous !== null && previous.item.id === item.id && previous.immediate === immediate && !itemsDiffer(previous.item, item)) return;
    const keepClock = previous !== null && previous.item.id === item.id && previous.immediate === immediate;
    target = { item, immediate, chosenAt: keepClock ? previous.chosenAt : t };
    waiting.clear();
    dropUnwantedJobs();
    prefetchTarget(t);
  }
  function dropTarget() {
    target = null;
    waiting.clear();
    dropUnwantedJobs();
  }
  function chooseNext(t: number) {
    if (pinned === null) return;
    const next = nextShown(shown, pinned.id);
    if (next === null) return;
    if (next.id === pinned.id && !itemsDiffer(pinned, next)) return; // one shown item and unchanged: nothing to swap to
    setTarget(next, false, t);
  }

  /** True while a different build is waiting to be loaded: the old build keeps drawing, and when the wait is over this asks for the reload. */
  function buildBlocks(t: number): boolean {
    if (buildSeenAt === null) return false;
    if (t - buildSeenAt < buildDelay) return true;
    if (!reloadAllowed(lastReloadAt, t)) return false; // asked a moment ago: carry on, the caller's reload is on its way (or declined)
    lastReloadAt = t;
    reload();
    return true;
  }

  function commitSwap() {
    const next = target;
    if (next === null) return;
    pin(next.item, serverNow());
  }
  function swap(t: number) {
    if (buildBlocks(t)) return;
    if (reduceMotion()) {
      commitSwap();
      return;
    }
    phase = "out";
    fadeHandle = timers.set(() => {
      fadeHandle = null;
      commitSwap();
      phase = "in";
      publish(serverNow());
    }, FADE_HALF_MS);
  }

  function rotate(t: number) {
    if (reply === null || fadeHandle !== null) return;
    if (pinned === null) {
      if (shown.length > 0) pin(shown[0], t);
      else buildBlocks(t); // nothing on screen is a boundary too
      return;
    }
    const turn = pinnedAt + Math.max(pinned.seconds, 1) * 1000;
    if (target === null && t >= Math.max(pinnedAt, turn - FETCH_AHEAD_MS)) chooseNext(t);
    if (target !== null) {
      if (target.immediate || t >= turn) {
        const since = target.immediate ? target.chosenAt : Math.max(turn, target.chosenAt);
        if (waiting.size === 0 || t >= since + SWAP_WAIT_MS) swap(t);
      }
      return;
    }
    if (t >= turn && !buildBlocks(t)) pinnedAt = t; // one shown item: the turn passes, nothing changes
  }

  /** What a feed changes about what is on screen. */
  function reconcile(t: number) {
    if (reply === null) return;
    if (shown.length === 0) {
      if (fadeHandle !== null) {
        timers.clear(fadeHandle);
        fadeHandle = null;
      }
      phase = "in";
      pinned = null;
      target = null;
      cards = NO_CARDS;
      waiting.clear();
      queued.clear();
      queue.clear();
      emptyText = emptyTextFor(reply.playlist.name);
      return;
    }
    emptyText = null;
    if (pinned === null) {
      pin(shown[0], t);
      return;
    }
    const live = shown.find((item) => item.id === pinned?.id);
    if (live === undefined) {
      const next = nextShown(shown, pinned.id);
      if (next !== null) setTarget(next, true, t); // gone or skipped: the next shown item, at once
    } else if (itemsDiffer(pinned, live)) {
      setTarget(live, true, t); // edited: its new definition, at once
    } else if (target !== null) {
      if (target.immediate) {
        dropTarget(); // the edit was undone
      } else {
        const next = nextShown(shown, pinned.id);
        if (next === null || (next.id === pinned.id && !itemsDiffer(pinned, next))) dropTarget();
        else setTarget(next, false, t);
      }
    }
  }

  // ---- results of the requests ----

  function onResult(key: string, result: QueueResult) {
    const receivedAt = localNow();
    offset = clockOffset(result.serverDate, receivedAt, offset);
    const t = receivedAt + offset;
    const itemId = itemOfKey(key);
    const widgetId = widgetOfKey(key);
    if (result.kind === "ok" || result.kind === "moved" || result.kind === "rejected") queued.delete(key);
    waiting.delete(key); // any result counts as answered for the swap
    const card = pinned !== null && pinned.id === itemId ? (cards[widgetId] as CardState | undefined) : undefined;
    const inTarget = target !== null && target.item.id === itemId && dataWidgetsOf(target.item).some((widget) => widget.id === widgetId);
    switch (result.kind) {
      case "ok":
        if (card !== undefined || inTarget) kept.set(key, { data: result.data, answeredAt: t });
        unavailableUntil.delete(key);
        bandClock = Math.max(bandClock ?? t, t);
        if (card !== undefined) setCard(widgetId, { status: "ok", data: result.data, answeredAt: t, failingSince: null, notUpdated: false });
        break;
      case "failed":
      case "unauthorized":
        if (card !== undefined) {
          const status = card.data !== null ? "ok" : "error";
          if (card.failingSince === null || card.status !== status) {
            const failingSince = card.failingSince ?? t;
            setCard(widgetId, { ...card, status, failingSince, notUpdated: t - failingSince >= NOT_UPDATED_MS });
          }
        }
        if (result.kind === "unauthorized") reread(t);
        break;
      case "moved":
        moved.add(key);
        if (newestLists(itemId, widgetId)) reread(t);
        break;
      case "rejected":
        unavailableUntil.set(key, t + UNAVAILABLE_RETRY_MS);
        kept.delete(key);
        if (card !== undefined) setCard(widgetId, UNAVAILABLE);
        break;
    }
    publish(t);
  }

  // ---- the snapshot ----

  function notify() {
    if (stopped) {
      missed = true;
      return;
    }
    for (const listener of [...listeners]) listener();
  }

  function publish(t: number) {
    refreshNotUpdated(t);
    const timezone = reply?.site?.timezone ?? "";
    let band = snap.band;
    const found =
      reply === null || bandClock === null
        ? null
        : bandFor({
            now: t, bandClock, wakeHoldUntil, status: reply.status, collectorDownMs, readingsStoppedAt: readingsStop?.at ?? null,
            timeZone: timezone !== "" ? timezone : browserZone(),
          });
    if (found === null) band = null;
    else if (band === null || band.kind !== found.kind || band.text !== found.text) band = found;

    const minuteChanged = Math.floor(t / 60_000) !== Math.floor(snap.now / 60_000);
    const now = minuteChanged ? t : snap.now;
    let oldest: number | null = null;
    for (const card of Object.values(cards)) if (card.answeredAt !== null && (oldest === null || card.answeredAt < oldest)) oldest = card.answeredAt;
    const updatedAt = oldest === null ? null : Math.min(oldest, now);

    let position = snap.position;
    const wanted = pinned === null ? null : (positionOf(shown, pinned.id) ?? (snap.item === pinned ? snap.position : null));
    if (wanted === null) position = null;
    else if (position === null || position.index !== wanted.index || position.of !== wanted.of) position = wanted;

    if (
      pinned === snap.item && position === snap.position && phase === snap.phase && cards === snap.cards && timezone === snap.timezone &&
      now === snap.now && updatedAt === snap.updatedAt && band === snap.band && emptyText === snap.emptyText
    ) return;
    snap = { item: pinned, position, phase, cards, timezone, now, updatedAt, band, emptyText };
    notify();
  }

  // ---- the tick ----

  /**
   * A server time kept in the future would freeze the wall once the offset is corrected (a TV with a dead clock battery learns a huge offset from the
   * first `Date`; when the machine's clock then syncs, the server clock reads too far ahead until the next answer teaches the offset again, and every
   * time stored in that window would be ahead of the true clock: the turn never comes, the screen band is held back, a reload counts as recent).
   * Every stored time is brought back to the present, and the waits that look ahead to their own present.
   */
  function clampFuture(t: number) {
    if (pinnedAt > t) pinnedAt = t;
    if (bandClock !== null && bandClock > t) bandClock = t;
    if (lastFeedAt !== null && lastFeedAt > t) lastFeedAt = t;
    if (buildSeenAt !== null && buildSeenAt > t) buildSeenAt = t;
    if (lastReloadAt !== null && lastReloadAt > t) lastReloadAt = t;
    if (lastRereadAt !== null && lastRereadAt > t) lastRereadAt = t;
    if (lastWakeAt !== null && lastWakeAt > t) lastWakeAt = t;
    if (collectorRunStart !== null && collectorRunStart > t) collectorRunStart = t;
    if (target !== null && target.chosenAt > t) target = { ...target, chosenAt: t };
    if (wakeHoldUntil > t + WAKE_HOLD_MS) wakeHoldUntil = t + WAKE_HOLD_MS;
    for (const [key, until] of unavailableUntil) if (until > t + UNAVAILABLE_RETRY_MS) unavailableUntil.set(key, t + UNAVAILABLE_RETRY_MS);
    for (const [id, card] of Object.entries(cards)) if (card.failingSince !== null && card.failingSince > t) setCard(Number(id), { ...card, failingSince: t });
  }

  function tick() {
    tickHandle = null;
    if (!running) return;
    try {
      const t = serverNow();
      clampFuture(t);
      if (isHidden()) {
        pauseQueue();
        if (pinned !== null) pinnedAt = t; // the turn is pushed while nobody can see the screen
        return;
      }
      resumeQueue();
      rotate(t);
      requestPinned(t, forceDue);
      forceDue = false;
      publish(t);
    } finally {
      if (running) tickHandle = timers.set(tick, TICK_MS);
    }
  }

  const wall: Wall = {
    start() {
      if (running) return;
      running = true;
      stopped = false;
      if (!isHidden()) resumeQueue();
      for (const key of waiting) ask(key, itemOfKey(key), widgetOfKey(key), false); // the target's prefetch died with stop()
      tickHandle = timers.set(tick, TICK_MS);
      publish(serverNow());
      if (missed) {
        missed = false;
        notify();
      }
    },
    stop() {
      running = false;
      stopped = true;
      if (tickHandle !== null) {
        timers.clear(tickHandle);
        tickHandle = null;
      }
      if (fadeHandle !== null) {
        timers.clear(fadeHandle);
        fadeHandle = null;
        phase = "in"; // the swap is re-decided at the next tick
      }
      queue.clear();
      pauseQueue();
      queued.clear();
    },
    feed(next, receivedAt, serverDate) {
      offset = clockOffset(serverDate, receivedAt, offset);
      const t = receivedAt + offset;
      const previous = reply;
      reply = next;
      shown = shownItems(next.playlist.items);
      lastFeedAt = t;
      if (bandClock === null) bandClock = t;
      moved.clear();
      if (previous !== null) {
        for (const item of next.playlist.items) {
          const before = previous.playlist.items.find((entry) => entry.id === item.id);
          if (before !== undefined && itemsDiffer(before, item)) forgetItem(item.id); // its figures may no longer be the same question
        }
      }

      const status = next.status;
      if (status !== null && status.collectorAlive === false) {
        if (collectorRunStart === null) collectorRunStart = t;
        collectorDownMs = t - collectorRunStart;
      } else {
        collectorRunStart = null;
        collectorDownMs = null;
      }
      if (status !== null && status.readingsFresh === false) {
        if (readingsStop === null) readingsStop = { at: readingsStoppedAt(status.lastReadingAgeSeconds, t) };
      } else {
        readingsStop = null;
      }

      if (firstBuild === null && next.build !== null) firstBuild = next.build;
      if (buildChanged(firstBuild, next.build)) {
        if (buildSeenAt === null) {
          buildSeenAt = t;
          buildDelay = BUILD_DELAY_MIN_MS + BUILD_DELAY_SPREAD_MS * random();
        }
      } else {
        buildSeenAt = null;
      }

      reconcile(t);
      pruneMaps();
      dropUnwantedJobs();
      if (dataWidgetsOf(pinned).length === 0) bandClock = Math.max(bandClock, t); // no card to count: the playlist read is the sign of life
      publish(t);
    },
    wake() {
      if (!running || isHidden()) return;
      const t = serverNow();
      // A burst of wake events (a flaky link firing `online`, a driver toggling visibility) is ONE wake: it must not skip the 10 s limit on playlist reads,
      // refetch every card again and again, or keep restarting the item's timer (security review I1).
      if (lastWakeAt !== null && t >= lastWakeAt && t - lastWakeAt < REREAD_MIN_MS) return;
      lastWakeAt = t;
      wakeHoldUntil = t + WAKE_HOLD_MS;
      pinnedAt = t;
      forceDue = true;
      lastRereadAt = t;
      refreshPlaylist();
      resumeQueue();
      publish(t);
    },
    snapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  probes.set(wall, () => ({ kept: kept.size, queued: queued.size, moved: moved.size, unavailable: unavailableUntil.size, waiting: waiting.size }));
  return wall;
}
