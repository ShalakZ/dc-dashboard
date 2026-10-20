import { readFileSync } from "node:fs";
import { getPlaylist, parsePlaylist, retryAfterSeconds, serverDateOf, timeoutSignal, widgetData } from "./displayApi";

// A small playlist in the SHAPE the server sends (api/display.py), written out here: a test never reads the workspace.
const widget = (id: number, type = "stat") => ({ id, type, title: `Card ${id}`, config: { source: "energy", compare: "none" }, x: 0, y: id, w: 3, h: 2 });
const dashboard = (id: number, widgets: unknown[]) => ({ id, name: `Dashboard ${id}`, range: "this_month", widgets });
function playlistBody(): Record<string, unknown> {
  return {
    display: { name: "Wall 1" },
    playlist: {
      name: "Wall A",
      items: [
        { id: 1, seconds: 20, skipped: null, focus: null, dashboard: dashboard(1, [widget(1, "text"), widget(2), widget(3, "bar")]) },
        { id: 4, seconds: 15, skipped: null, focus: { id: 2, name: "Hall 1", trail: ["Pilot hall", "Hall 1"] }, dashboard: dashboard(1, [widget(5)]) },
        { id: 5, seconds: 10, skipped: "dashboard_deleted", focus: null, dashboard: null },
      ],
    },
    site: { name: "DC Dashboard", timezone: "Asia/Tokyo" },
    build: "abc123",
    status: { collector_alive: true, readings_fresh: false, last_reading_age_seconds: 703.2 },
  };
}
const items = (body: unknown) => (parsePlaylist(body)?.playlist.items ?? []);

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
/** Stubs `fetch` with one reply (a function of the call, so a test can look at the signal); every call is recorded. */
function stubFetch(reply: (call: Call) => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return reply(call);
  }));
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const headerNames = (init: RequestInit) => Object.keys((init.headers ?? {}) as Record<string, string>).map((name) => name.toLowerCase());

afterEach(() => { vi.unstubAllGlobals(); });

