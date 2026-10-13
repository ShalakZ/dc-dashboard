import { CHUNK_RELOAD_KEY, installChunkReload } from "./chunkReload";

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

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("installChunkReload (a tab left open across an update)", () => {
  it("reloads once on the first failed chunk and records the time under dcdash.chunkReload", () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    uninstall = installChunkReload(storage, reload, () => 1_000_000);
    preloadError();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(CHUNK_RELOAD_KEY).toBe("dcdash.chunkReload");
    expect(storage.data.get("dcdash.chunkReload")).toBe("1000000");
  });

  it("does nothing for a second failure within 10 seconds (a broken deploy must not loop), and again once 10 seconds have passed", () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    let clock = 1_000_000;
    uninstall = installChunkReload(storage, reload, () => clock);
    preloadError();
    expect(reload).toHaveBeenCalledTimes(1);
    clock += 3_000; // two more chunks of the same page failing a moment later, or the page after the reload failing the same way
    preloadError();
    clock += 6_999; // 9.999 s after the reload
    preloadError();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.data.get(CHUNK_RELOAD_KEY)).toBe("1000000"); // the guard window is not extended by the failures it swallowed
    clock += 1; // exactly 10 s
    preloadError();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(storage.data.get(CHUNK_RELOAD_KEY)).toBe("1010000");
  });

  it("reloads when the recorded time is unreadable or lies in the future (the clock was set back)", () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    uninstall = installChunkReload(storage, reload, () => 5_000_000);
    storage.data.set(CHUNK_RELOAD_KEY, "not a time");
    preloadError();
    expect(reload).toHaveBeenCalledTimes(1);
    storage.data.set(CHUNK_RELOAD_KEY, String(5_000_000 + 3_600_000));
    preloadError();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("never stops the event: a prevented preload error would make the import resolve to undefined and the page would throw a TypeError instead", () => {
    uninstall = installChunkReload(fakeStorage(), vi.fn(), () => 1);
    expect(preloadError().defaultPrevented).toBe(false);
    expect(preloadError().defaultPrevented).toBe(false); // the guarded second one too
  });

  it("does not throw and does not reload when the storage throws (without a record there is no loop guard, so the panel's Reload button takes over)", () => {
    for (const fail of [{ get: true, set: true }, { set: true }]) {
      const reload = vi.fn();
      const stop = installChunkReload(fakeStorage(fail), reload, () => 1);
      expect(() => preloadError()).not.toThrow();
      expect(reload).not.toHaveBeenCalled();
      stop();
    }
    const reload = vi.fn();
    uninstall = installChunkReload(null, reload, () => 1); // sessionStorage itself refused to be touched
    expect(() => preloadError()).not.toThrow();
    expect(reload).not.toHaveBeenCalled();
  });

  it("uses the tab's sessionStorage and the page's own reload when nothing is passed", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    uninstall = installChunkReload();
    preloadError();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(Number(window.sessionStorage.getItem("dcdash.chunkReload"))).toBeGreaterThan(0);
    preloadError();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("stops listening when uninstalled", () => {
    const reload = vi.fn();
    installChunkReload(fakeStorage(), reload, () => 1)();
    preloadError();
    expect(reload).not.toHaveBeenCalled();
  });

  it("only reacts to vite:preloadError", () => {
    const reload = vi.fn();
    uninstall = installChunkReload(fakeStorage(), reload, () => 1);
    window.dispatchEvent(new Event("error"));
    window.dispatchEvent(new Event("unhandledrejection"));
    expect(reload).not.toHaveBeenCalled();
  });
});
