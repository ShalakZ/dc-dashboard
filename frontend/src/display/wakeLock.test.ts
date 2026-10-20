import { installWakeLock, type WakeLockApi } from "./wakeLock";

// Stubs for the browser's wake lock and the page: nothing here needs a real screen.

function sentinel() {
  return { release: vi.fn(() => Promise.resolve()) };
}
/** A wake lock whose every request is answered by the test. */
function lockApi() {
  const requests: Array<{ resolve: (s: ReturnType<typeof sentinel>) => void; reject: (e: unknown) => void }> = [];
  const request = vi.fn((_type: "screen") => new Promise<ReturnType<typeof sentinel>>((resolve, reject) => { requests.push({ resolve, reject }); }));
  return { api: { request } as WakeLockApi, request, requests };
}
function fakePage(hidden = false) {
  const listeners = new Set<() => void>();
  return {
    page: {
      hidden,
      addEventListener: (_type: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_type: string, fn: () => void) => { listeners.delete(fn); },
    } as unknown as Pick<Document, "addEventListener" | "removeEventListener" | "hidden">,
    set hidden(value: boolean) { (this.page as { hidden: boolean }).hidden = value; },
    fire: () => listeners.forEach((fn) => fn()),
    listeners,
  };
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("installWakeLock", () => {
  it("does nothing without a wake lock (plain http, an old browser): no listener, no throw", () => {
    const page = fakePage();
    const stop = installWakeLock({}, page.page);
    expect(page.listeners.size).toBe(0);
    expect(() => stop()).not.toThrow();
  });

  it("asks for the screen lock at once, and asks again each time the page becomes visible", async () => {
    const { api, request, requests } = lockApi();
    const page = fakePage();
    installWakeLock({ wakeLock: api }, page.page);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("screen");
    const first = sentinel();
    requests[0].resolve(first);
    await settle();

    page.hidden = true;
    page.fire(); // hidden: the browser dropped the lock, and asking now would be refused
    expect(request).toHaveBeenCalledTimes(1);
    page.hidden = false;
    page.fire();
    expect(request).toHaveBeenCalledTimes(2);
    const second = sentinel();
    requests[1].resolve(second);
    await settle();
    expect(first.release, "the old lock is given back when a new one is taken").toHaveBeenCalledTimes(1);
    expect(second.release).not.toHaveBeenCalled();
  });

  it("gives the lock back and stops listening when removed", async () => {
    const { api, request, requests } = lockApi();
    const page = fakePage();
    const stop = installWakeLock({ wakeLock: api }, page.page);
    const held = sentinel();
    requests[0].resolve(held);
    await settle();
    stop();
    expect(held.release).toHaveBeenCalledTimes(1);
    expect(page.listeners.size).toBe(0);
    page.fire();
    expect(request).toHaveBeenCalledTimes(1);
    stop();
    expect(held.release).toHaveBeenCalledTimes(1);
  });

  it("releases a lock that is granted after the wall went away", async () => {
    const { api, requests } = lockApi();
    const stop = installWakeLock({ wakeLock: api }, fakePage().page);
    stop();
    const late = sentinel();
    requests[0].resolve(late);
    await settle();
    expect(late.release).toHaveBeenCalledTimes(1);
  });

  it("swallows a refused request, a request that throws, and a release that fails", async () => {
    const page = fakePage();
    const refused = lockApi();
    const stop = installWakeLock({ wakeLock: refused.api }, page.page);
    refused.requests[0].reject(new DOMException("not allowed", "NotAllowedError"));
    await settle();
    page.fire(); // asks again, and may be refused again
    refused.requests[1].reject(new Error("battery"));
    await settle();
    stop();

    const throwing = { request: vi.fn(() => { throw new TypeError("no"); }) } as unknown as WakeLockApi;
    expect(() => installWakeLock({ wakeLock: throwing }, fakePage().page)()).not.toThrow();

    const failing = lockApi();
    const stop2 = installWakeLock({ wakeLock: failing.api }, fakePage().page);
    failing.requests[0].resolve({ release: vi.fn(() => Promise.reject(new Error("already released"))) });
    await settle();
    expect(() => stop2()).not.toThrow();
    const sync = lockApi();
    const stop3 = installWakeLock({ wakeLock: sync.api }, fakePage().page);
    sync.requests[0].resolve({ release: vi.fn(() => { throw new Error("gone"); }) } as unknown as ReturnType<typeof sentinel>);
    await settle();
    expect(() => stop3()).not.toThrow();
  });
});
