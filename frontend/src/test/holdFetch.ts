/**
 * Put in front of the fetch that `mockFetch` installed: a request for which `match(method, path)` is true waits until `release()`
 * before it is passed on, so a test can look at the page while that request is in flight.
 */
export function holdFetch(match: (method: string, path: string) => boolean) {
  const inner = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      if (match(method, path)) await gate;
      return inner(input, init);
    }),
  );
  return { release };
}
