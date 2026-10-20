/** sessionStorage key: the time (ms since 1970) of the last reload this module made. */
export const CHUNK_RELOAD_KEY = "dcdash.chunkReload";
/** A failure this soon after a reload we made is a broken deploy, not a stale tab: reloading again would loop. */
const LOOP_GUARD_MS = 10_000;

type Store = Pick<Storage, "getItem" | "setItem">;
/** Asks whether the web server answers at all. Resolves for any HTTP status, rejects when there is no connection. */
type Probe = () => Promise<unknown>;

function tabStorage(): Store | null {
  try { return window.sessionStorage; } catch { return null; } // blocked storage makes even reading the property throw
}

// A stale chunk is a 404 from a live server, so any status says "the server is there"; a refused or timed-out connection is the other case.
const serverAnswers: Probe = () => fetch("/", { method: "HEAD", cache: "no-store" });

/**
 * Reloads the page once, if the web server answers: the one reload path of a page that may be stale (a lazy chunk the new build no longer has, or the
 * display wall that saw a new build). The guard is the same for every caller: no usable storage means no way to tell a stale tab from a broken deploy,
 * so no automatic reload; a reload recorded under `dcdash.chunkReload` less than 10 seconds ago means a broken deploy, so none either. The server is
 * asked with a HEAD request first: with no connection at all (the server restarting, a network blip) the reload would land on the browser's own error
 * page and stay there, so then nothing happens and nothing is recorded. Otherwise the time is recorded, `reload()` is called and the answer is true.
 */
export async function reloadIfServerAnswers(
  storage: Store | null = tabStorage(),
  reload: () => void = () => window.location.reload(),
  now: () => number = Date.now,
  probe: Probe = serverAnswers,
): Promise<boolean> {
  if (!storage) return false;
  try {
    const age = now() - Number(storage.getItem(CHUNK_RELOAD_KEY)); // nothing, or text that is not a time, reads as long ago
    if (age >= 0 && age < LOOP_GUARD_MS) return false; // a time in the future (the clock was set back) is not a recent reload
  } catch {
    return false;
  }
  let asked: Promise<unknown>;
  try { asked = probe(); } catch { return false; }
  try { await asked; } catch { return false; } // no connection: nothing recorded, the next failure asks again
  try { storage.setItem(CHUNK_RELOAD_KEY, String(now())); } catch { return false; }
  reload();
  return true;
}

/**
 * A tab left open across an update asks for a lazy chunk (a page, the chart, a widget) that the new build no longer has, and the
 * import fails. Vite announces that as `vite:preloadError`: reload once (`reloadIfServerAnswers`), which fetches the new index.html and the chunks it names.
 * The event is NOT cancelled here: a cancelled one makes the import resolve to undefined, and the page throws a TypeError reading it.
 * The import still fails, the route's error panel (RouteError) shows for the moment before the reload takes over, and stays if no reload came.
 * Returns a function that removes the listener.
 */
export function installChunkReload(
  storage: Store | null = tabStorage(),
  reload: () => void = () => window.location.reload(),
  now: () => number = Date.now,
  probe: Probe = serverAnswers,
): () => void {
  let probing = false; // several chunks of one page fail together: one question to the server, one reload
  const onPreloadError = () => {
    if (probing) return;
    probing = true;
    reloadIfServerAnswers(storage, reload, now, probe)
      .catch(() => {}) // a reload() that throws: nothing more to do, the panel's Reload button remains
      .finally(() => { probing = false; });
  };
  window.addEventListener("vite:preloadError", onPreloadError);
  return () => window.removeEventListener("vite:preloadError", onPreloadError);
}
