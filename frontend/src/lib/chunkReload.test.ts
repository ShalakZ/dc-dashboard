import { CHUNK_RELOAD_KEY, installChunkReload, reloadIfServerAnswers } from "./chunkReload";

// A map-backed stand-in for sessionStorage; `fail` makes the named calls throw, as a browser with storage blocked does.
function fakeStorage(fail: { get?: boolean; set?: boolean } = {}) {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => {
      if (fail.get) throw new DOMException("denied", "SecurityError");
      return data.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (fail.set) throw new DOMException("denied", "SecurityError");
      data.set(key, value);
    },
  };
}

// What Vite's preload helper dispatches when a lazy chunk cannot be fetched.
function preloadError() {
  const event = new Event("vite:preloadError", { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

// The server probe: it answers (any HTTP status counts, a stale chunk is a 404 from a live server) or it rejects (no connection).
const answers = (status = 404) => vi.fn(() => Promise.resolve({ status }));
const silent = () => vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
// The reload happens after the probe's promise settles: let the microtasks (and the timers of the next tick) run.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("installChunkReload (a tab left open across an update)", () => {
  it("reloads once on the first failed chunk and records the time under dcdash.chunkReload", async () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    uninstall = installChunkReload(storage, reload, () => 1_000_000, answers());
    preloadError();
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(CHUNK_RELOAD_KEY).toBe("dcdash.chunkReload");
    expect(storage.data.get("dcdash.chunkReload")).toBe("1000000");
  });

  it("does nothing for a second failure within 10 seconds (a broken deploy must not loop), and again once 10 seconds have passed", async () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    const probe = answers();
    let clock = 1_000_000;
    uninstall = installChunkReload(storage, reload, () => clock, probe);
    preloadError();
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    clock += 3_000; // two more chunks of the same page failing a moment later, or the page after the reload failing the same way
    preloadError();
    await settle();
    clock += 6_999; // 9.999 s after the reload
    preloadError();
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1); // inside the window the server is not even asked
    expect(storage.data.get(CHUNK_RELOAD_KEY)).toBe("1000000"); // the guard window is not extended by the failures it swallowed
    clock += 1; // exactly 10 s
    preloadError();
    await settle();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(storage.data.get(CHUNK_RELOAD_KEY)).toBe("1010000");
  });

  it("reloads when the recorded time is unreadable or lies in the future (the clock was set back)", async () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    uninstall = installChunkReload(storage, reload, () => 5_000_000, answers());
    storage.data.set(CHUNK_RELOAD_KEY, "not a time");
    preloadError();
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    storage.data.set(CHUNK_RELOAD_KEY, String(5_000_000 + 3_600_000));
    preloadError();
    await settle();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("never stops the event: a prevented preload error would make the import resolve to undefined and the page would throw a TypeError instead", () => {
    uninstall = installChunkReload(fakeStorage(), vi.fn(), () => 1_000_000, answers());
    expect(preloadError().defaultPrevented).toBe(false);
    expect(preloadError().defaultPrevented).toBe(false); // the guarded second one too
  });

  it("does not throw and does not reload when the storage throws (without a record there is no loop guard, so the panel's Reload button takes over)", async () => {
    for (const fail of [{ get: true, set: true }, { set: true }]) {
      const reload = vi.fn();
      const stop = installChunkReload(fakeStorage(fail), reload, () => 1_000_000, answers());
      expect(() => preloadError()).not.toThrow();
      await settle();
      expect(reload).not.toHaveBeenCalled();
      stop();
    }
    const reload = vi.fn();
    uninstall = installChunkReload(null, reload, () => 1_000_000, answers()); // sessionStorage itself refused to be touched
    expect(() => preloadError()).not.toThrow();
    await settle();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload, and records no time, when the web server cannot be reached at all (a reload would land on the browser's own error page)", async () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    const probe = silent();
    uninstall = installChunkReload(storage, reload, () => 1_000_000, probe);
    expect(() => preloadError()).not.toThrow();
    await settle();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.data.has(CHUNK_RELOAD_KEY)).toBe(false); // nothing is spent: the next failure, with the network back, still gets its one reload
  });

  it("reloads on a later failure once the server answers again, after one it could not reach", async () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    const probe = vi.fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ status: 200 });
    uninstall = installChunkReload(storage, reload, () => 1_000_000, probe);
    preloadError();
    await settle();
    expect(reload).not.toHaveBeenCalled();
    preloadError();
    await settle();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.data.get(CHUNK_RELOAD_KEY)).toBe("1000000");
  });

  it("asks the server once while its answer is pending, however many chunks of the page failed, and reloads once", async () => {
    const reload = vi.fn();
    let answer: (value: unknown) => void = () => {};
    const probe = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    uninstall = installChunkReload(fakeStorage(), reload, () => 1_000_000, probe);
    preloadError();
    preloadError();
    preloadError();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled(); // nothing happens before the answer
    answer({ status: 404 });
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload, and does not throw, when the probe itself cannot be made", async () => {
    const reload = vi.fn();
    uninstall = installChunkReload(fakeStorage(), reload, () => 1_000_000, () => { throw new ReferenceError("fetch is not defined"); });
    expect(() => preloadError()).not.toThrow();
    await settle();
    expect(reload).not.toHaveBeenCalled();
  });

  it("probes with a HEAD request for the front page that is never served from the cache, and counts any HTTP status as an answer", async () => {
    for (const status of [200, 404, 502]) {
      const fetchMock = vi.fn(() => Promise.resolve({ status }));
      vi.stubGlobal("fetch", fetchMock);
      const reload = vi.fn();
      const stop = installChunkReload(fakeStorage(), reload, () => 1_000_000);
      preloadError();
      await settle();
      expect(fetchMock).toHaveBeenCalledWith("/", expect.objectContaining({ method: "HEAD", cache: "no-store" }));
      expect(reload).toHaveBeenCalledTimes(1); // a stale chunk is a 404 from a live server; a 502 is a live proxy
      stop();
    }
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    const reload = vi.fn();
    uninstall = installChunkReload(fakeStorage(), reload, () => 1_000_000);
    preloadError();
    await settle();
    expect(reload).not.toHaveBeenCalled(); // only a request that gets no answer at all keeps the tab where it is
  });

  it("uses the tab's sessionStorage and the page's own reload when nothing is passed", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ status: 200 })));
    uninstall = installChunkReload();
    preloadError();
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(Number(window.sessionStorage.getItem("dcdash.chunkReload"))).toBeGreaterThan(0);
    preloadError();
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("stops listening when uninstalled", async () => {
    const reload = vi.fn();
    const probe = answers();
    installChunkReload(fakeStorage(), reload, () => 1_000_000, probe)();
    preloadError();
    await settle();
    expect(probe).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("only reacts to vite:preloadError", async () => {
    const reload = vi.fn();
    const probe = answers();
    uninstall = installChunkReload(fakeStorage(), reload, () => 1_000_000, probe);
    window.dispatchEvent(new Event("error"));
    window.dispatchEvent(new Event("unhandledrejection"));
    await settle();
    expect(probe).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});

// The shared helper: the chunk reload above and the display wall's build reload go through it, with one guard and one sessionStorage key.
describe("reloadIfServerAnswers (the one reload path)", () => {
  it("probes the server, records the time under dcdash.chunkReload, reloads and says true", async () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    const probe = answers(404);
    await expect(reloadIfServerAnswers(storage, reload, () => 2_000_000, probe)).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(storage.data.get(CHUNK_RELOAD_KEY)).toBe("2000000");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("says false and does nothing without a usable storage", async () => {
    const reload = vi.fn();
    const probe = answers();
    await expect(reloadIfServerAnswers(null, reload, () => 2_000_000, probe)).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    await expect(reloadIfServerAnswers(fakeStorage({ get: true }), reload, () => 2_000_000, probe)).resolves.toBe(false); // the guard cannot be read
    await expect(reloadIfServerAnswers(fakeStorage({ set: true }), reload, () => 2_000_000, probe)).resolves.toBe(false); // the time cannot be recorded
    expect(reload).not.toHaveBeenCalled();
  });

  it("says false within 10 seconds of the last reload (the server is not even asked), and true at exactly 10 seconds", async () => {
    const storage = fakeStorage();
    storage.data.set(CHUNK_RELOAD_KEY, "2000000");
    const reload = vi.fn();
    const probe = answers();
    await expect(reloadIfServerAnswers(storage, reload, () => 2_009_999, probe)).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(storage.data.get(CHUNK_RELOAD_KEY)).toBe("2000000");
    await expect(reloadIfServerAnswers(storage, reload, () => 2_010_000, probe)).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.data.get(CHUNK_RELOAD_KEY)).toBe("2010000");
  });

  it("says false and records nothing when the server does not answer, or the probe cannot be made", async () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    await expect(reloadIfServerAnswers(storage, reload, () => 2_000_000, silent())).resolves.toBe(false);
    await expect(reloadIfServerAnswers(storage, reload, () => 2_000_000, () => { throw new ReferenceError("fetch is not defined"); })).resolves.toBe(false);
    expect(storage.data.has(CHUNK_RELOAD_KEY)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("shares the guard with the chunk reload: a reload by either blocks the other for 10 seconds", async () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    await expect(reloadIfServerAnswers(storage, reload, () => 3_000_000, answers())).resolves.toBe(true);
    uninstall = installChunkReload(storage, reload, () => 3_005_000, answers());
    preloadError();
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("uses the tab's sessionStorage, the page's own reload and the HEAD probe when nothing is passed", async () => {
    const reload = vi.fn();
    const fetchMock = vi.fn(() => Promise.resolve({ status: 200 }));
    vi.stubGlobal("location", { ...window.location, reload });
    vi.stubGlobal("fetch", fetchMock);
    await expect(reloadIfServerAnswers()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/", expect.objectContaining({ method: "HEAD", cache: "no-store" }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(Number(window.sessionStorage.getItem(CHUNK_RELOAD_KEY))).toBeGreaterThan(0);
    await expect(reloadIfServerAnswers()).resolves.toBe(false); // the guard
  });
});
