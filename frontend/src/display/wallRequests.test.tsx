import { act, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { notifyUnauthorized } from "../api/client";
import { reloadIfServerAnswers } from "../lib/chunkReload";
import { breakdownData, config, dataFor } from "../test/dashboardFixtures";
import { manualTimers } from "../test/manualTimers";
import { DisplayApp } from "./DisplayApp";
import { resetClaimMemo } from "./displayLoop";
import { holdSecret } from "./secretHandle";

// R1 / A5: the wall reaches the server through /api/display/* and nothing else. A whole playlist (every widget type, a breakdown by kind, the three
// text styles, an item with a focus asset) is drawn by the real page, the real loop and the real controller, on hand-moved clocks, and every request
// it makes is recorded. The charts are lazy chunks of ECharts, which a stub stands in for.
vi.mock("echarts-for-react", () => ({
  default: (props: { option: { series?: { type?: string }[] } }) => <div data-testid="chart" data-kind={props.option.series?.[0]?.type} />,
}));
// The app's request layer reports a 401 to the sign-in machinery. The wall must never reach it, so the spy is the module's own export.
vi.mock("../api/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api/client")>()), notifyUnauthorized: vi.fn() }));
vi.mock("./reloadClean", () => ({ reloadClean: vi.fn() }));
// The reload after a new build is the shared guarded reload (it asks the server with a HEAD / first, which is not a wall request): a stub here.
vi.mock("../lib/chunkReload", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/chunkReload")>()), reloadIfServerAnswers: vi.fn(async () => true) }));

const SECRET = "abc_DEF-123";
const CLAIM = "POST /api/display/claim";
const PLAYLIST = "GET /api/display/playlist";
const WIDGET = "POST /api/display/widget-data";

// ---- the playlist: two items of 20 seconds ----
const dw = (id: number, type: string, over: Record<string, unknown> = {}) => ({ id, type, title: `Card ${id}`, config: config(), x: 0, y: 0, w: 4, h: 3, ...over });
const text = (id: number, style: string, words: string, y: number) => dw(id, "text", { title: `Text ${id}`, config: { style, text: words }, x: 0, y, w: 12, h: 1 });
const kindBars = config({ bars: "kind", assets: [], kind: "Rack", root: 2 });
const FOCUS = { id: 2, name: "Hall 1", trail: ["Pilot site", "Hall 1"] };
/** Item 1: every type the wall draws. */
const POWER = [
  dw(1, "stat", { x: 0, y: 0 }),
  dw(2, "gauge", { x: 4, y: 0, config: config({ min: 0, max: 100 }) }),
  dw(3, "table", { x: 8, y: 0 }),
  dw(4, "timeseries", { x: 0, y: 3, w: 6 }),
  dw(5, "bar", { x: 6, y: 3, w: 6 }),
  dw(6, "bar", { x: 0, y: 6, w: 6, config: kindBars }),
  text(7, "heading", "Power hall", 9),
  text(8, "paragraph", "All figures are for the pilot hall.", 10),
  text(9, "divider", "", 11),
];
/** Item 2: a focus asset (the dashboard's own figures come from it). */
const COST = [
  dw(11, "stat", { x: 0, y: 0, config: config({ assets: [], scope: "focus" }) }),
  dw(12, "timeseries", { x: 4, y: 0, w: 8, config: config({ assets: [], scope: "children" }) }),
  dw(13, "bar", { x: 0, y: 3, w: 6, config: { ...kindBars, scope: "focus" } }),
  text(14, "paragraph", "Costs follow the tariff.", 6),
];
const answerFor = (widget: number) => {
  const all = [...POWER, ...COST];
  const found = all.find((w) => w.id === widget);
  if (!found || found.type === "text") return null;
  return found.config === kindBars || (found.config as { bars?: string }).bars === "kind" ? breakdownData() : dataFor(found.type as "stat");
};
const playlistBody = (build = "test") => ({
  display: { name: "Hall TV" },
  playlist: {
    name: "Wall A",
    items: [
      { id: 1, seconds: 20, skipped: null, focus: null, dashboard: { id: 1, name: "Power", range: "24h", widgets: POWER } },
      { id: 2, seconds: 20, skipped: null, focus: FOCUS, dashboard: { id: 2, name: "Cost", range: "this_month", widgets: COST } },
    ],
  },
  site: { name: "DC Dashboard", timezone: "UTC" },
  build,
  status: { collector_alive: true, readings_fresh: true, last_reading_age_seconds: 5 },
});
const DATA_WIDGETS = (items: Array<typeof POWER>) => items.flat().filter((w) => w.type !== "text").map((w) => w.id).sort((a, b) => a - b);

// ---- the stub of the network ----
type Call = { key: string; url: string; init: RequestInit };
let calls: Call[] = [];
interface Answers { claim?: number; widget?: (item: number, widget: number) => number; build?: (read: number) => string }
function stubFetch(answers: Answers = {}) {
  calls = [];
  let reads = 0;
  const plain = (status: number, body: unknown = {}) =>
    ({ status, headers: new Headers(), json: async () => body }) as unknown as Response;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const key = `${(init.method ?? "GET").toUpperCase()} ${url}`;
      calls.push({ key, url, init });
      if (key === CLAIM) return plain(answers.claim ?? 204);
      if (key === PLAYLIST) {
        reads += 1;
        return plain(200, playlistBody(answers.build?.(reads) ?? "test"));
      }
      if (key === WIDGET) {
        const { item, widget } = JSON.parse(String(init.body)) as { item: number; widget: number };
        const status = answers.widget?.(item, widget) ?? 200;
        return status === 200 ? plain(200, answerFor(widget)) : plain(status, { detail: "x" });
      }
      throw new Error(`unexpected request ${key}`);
    }),
  );
}
const count = (key: string) => calls.filter((call) => call.key === key).length;
const widgetsAsked = () => calls.filter((call) => call.key === WIDGET).map((call) => (JSON.parse(String(call.init.body)) as { item: number; widget: number }));