describe("parsePlaylist: the typed playlist", () => {
  it("types a full playlist: items, dashboards with widgets, the focus, the site, the build and the status", () => {
    const playlist = parsePlaylist(playlistBody());
    expect(playlist).not.toBeNull();
    expect(playlist!.display).toEqual({ name: "Wall 1" });
    expect(playlist!.playlist.name).toBe("Wall A");
    expect(playlist!.site).toEqual({ name: "DC Dashboard", timezone: "Asia/Tokyo" });
    expect(playlist!.build).toBe("abc123");
    expect(playlist!.status).toEqual({ collectorAlive: true, readingsFresh: false, lastReadingAgeSeconds: 703.2 });
    const [first, second, third] = playlist!.playlist.items;
    expect(first.dashboard).toEqual({
      id: 1, name: "Dashboard 1", range: "this_month",
      widgets: [
        { id: 1, type: "text", title: "Card 1", config: { source: "energy", compare: "none" }, x: 0, y: 1, w: 3, h: 2 },
        { id: 2, type: "stat", title: "Card 2", config: { source: "energy", compare: "none" }, x: 0, y: 2, w: 3, h: 2 },
        { id: 3, type: "bar", title: "Card 3", config: { source: "energy", compare: "none" }, x: 0, y: 3, w: 3, h: 2 },
      ],
    });
    expect(first.focus).toBeNull();
    expect(second.focus).toEqual({ id: 2, name: "Hall 1", trail: ["Pilot hall", "Hall 1"] });
    expect(third).toMatchObject({ id: 5, seconds: 10, skipped: "dashboard_deleted", dashboard: null, focus: null });
  });

  it("keeps a dashboard with no widgets (an empty one is the wall's rule to skip, not the parser's)", () => {
    const body = playlistBody();
    (body.playlist as { items: unknown[] }).items = [{ id: 1, seconds: 20, skipped: "no_widgets", focus: null, dashboard: dashboard(1, []) }];
    expect(items(body)[0].dashboard).toEqual({ id: 1, name: "Dashboard 1", range: "this_month", widgets: [] });
  });

  it.each([
    ["a widget with no x", { ...widget(2), x: undefined }],
    ["a widget whose height is text", { ...widget(2), h: "2" }],
    ["a widget with no id", { ...widget(2), id: undefined }],
    ["a widget whose type is a number", { ...widget(2), type: 3 }],
    ["a widget whose title is missing", { ...widget(2), title: undefined }],
    ["a widget that is not an object", "stat"],
  ])("drops the DASHBOARD of an item to null for %s, and keeps the item", (_name, bad) => {
    const body = playlistBody();
    (body.playlist as { items: unknown[] }).items = [
      { id: 1, seconds: 20, skipped: null, focus: null, dashboard: dashboard(1, [widget(1), bad]) },
      { id: 2, seconds: 30, skipped: null, focus: null, dashboard: dashboard(2, [widget(3)]) },
    ];
    const [broken, fine] = items(body);
    expect(broken).toMatchObject({ id: 1, seconds: 20, skipped: null, dashboard: null });
    expect(fine.dashboard).not.toBeNull();
  });

  it.each([
    ["a dashboard that is a string", "Ops"],
    ["a dashboard with no name", { id: 1, range: "today", widgets: [] }],
    ["a dashboard with no id", { name: "Ops", range: "today", widgets: [] }],
    ["a dashboard with no range", { id: 1, name: "Ops", widgets: [] }],
    ["a dashboard whose widgets are not a list", { id: 1, name: "Ops", range: "today", widgets: {} }],
  ])("types %s as no dashboard", (_name, bad) => {
    const body = playlistBody();
    (body.playlist as { items: unknown[] }).items = [{ id: 1, seconds: 20, skipped: null, focus: null, dashboard: bad }];
    expect(items(body)[0].dashboard).toBeNull();
  });

  it.each([
    ["not an object", "Hall 1"],
    ["with a trail that is not text", { id: 2, name: "Hall 1", trail: ["Pilot", 7] }],
    ["with no trail", { id: 2, name: "Hall 1" }],
    ["with no name", { id: 2, trail: [] }],
  ])("types a focus %s as no focus", (_name, bad) => {
    const body = playlistBody();
    (body.playlist as { items: unknown[] }).items = [{ id: 1, seconds: 20, skipped: null, focus: bad, dashboard: dashboard(1, [widget(1)]) }];
    expect(items(body)[0].focus).toBeNull();
  });

  it("gives null for a status, a site and a build that are missing (an older server never breaks the page)", () => {
    const body = playlistBody();
    delete body.status; delete body.site; delete body.build;
    expect(parsePlaylist(body)).toMatchObject({ status: null, site: null, build: null });
    expect(parsePlaylist(body)!.playlist.items).toHaveLength(3); // the rest is intact
  });

  it.each([
    ["a status that is a string", "ok"],
    ["a status with collector_alive as text", { collector_alive: "yes", readings_fresh: true, last_reading_age_seconds: 1 }],
    ["a status with readings_fresh as a number", { collector_alive: true, readings_fresh: 1, last_reading_age_seconds: 1 }],
    ["a status with no readings_fresh", { collector_alive: true, last_reading_age_seconds: 1 }],
    ["a status whose age is text", { collector_alive: true, readings_fresh: true, last_reading_age_seconds: "1" }],
  ])("gives a null status for %s", (_name, bad) => {
    expect(parsePlaylist({ ...playlistBody(), status: bad })!.status).toBeNull();
  });

  it("reads readings_fresh null (nothing read yet) and a missing age as they are", () => {
    expect(parsePlaylist({ ...playlistBody(), status: { collector_alive: false, readings_fresh: null, last_reading_age_seconds: null } })!.status)
      .toEqual({ collectorAlive: false, readingsFresh: null, lastReadingAgeSeconds: null });
    expect(parsePlaylist({ ...playlistBody(), status: { collector_alive: true, readings_fresh: true } })!.status)
      .toEqual({ collectorAlive: true, readingsFresh: true, lastReadingAgeSeconds: null });
  });

  it.each([
    ["a site with no timezone", { name: "DC" }],
    ["a site that is a string", "DC"],
  ])("gives a null site for %s", (_name, bad) => {
    expect(parsePlaylist({ ...playlistBody(), site: bad })!.site).toBeNull();
  });

  it("gives a null build for a build that is not text", () => {
    expect(parsePlaylist({ ...playlistBody(), build: 12 })!.build).toBeNull();
  });

  it("still gives null for a body that is not a playlist", () => {
    for (const body of [null, "x", [], {}, { display: { name: "A" } }, { display: { name: "A" }, playlist: { name: "B", items: "no" } }, { display: { name: "A" }, playlist: { name: "B", items: [3] } }]) {
      expect(parsePlaylist(body)).toBeNull();
    }
  });

  it("parses a playlist that has no site, build or status at all (the old shape of the tests)", () => {
    const parsed = parsePlaylist({ display: { name: "A" }, playlist: { name: "B", items: [{ id: 1, seconds: 60, dashboard: { id: 1, name: "Ops", range: "today", widgets: [] }, focus: null, skipped: null }] } });
    expect(parsed).toMatchObject({ site: null, build: null, status: null });
    expect(parsed!.playlist.items[0].dashboard).toMatchObject({ name: "Ops" });
  });
});

