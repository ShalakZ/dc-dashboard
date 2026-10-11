type Reply = { status?: number; body?: unknown };
type Handler = Reply | ((req: { url: string; body: unknown }) => Reply);
export type Routes = Record<string, Handler>;

/**
 * What the app shell asks for on every page: the top bar's data chip and site clock, and the asset list the quick find searches.
 * Spread it first into the routes of a test that mounts `Layout` or `App` (`{ ...shellRoutes, ...own }`), so the three have an answer.
 */
export const shellRoutes: Routes = {
  "GET /api/status": { body: { collector_alive: true, readings_fresh: true, last_reading_age_seconds: 4 } },
  "GET /api/site": { body: { timezone: "UTC", currency: null } },
  "GET /api/assets": { body: [] },
};

/** Install a fetch mock keyed by "METHOD /path" (query string ignored). Returns the recorded calls. */
export function mockFetch(routes: Routes) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const handler = routes[`${method} ${path}`];
      if (handler === undefined) {
        return new Response(JSON.stringify({ detail: `no mock for ${method} ${path}` }), { status: 500 });
      }
      const reply = typeof handler === "function" ? handler({ url, body }) : handler;
      const status = reply.status ?? 200;
      if (status === 204) return new Response(null, { status });
      return new Response(JSON.stringify(reply.body ?? {}), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}