// ---- the clocks: the loop's, the wall's, and Date.now (the wall reads local time from it) ----
async function flush() {
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
}
function rig(handle: ReturnType<typeof holdSecret> = null) {
  const loop = manualTimers();
  const wall = manualTimers();
  const clock = { now: Date.UTC(2026, 9, 20, 12, 0, 0) };
  vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  vi.spyOn(Math, "random").mockReturnValue(0);
  render(<DisplayApp handle={handle} timers={loop.timers} wallTimers={wall.timers} />);
  const seen = { titles: new Set<string>(), positions: new Set<string>() };
  const look = () => {
    const title = document.querySelector(".wall-title")?.textContent;
    const position = document.querySelector(".wall-position")?.textContent;
    if (title) seen.titles.add(title);
    if (position) seen.positions.add(position);
  };
  /** Moves every clock by `ms` together and lets the requests settle. */
  const step = async (ms: number) => {
    await act(async () => {
      clock.now += ms;
      loop.advance(ms);
      wall.advance(ms);
      await flush();
    });
    look();
  };
  /** `seconds` one-second steps: the wall's tick is one second, and a step is never longer than the tick, so the controller sees every second. */
  const run = async (seconds: number) => {
    for (let i = 0; i < seconds; i += 1) await step(1_000);
  };
  return { loop, wall, clock, seen, step, run };
}

beforeEach(() => {
  resetClaimMemo();
  window.history.replaceState(null, "", "/display");
  vi.mocked(notifyUnauthorized).mockClear();
  vi.mocked(reloadIfServerAnswers).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  calls = [];
});

/** Every request the page made stays on its own routes, same-origin, uncached, with no Authorization and no other credential in a header. */
function expectOnlyDisplayRoutes() {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.url.startsWith("/api/display/"), `${call.key} is not a display route`).toBe(true);
    expect(call.init.credentials, call.key).toBe("same-origin");
    expect(call.init.cache, call.key).toBe("no-store");
    const headers = new Headers(call.init.headers);
    expect(headers.has("authorization"), `${call.key} sends an Authorization header`).toBe(false);
    expect([...headers.keys()].sort(), `${call.key} headers`).toEqual(call.init.body === undefined ? ["accept"] : ["accept", "content-type"]);
  }
}