describe("serverDateOf: the Date header of an answer", () => {
  it("parses a valid header to ms", () => {
    const response = new Response(null, { status: 200, headers: { Date: "Tue, 20 Oct 2026 14:02:03 GMT" } });
    expect(serverDateOf(response)).toBe(Date.UTC(2026, 9, 20, 14, 2, 3));
  });
  it("is null when the header is absent", () => {
    expect(serverDateOf(new Response(null, { status: 200 }))).toBeNull();
  });
  it("is null when the header cannot be parsed", () => {
    expect(serverDateOf(new Response(null, { status: 200, headers: { Date: "yesterday, about noon" } }))).toBeNull();
    expect(serverDateOf(new Response(null, { status: 200, headers: { Date: "" } }))).toBeNull();
  });
});

describe("getPlaylist", () => {
  const dated = { Date: "Tue, 20 Oct 2026 14:02:03 GMT" };
  const at = Date.UTC(2026, 9, 20, 14, 2, 3);

  it("sets serverDate on every branch that returns a reply", async () => {
    stubFetch(() => json(200, playlistBody(), dated));
    expect(await getPlaylist()).toMatchObject({ status: 200, serverDate: at, playlist: expect.objectContaining({ build: "abc123" }) });
    stubFetch(() => new Response("not json", { status: 200, headers: dated }));
    expect(await getPlaylist()).toMatchObject({ status: 200, playlist: null, serverDate: at });
    stubFetch(() => json(401, { detail: "this display link is not valid" }, dated));
    expect(await getPlaylist()).toMatchObject({ status: 401, linkNotValid: true, serverDate: at });
    stubFetch(() => new Response("<html>", { status: 401, headers: dated }));
    expect(await getPlaylist()).toMatchObject({ status: 401, linkNotValid: false, serverDate: at });
    stubFetch(() => json(429, { detail: "x" }, { ...dated, "Retry-After": "12" }));
    expect(await getPlaylist()).toMatchObject({ status: 429, retryAfter: 12, serverDate: at });
    stubFetch(() => new Response("gateway", { status: 502, headers: dated }));
    expect(await getPlaylist()).toMatchObject({ status: 502, playlist: null, serverDate: at });
  });

  it("has a null serverDate when the answer carries no Date header", async () => {
    stubFetch(() => json(200, playlistBody()));
    expect((await getPlaylist()).serverDate).toBeNull();
    stubFetch(() => json(429, { detail: "x" }));
    expect((await getPlaylist()).serverDate).toBeNull();
  });

  it("reads the playlist with the cookie only: GET, same-origin, never cached, no Authorization, and a timeout signal", async () => {
    stubFetch(() => json(200, playlistBody()));
    await getPlaylist();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/display/playlist");
    expect(calls[0].init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
    expect(headerNames(calls[0].init)).not.toContain("authorization");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects when the request never completed, and when its timeout fires", async () => {
    stubFetch(() => { throw new TypeError("network"); });
    await expect(getPlaylist()).rejects.toThrow("network");
    const abort = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort());
    stubFetch(({ init }) => (init.signal?.aborted ? Promise.reject(new DOMException("timed out", "TimeoutError")) : json(200, playlistBody())));
    await expect(getPlaylist()).rejects.toThrow("timed out");
    expect(abort).toHaveBeenCalledWith(20_000);
  });
});

describe("timeoutSignal", () => {
  it("aborts after the wait, and not before", async () => {
    const signal = timeoutSignal(15);
    expect(signal.aborted).toBe(false);
    await new Promise((done) => setTimeout(done, 80));
    expect(signal.aborted).toBe(true);
  });

  it("is 20 seconds without an argument (AbortSignal.timeout when the browser has it)", () => {
    const abort = vi.spyOn(AbortSignal, "timeout");
    expect(timeoutSignal()).toBeInstanceOf(AbortSignal);
    expect(abort).toHaveBeenCalledWith(20_000);
  });

  it("falls back to an AbortController and setTimeout when the browser has no AbortSignal.timeout", async () => {
    const original = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true, writable: true });
    try {
      const signal = timeoutSignal(15);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      await new Promise((done) => setTimeout(done, 80));
      expect(signal.aborted).toBe(true);
    } finally {
      if (original) Object.defineProperty(AbortSignal, "timeout", original);
      else delete (AbortSignal as { timeout?: unknown }).timeout;
    }
  });
});

