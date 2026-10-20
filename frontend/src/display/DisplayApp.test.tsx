import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { manualTimers } from "../test/manualTimers";
import { DisplayApp, DisplayBoundary } from "./DisplayApp";
import { resetClaimMemo } from "./displayLoop";
import { takeFragment } from "./takeFragment";

// Lets one test make the screen's effect fail, to prove the boundary's fallback is still a dark, titled screen.
const failure = vi.hoisted(() => ({ on: false }));
vi.mock("./displayLoop", async (importOriginal) => {
  const real = await importOriginal<typeof import("./displayLoop")>();
  return {
    ...real,
    startDisplay: (...args: Parameters<typeof real.startDisplay>) => {
      if (failure.on) throw new Error("effect failed");
      return real.startDisplay(...args);
    },
  };
});

// A recording fetch for the two display routes. Anything else (above all /api/me) throws, and the test then fails on the text it expects.
// The secret in these tests is a test value; no message below prints it.
const SECRET = "abc_DEF-123";
const CLAIM = "POST /api/display/claim";
const PLAYLIST = "GET /api/display/playlist";
const FIVE_MINUTES = 300_000;

type Reply = number | "network" | { status: number; body: unknown };
type Call = { key: string; url: string; init: RequestInit };
const events: string[] = [];
let calls: Call[] = [];

function answer(reply: Exclude<Reply, "network">): Response {
  if (typeof reply === "number") return new Response(reply === 204 ? null : JSON.stringify({ detail: "x" }), { status: reply });
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
}

/** One queue of replies per route; the last one repeats. */
function stubFetch(script: Partial<Record<string, Reply[]>>) {
  calls = [];
  const left = new Map(Object.entries(script).map(([key, replies]) => [key, [...replies!]]));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const key = `${(init.method ?? "GET").toUpperCase()} ${url}`;
      calls.push({ key, url, init });
      events.push(key);
      const queue = left.get(key);
      if (!queue) throw new Error(`unexpected request ${key}`);
      const reply = queue.length > 1 ? queue.shift()! : queue[0];
      if (reply === "network") throw new TypeError("Failed to fetch");
      return answer(reply);
    }),
  );
}

const playlist = (items: Array<string | null>, display = "Hall TV", name = "Wall A") => ({
  status: 200,
  body: {
    display: { name: display },
    playlist: {
      name,
      items: items.map((skipped, i) => ({ id: i + 1, seconds: 60, dashboard: skipped === "dashboard_deleted" ? null : { id: 1, name: "Ops", range: "today", widgets: [] }, focus: null, skipped })),
    },
    site: { name: "DC Dashboard", timezone: "UTC" },
    build: "test",
    status: {},
  },
});
const three = playlist([null, null, null]);
const connected = (dashboards: string, skipped = "") =>
  `Connected as Hall TV. Playlist Wall A: ${dashboards}${skipped}. The rotating screen arrives in the next update.`;
const NOT_CONNECTED = "This screen is not connected. Open its display link once.";
const REVOKED = "This display link was revoked or is not valid. Ask an administrator for a new link.";
const BLOCKED = "Too many wrong links from this address. Try again in about 15 minutes.";
const OFFLINE = "Cannot reach the server. Trying again...";

/** The injected clock, plus every delay the page asked for (manualTimers keeps no list of them). */
function clock() {
  const hand = manualTimers();
  const delays: number[] = [];
  const timers = {
    set: (fn: () => void, ms: number) => {
      delays.push(ms);
      return hand.timers.set(fn, ms);
    },
    clear: (handle: unknown) => hand.timers.clear(handle),
  };
  return { hand, timers, delays };
}