describe("a whole playlist on the wall (R1)", () => {
  it("draws every widget type of both items, rotates through them, and asks only /api/display/*, ids only, never the app's request layer", async () => {
    stubFetch();
    const r = rig();
    await r.step(0);
    expect(await screen.findByRole("heading", { level: 1, name: "Power" })).toBeInTheDocument();
    await r.run(50); // a turn is 20 s: the first item, the second (prefetched 8 s ahead), the first again
    expect(r.seen.positions).toEqual(new Set(["1 of 2", "2 of 2"]));
    expect(r.seen.titles).toEqual(new Set(["Power", "Cost, Hall 1"]));

    // the figures of every data widget of BOTH items were asked, a text widget never
    const asked = widgetsAsked();
    expect([...new Set(asked.map((a) => a.widget))].sort((a, b) => a - b)).toEqual(DATA_WIDGETS([POWER, COST]));
    for (const a of asked) expect(a.item === 1 ? POWER.some((w) => w.id === a.widget) : COST.some((w) => w.id === a.widget), `${JSON.stringify(a)}`).toBe(true);
    for (const call of calls.filter((c) => c.key === WIDGET)) {
      const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
      expect(Object.keys(body).sort(), "ids only").toEqual(["item", "widget"]);
      expect(Number.isInteger(body.item) && Number.isInteger(body.widget)).toBe(true);
    }
    expect(calls.map((c) => c.key).every((key) => [PLAYLIST, WIDGET].includes(key))).toBe(true);
    expectOnlyDisplayRoutes();
    expect(notifyUnauthorized).not.toHaveBeenCalled();
    expect(reloadIfServerAnswers).not.toHaveBeenCalled();

    // and it is drawn: the cards of the current item, none of them an error, a chart for each chart card
    expect(screen.queryByText("This card cannot be shown.")).toBeNull();
    expect(document.querySelectorAll(".wall-card").length).toBeGreaterThan(0);
    expect((await screen.findAllByTestId("chart")).length).toBeGreaterThan(0);
  });

  it("with a link: the secret is in the one claim body and nowhere else, not in a URL, a header, a later body or the page", async () => {
    stubFetch();
    const handle = holdSecret(SECRET);
    const r = rig(handle);
    await r.step(0);
    await r.run(25);
    expect(calls[0].key).toBe(CLAIM);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ secret: SECRET });
    expect(count(CLAIM)).toBe(1);
    expect(handle?.secret()).toBeNull();
    for (const call of calls.slice(1)) {
      expect(call.url.includes(SECRET), "the secret in a URL").toBe(false);
      expect(JSON.stringify(call.init).includes(SECRET), `the secret in ${call.key}`).toBe(false);
    }
    expect(widgetsAsked().length).toBeGreaterThan(0);
    expect(document.body.innerHTML.includes(SECRET)).toBe(false);
    expectOnlyDisplayRoutes();
    expect(notifyUnauthorized).not.toHaveBeenCalled();
  });

  it("a 401 on a widget request does not reach the app's sign-in machinery: the card fails quietly and the playlist is read again at once", async () => {
    stubFetch({ widget: (_item, widget) => (widget === 1 ? 401 : 200) });
    const r = rig();
    await r.step(0);
    await r.run(8);
    expect(widgetsAsked().some((a) => a.widget === 1)).toBe(true);
    expect(notifyUnauthorized).not.toHaveBeenCalled();
    expect(count(PLAYLIST), "the 401 asks the loop to read the playlist now (not in 60 s)").toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/not valid|revoked/)).toBeNull(); // the playlist still answers 200: the screen is not revoked
    expectOnlyDisplayRoutes();
  });

  it("the wall reloads through the shared guarded reload when a new build appears, and only at a boundary", async () => {
    stubFetch({ build: (read) => (read === 1 ? "build-a" : "build-b") });
    const r = rig();
    await r.step(0);
    await r.run(60); // the second playlist read, 60 s in, carries the new build
    expect(count(PLAYLIST)).toBeGreaterThanOrEqual(2);
    expect(reloadIfServerAnswers).not.toHaveBeenCalled(); // it waits 10 to 30 s after first seeing the build, and for the next turn
    await r.run(40);
    expect(reloadIfServerAnswers).toHaveBeenCalled();
    expectOnlyDisplayRoutes();
  });
});

// The page never imports the app's request layer or sign-in (a module graph test: the text of every non-test file in src/display/).
describe("nothing in src/display/ imports the app's request layer or sign-in", () => {
  const files = readdirSync("src/display").filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name));
  const importsOf = (source: string) => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // the headers name the modules they must not import
    return [...code.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]);
  };

  it("sees the files of the page", () => {
    expect(files).toEqual(expect.arrayContaining(["DisplayApp.tsx", "displayApi.ts", "displayLoop.ts", "wallController.ts", "WallScreen.tsx", "WallCard.tsx"]));
  });

  it.each(files)("%s", (name) => {
    const specifiers = importsOf(readFileSync(`src/display/${name}`, "utf8"));
    for (const specifier of specifiers) {
      expect(specifier, `${name} imports ${specifier}`).not.toMatch(/api\/client|api\/queries|(^|\/)auth(\/|$)/);
    }
  });

  it("the guard can see an offender", () => {
    expect(importsOf('import { api } from "../api/client";\nimport type { X } from "../api/types";')).toEqual(["../api/client", "../api/types"]);
  });
});
