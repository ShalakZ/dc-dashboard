import { useEffect } from "react";

// Keeps the screen from going to sleep while the wall is up (the Screen Wake Lock API: a secure context only, so on a plain-http address there is no
// `navigator.wakeLock` and this does nothing; the device guide says to turn the screen saver off for that case). The browser drops a lock whenever the
// tab is hidden, so the lock is asked for again each time the page becomes visible. Every refusal is swallowed: a wall must never fail, or make noise, over this.

/** The part of a `WakeLockSentinel` this file uses. */
interface Sentinel {
  release(): Promise<unknown>;
}
export interface WakeLockApi {
  request(type: "screen"): Promise<Sentinel>;
}
type Page = Pick<Document, "addEventListener" | "removeEventListener" | "hidden">;

/** Starts asking for the lock; returns the function that gives it back and stops asking. */
export function installWakeLock(nav: { wakeLock?: WakeLockApi } = navigator, doc: Page = document): () => void {
  const api = nav.wakeLock;
  if (api === undefined || api === null) return () => {};
  let removed = false;
  let held: Sentinel | null = null;

  const give = (sentinel: Sentinel) => {
    try {
      void Promise.resolve(sentinel.release()).catch(() => {});
    } catch {
      // already released: nothing to give back
    }
  };
  const take = () => {
    let asked: Promise<Sentinel>;
    try {
      asked = api.request("screen");
    } catch {
      return; // refused outright
    }
    asked.then(
      (sentinel) => {
        if (removed) {
          give(sentinel); // the answer came after the wall went away
          return;
        }
        const previous = held;
        held = sentinel;
        if (previous !== null) give(previous);
      },
      () => {}, // not allowed now (a hidden tab, low battery, no permission): the next visibility change asks again
    );
  };
  const onVisibility = () => {
    if (!removed && !doc.hidden) take();
  };

  doc.addEventListener("visibilitychange", onVisibility);
  take();
  return () => {
    if (removed) return;
    removed = true;
    doc.removeEventListener("visibilitychange", onVisibility);
    if (held !== null) give(held);
    held = null;
  };
}

/** The wall keeps its screen awake for as long as it is on the page. */
export function useWakeLock(): void {
  useEffect(() => installWakeLock(), []);
}
