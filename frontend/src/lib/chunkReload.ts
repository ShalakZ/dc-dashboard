/** sessionStorage key: the time (ms since 1970) of the last reload this module made. */
export const CHUNK_RELOAD_KEY = "dcdash.chunkReload";
/** A failure this soon after a reload we made is a broken deploy, not a stale tab: reloading again would loop. */
const LOOP_GUARD_MS = 10_000;

type Store = Pick<Storage, "getItem" | "setItem">;

function tabStorage(): Store | null {
  try { return window.sessionStorage; } catch { return null; } // blocked storage makes even reading the property throw
}

/**
 * A tab left open across an update asks for a lazy chunk (a page, the chart, a widget) that the new build no longer has, and the
 * import fails. Vite announces that as `vite:preloadError`: reload once, which fetches the new index.html and the chunks it names.
 * The event is NOT cancelled here: a cancelled one makes the import resolve to undefined, and the page throws a TypeError reading it.
 * The import still fails, the route's error panel (RouteError) shows for the moment before the reload takes over, and stays if no reload came.
 * Returns a function that removes the listener.
 */
export function installChunkReload(
  storage: Store | null = tabStorage(),
  reload: () => void = () => window.location.reload(),
  now: () => number = Date.now,
): () => void {
  const onPreloadError = () => {
    try {
      // No usable storage means no way to tell a stale tab from a broken deploy, so no automatic reload (the panel's button remains).
      if (!storage) return;
      const age = now() - Number(storage.getItem(CHUNK_RELOAD_KEY)); // nothing, or text that is not a time, reads as long ago
      if (age >= 0 && age < LOOP_GUARD_MS) return; // a time in the future (the clock was set back) is not a recent reload
      storage.setItem(CHUNK_RELOAD_KEY, String(now()));
    } catch {
      return;
    }
    reload();
  };
  window.addEventListener("vite:preloadError", onPreloadError);
  return () => window.removeEventListener("vite:preloadError", onPreloadError);
}