const count = (key: string) => calls.filter((call) => call.key === key).length;
/** Lets pending promises settle, for the "nothing happened" assertions. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
const advance = (c: ReturnType<typeof clock>, ms: number) => act(async () => { c.hand.advance(ms); await Promise.resolve(); });
const text = () => document.querySelector("[aria-live]")?.textContent;

beforeEach(() => {
  failure.on = false;
  events.length = 0;
  resetClaimMemo();
  window.history.replaceState(null, "", "/display");
});

afterEach(() => {
  // the page never asks for anything but its two routes (above all not /api/me, which would mean an AuthProvider)
  for (const call of calls) expect(["POST /api/display/claim", "GET /api/display/playlist"], call.key).toContain(call.key);
  calls = [];
});

describe("the claim flow", () => {
  it("clears the address before any request, posts the secret in a JSON body, then reads the playlist; the secret is nowhere else", async () => {
    window.history.replaceState(null, "", `/display#${SECRET}`);
    const original = window.history.replaceState.bind(window.history);
    vi.spyOn(window.history, "replaceState").mockImplementation((...args) => {
      events.push("replaceState");
      original(...args);
    });
    stubFetch({ [CLAIM]: [204], [PLAYLIST]: [three] });
    const c = clock();
    const secret = takeFragment(); // what main.tsx does first
    render(<DisplayApp secret={secret} timers={c.timers} />);
    expect(await screen.findByText(connected("3 dashboards"))).toBeInTheDocument();

    expect(events).toEqual(["replaceState", CLAIM, PLAYLIST]);
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain("#");
    expect(window.location.pathname).toBe("/display");

    const claim = calls[0];
    expect(JSON.parse(String(claim.init.body))).toEqual({ secret: SECRET });
    expect(claim.init.credentials).toBe("same-origin");
    expect(claim.init.cache).toBe("no-store");
    expect(new Headers(claim.init.headers).get("content-type")).toMatch(/^application\/json/);
    for (const call of calls) {
      expect(call.url.includes(SECRET), "the secret in a URL").toBe(false);
      expect(new Headers(call.init.headers).has("authorization"), "an Authorization header").toBe(false);
      expect(JSON.stringify(call.init.headers ?? {}).includes(SECRET), "the secret in a header").toBe(false);
      expect(call.init.credentials).toBe("same-origin");
      expect(call.init.cache).toBe("no-store");
    }
    expect(calls[1].init.body, "the playlist read carries no body").toBeUndefined();
    expect(document.body.innerHTML.includes(SECRET), "the secret in the page").toBe(false);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("posts the claim once when StrictMode runs the effect twice", async () => {
    stubFetch({ [CLAIM]: [204], [PLAYLIST]: [three] });
    const c = clock();
    render(
      <StrictMode>
        <DisplayApp secret={SECRET} timers={c.timers} />
      </StrictMode>,
    );
    expect(await screen.findByText(connected("3 dashboards"))).toBeInTheDocument();
    expect(count(CLAIM)).toBe(1);
  });

  it("without a secret it only reads the playlist (the cookie may already be there)", async () => {
    stubFetch({ [PLAYLIST]: [three] });
    render(<DisplayApp secret={null} timers={clock().timers} />);
    expect(await screen.findByText(connected("3 dashboards"))).toBeInTheDocument();
    expect(count(CLAIM)).toBe(0);
  });

  it("retries the claim, not the playlist, when the network or the server fails it (the secret is gone from the address)", async () => {
    stubFetch({ [CLAIM]: ["network", 503, 204], [PLAYLIST]: [three] });
    const c = clock();
    render(<DisplayApp secret={SECRET} timers={c.timers} />);
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    expect(count(PLAYLIST)).toBe(0);
    await advance(c, 5_000);
    await waitFor(() => expect(count(CLAIM)).toBe(2));
    await advance(c, 10_000);
    expect(await screen.findByText(connected("3 dashboards"))).toBeInTheDocument();
    expect(count(CLAIM)).toBe(3);
    expect(c.delays.slice(0, 2)).toEqual([5_000, 10_000]);
  });
});

describe("the states", () => {
  it("says it is connecting while the first answer is pending, in the same box", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    render(<DisplayApp secret={null} timers={clock().timers} />);
    expect(text()).toBe("Connecting...");
    const box = document.querySelector("[aria-live]");
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(box?.getAttribute("aria-live")).toBe("polite");
  });

  it.each([
    ["three dashboards", [null, null, null], connected("3 dashboards")],
    ["one skipped", [null, "dashboard_deleted", null], connected("3 dashboards", " (1 skipped)")],
    ["two skipped", ["focus_gone", "no_widgets"], connected("2 dashboards", " (2 skipped)")],
    ["one dashboard (singular)", [null], connected("1 dashboard")],
    ["one dashboard, skipped", ["no_widgets"], connected("1 dashboard", " (1 skipped)")],
    ["no dashboard", [], connected("0 dashboards")],
  ])("connected, %s", async (_name, items, expected) => {
    stubFetch({ [PLAYLIST]: [playlist(items)] });
    render(<DisplayApp secret={null} timers={clock().timers} />);
    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(document.querySelector("[aria-live]")).toHaveTextContent(expected);
  });

  it("names the display and the playlist from the answer", async () => {
    stubFetch({ [PLAYLIST]: [playlist([null, null], "Wall B", "Hall <b>1</b>")] });
    render(<DisplayApp secret={null} timers={clock().timers} />);
    expect(await screen.findByText("Connected as Wall B. Playlist Hall <b>1</b>: 2 dashboards. The rotating screen arrives in the next update.")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull(); // a name is text, never markup
  });

  it("a 401 with no link tried says the screen is not connected", async () => {
    stubFetch({ [PLAYLIST]: [401] });
    render(<DisplayApp secret={null} timers={clock().timers} />);
    expect(await screen.findByText(NOT_CONNECTED)).toBeInTheDocument();
  });

  it.each([401, 403, 422])("a claim answered %i says the link was revoked or is not valid", async (status) => {
    stubFetch({ [CLAIM]: [status], [PLAYLIST]: [401] });
    render(<DisplayApp secret={SECRET} timers={clock().timers} />);
    expect(await screen.findByText(REVOKED)).toBeInTheDocument();
    expect(document.body.innerHTML.includes(SECRET)).toBe(false);
  });

  it("a 401 after the screen was connected says the link was revoked", async () => {
    stubFetch({ [PLAYLIST]: [three, 401] });
    const c = clock();
    render(<DisplayApp secret={null} timers={c.timers} />);
    expect(await screen.findByText(connected("3 dashboards"))).toBeInTheDocument();
    await advance(c, 60_000);
    expect(await screen.findByText(REVOKED)).toBeInTheDocument();
  });

  it("a 401 on the playlist right after a good claim is a revoked link too (a link was tried)", async () => {
    stubFetch({ [CLAIM]: [204], [PLAYLIST]: [401] });
    render(<DisplayApp secret={SECRET} timers={clock().timers} />);
    expect(await screen.findByText(REVOKED)).toBeInTheDocument();
  });

  it("a 429 says to try again in about 15 minutes", async () => {
    stubFetch({ [CLAIM]: [429], [PLAYLIST]: [401] });
    render(<DisplayApp secret={SECRET} timers={clock().timers} />);
    expect(await screen.findByText(BLOCKED)).toBeInTheDocument();
  });

  it("a 429 on the playlist says it too, and asks again in a minute (its own limit lifts within one)", async () => {
    stubFetch({ [PLAYLIST]: [429, three] });
    const c = clock();
    render(<DisplayApp secret={null} timers={c.timers} />);
    expect(await screen.findByText(BLOCKED)).toBeInTheDocument();
    expect(c.delays).toEqual([60_000]);
    await advance(c, 60_000);
    expect(await screen.findByText(connected("3 dashboards"))).toBeInTheDocument();
  });

  it("a network error, then success, clears the message", async () => {
    stubFetch({ [PLAYLIST]: ["network", three] });
    const c = clock();
    render(<DisplayApp secret={null} timers={c.timers} />);
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    await advance(c, 5_000);
    expect(await screen.findByText(connected("3 dashboards"))).toBeInTheDocument();
    expect(screen.queryByText(OFFLINE)).toBeNull();
  });

  it("a 5xx says the server cannot be reached, and a 200 that is not a playlist does the same", async () => {
    stubFetch({ [PLAYLIST]: [500, 502, { status: 200, body: { oops: true } }] });
    const c = clock();
    render(<DisplayApp secret={null} timers={c.timers} />);
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    await advance(c, 5_000);
    await waitFor(() => expect(count(PLAYLIST)).toBe(2));
    await advance(c, 10_000);
    await waitFor(() => expect(count(PLAYLIST)).toBe(3));
    await settle();
    expect(text()).toBe(OFFLINE);
    expect(c.delays).toEqual([5_000, 10_000, 20_000]);
  });

  it("sets the title, a dark look on <html>, and keeps the secret out of the page for every state", async () => {
    stubFetch({ [CLAIM]: [204], [PLAYLIST]: [three] });
    render(<DisplayApp secret={SECRET} timers={clock().timers} />);
    await screen.findByText(connected("3 dashboards"));
    expect(document.title).toBe("Display");
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark");
    expect(document.body.innerHTML.includes(SECRET)).toBe(false);
    expect(document.querySelector(".display-screen")).not.toBeNull();
  });
});

describe("polling", () => {
  it("reads the playlist again every 60 seconds and shows the new answer", async () => {
    stubFetch({ [PLAYLIST]: [three, playlist([null, null, null, null])] });
    const c = clock();
    render(<DisplayApp secret={null} timers={c.timers} />);
    expect(await screen.findByText(connected("3 dashboards"))).toBeInTheDocument();
    await advance(c, 59_999);
    await settle();
    expect(count(PLAYLIST)).toBe(1);
    await advance(c, 1);
    expect(await screen.findByText(connected("4 dashboards"))).toBeInTheDocument();
    expect(count(PLAYLIST)).toBe(2);
    expect(c.delays).toEqual([60_000, 60_000].slice(0, c.delays.length));
  });

  it("a screen with no link polls the playlist every 60 seconds too", async () => {
    stubFetch({ [PLAYLIST]: [401, three] });
    const c = clock();
    render(<DisplayApp secret={null} timers={c.timers} />);
    expect(await screen.findByText(NOT_CONNECTED)).toBeInTheDocument();
    expect(c.delays).toEqual([60_000]);
    await advance(c, 60_000);
    expect(await screen.findByText(connected("3 dashboards"))).toBeInTheDocument();
  });

  it("a revoked screen asks again after 5 minutes, not before, and goes back to connected when the answer is good", async () => {
    stubFetch({ [CLAIM]: [401], [PLAYLIST]: [three] });
    const c = clock();
    render(<DisplayApp secret={SECRET} timers={c.timers} />);
    expect(await screen.findByText(REVOKED)).toBeInTheDocument();
    expect(c.delays).toEqual([FIVE_MINUTES]);
    await advance(c, FIVE_MINUTES - 1);
    await settle();
    expect(count(PLAYLIST)).toBe(0);
    await advance(c, 1);
    expect(await screen.findByText(connected("3 dashboards"))).toBeInTheDocument();
    expect(c.delays).toEqual([FIVE_MINUTES, 60_000]);
    expect(count(CLAIM)).toBe(1);
  });

  it("a screen revoked later checks every 5 minutes and stays on the text while the answer is 401", async () => {
    stubFetch({ [PLAYLIST]: [three, 401] });
    const c = clock();
    render(<DisplayApp secret={null} timers={c.timers} />);
    await screen.findByText(connected("3 dashboards"));
    await advance(c, 60_000);
    await screen.findByText(REVOKED);
    expect(c.delays).toEqual([60_000, FIVE_MINUTES]);
    await advance(c, FIVE_MINUTES);
    await waitFor(() => expect(count(PLAYLIST)).toBe(3));
    await settle();
    expect(text()).toBe(REVOKED);
    expect(c.delays).toEqual([60_000, FIVE_MINUTES, FIVE_MINUTES]);
  });

  it("backs off 5, 10, 20, 40, 60, 60 seconds while the server cannot be reached, then starts again from 5", async () => {
    stubFetch({ [PLAYLIST]: ["network", "network", "network", "network", "network", "network", three, "network"] });
    const c = clock();
    render(<DisplayApp secret={null} timers={c.timers} />);
    const expected = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000];
    for (let i = 0; i < expected.length; i += 1) {
      await waitFor(() => expect(c.delays).toHaveLength(i + 1));
      expect(c.delays[i]).toBe(expected[i]);
      await advance(c, c.delays[i]);
    }
    expect(await screen.findByText(connected("3 dashboards"))).toBeInTheDocument();
    expect(c.delays.at(-1)).toBe(60_000); // the good answer: back to the normal poll
    await advance(c, 60_000);
    await screen.findByText(OFFLINE);
    expect(c.delays.at(-1)).toBe(5_000); // and the backoff began again from the start
  });

  it("after a 429 on the claim it claims again in 15 minutes", async () => {
    stubFetch({ [CLAIM]: [429, 204], [PLAYLIST]: [three] });
    const c = clock();
    render(<DisplayApp secret={SECRET} timers={c.timers} />);
    expect(await screen.findByText(BLOCKED)).toBeInTheDocument();
    expect(c.delays).toEqual([900_000]);
    await advance(c, 900_000);
    expect(await screen.findByText(connected("3 dashboards"))).toBeInTheDocument();
    expect(count(CLAIM)).toBe(2);
  });

  it("unmounting stops every timer and ignores a late answer", async () => {
    stubFetch({ [PLAYLIST]: [three] });
    const c = clock();
    const view = render(<DisplayApp secret={null} timers={c.timers} />);
    await screen.findByText(connected("3 dashboards"));
    expect(c.hand.count).toBe(1);
    view.unmount();
    expect(c.hand.count).toBe(0);
  });
});

describe("the error boundary", () => {
  it("shows the offline sentence instead of a blank page, and tries the screen again", async () => {
    const c = clock();
    let broken = true;
    function Flaky() {
      // React renders a failed first render once more by itself, so the flag (not a counter) decides
      if (broken) throw new Error("render failed");
      return <p aria-live="polite">rendered again</p>;
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <DisplayBoundary timers={c.timers}>
        <Flaky />
      </DisplayBoundary>,
    );
    expect(screen.getByText(OFFLINE)).toBeInTheDocument();
    expect(c.delays).toEqual([5_000]);
    broken = false;
    await advance(c, 5_000);
    expect(await screen.findByText("rendered again")).toBeInTheDocument();
    expect(screen.queryByText(OFFLINE)).toBeNull();
  });

  it("the fallback is on a dark, titled screen too: the look is set by DisplayApp, outside the boundary", async () => {
    document.documentElement.setAttribute("data-mode", "light"); // what theme-init paints on a kiosk that never chose a look
    failure.on = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const c = clock();
    render(<DisplayApp secret={null} timers={c.timers} />);
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark");
    expect(document.title).toBe("Display");
    expect(document.querySelector(".display-screen")).not.toBeNull();
    expect(c.delays).toEqual([5_000]);
    failure.on = false;
    stubFetch({ [PLAYLIST]: [three] });
    await advance(c, 5_000); // and the retry mounts the real screen
    expect(await screen.findByText(connected("3 dashboards"))).toBeInTheDocument();
  });
});