describe("widgetData", () => {
  const figures = { type: "stat", mode: "values", source: "energy", series: [], values: [{ asset_id: 1, name: "Rack A", value: 4.2 }] };

  it("sends exactly {item, widget}: POST, same-origin, never cached, JSON headers, no Authorization, a timeout signal", async () => {
    stubFetch(() => json(200, figures));
    await widgetData(4, 9);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/display/widget-data");
    expect(calls[0].init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ item: 4, widget: 9 });
    expect(Object.keys(JSON.parse(String(calls[0].init.body)))).toEqual(["item", "widget"]);
    expect(headerNames(calls[0].init).sort()).toEqual(["accept", "content-type"]);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the figures of a 200 that carries them, with the server's date", async () => {
    stubFetch(() => json(200, figures, { Date: "Tue, 20 Oct 2026 14:02:03 GMT" }));
    const reply = await widgetData(1, 2);
    expect(reply).toEqual({ status: 200, data: figures, retryAfter: null, serverDate: Date.UTC(2026, 9, 20, 14, 2, 3) });
  });

  it.each([
    [404, { detail: "not found" }, null],
    [422, { detail: "a text widget" }, null],
    [429, { detail: "too many requests" }, "7"],
    [429, { detail: "busy, try again" }, "1"],
    [409, { detail: "x" }, null],
    [500, { detail: "x" }, null],
  ])("returns the status %i with no data and its Retry-After", async (status, body, retryAfter) => {
    stubFetch(() => json(status, body, retryAfter === null ? {} : { "Retry-After": retryAfter }));
    const reply = await widgetData(1, 2);
    expect(reply).toEqual({ status, data: null, retryAfter: retryAfter === null ? null : Number(retryAfter), serverDate: null });
  });

  it.each([
    ["an object with no figures", { type: "stat" }],
    ["series only", { type: "stat", series: [] }],
    ["values only", { type: "stat", values: [] }],
    ["figures that are not lists", { type: "stat", series: {}, values: "no" }],
    ["no type", { series: [], values: [] }],
    ["a list", [1, 2]],
    ["null", null],
    ["a message", { detail: "ok" }],
  ])("gives data null (and the real status) for a 200 that is %s", async (_name, body) => {
    stubFetch(() => json(200, body));
    expect(await widgetData(1, 2)).toMatchObject({ status: 200, data: null });
  });

  it("gives data null for a 200 whose body is not JSON (a proxy's page)", async () => {
    stubFetch(() => new Response("<html>", { status: 200 }));
    expect(await widgetData(1, 2)).toMatchObject({ status: 200, data: null });
  });

  it("rejects only when the request never completed, and when its timeout fires", async () => {
    stubFetch(() => { throw new TypeError("network"); });
    await expect(widgetData(1, 2)).rejects.toThrow("network");
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort());
    stubFetch(({ init }) => (init.signal?.aborted ? Promise.reject(new DOMException("timed out", "TimeoutError")) : json(200, figures)));
    await expect(widgetData(1, 2)).rejects.toThrow("timed out");
  });
});

describe("retryAfterSeconds (unchanged)", () => {
  it("reads whole seconds only", () => {
    expect(retryAfterSeconds(new Response(null, { headers: { "Retry-After": "12" } }))).toBe(12);
    expect(retryAfterSeconds(new Response(null, { headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" } }))).toBeNull();
    expect(retryAfterSeconds(new Response(null))).toBeNull();
  });
});

describe("displayApi.ts reach", () => {
  const source = readFileSync("src/display/displayApi.ts", "utf8"); // vitest runs from the frontend directory
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // the header comment names the modules it must not import
  const specifiers = [...code.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)].map((match) => match[1]);

  it("imports nothing of the app's request machinery or sign-in: the screen reports no 401 to a session it does not have", () => {
    for (const specifier of specifiers) expect(specifier, specifier).not.toMatch(/api\/client|api\/queries|auth/);
    expect(code).not.toMatch(/api\/client|api\/queries|auth\//);
  });

  it("imports the WidgetData type from api/types and nothing else, as a type", () => {
    expect(specifiers).toEqual(["../api/types"]);
    expect(code).toMatch(/^import type \{ WidgetData \} from "\.\.\/api\/types";/m);
  });

  it("sends no Authorization header", () => {
    expect(code.toLowerCase()).not.toContain("authorization");
  });
});
