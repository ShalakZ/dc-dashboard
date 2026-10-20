import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, useState } from "react";
import { manualTimers } from "../test/manualTimers";
import { DisplayApp, DisplayBoundary } from "./DisplayApp";
import { claimMemoSnapshot, resetClaimMemo, startDisplay, type DisplayState } from "./displayLoop";
import { reloadClean } from "./reloadClean";
import { holdSecret } from "./secretHandle";
import { takeFragment } from "./takeFragment";

// jsdom has no navigation (location.replace is "not implemented"), so the reload after a good claim is a recorded stub.
vi.mock("./reloadClean", () => ({ reloadClean: vi.fn() }));

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
const FIFTEEN_MINUTES = 900_000;

type Reply = number | "network" | { status: number; body: unknown; headers?: Record<string, string> };
type Call = { key: string; url: string; init: RequestInit };
const events: string[] = [];
let calls: Call[] = [];

function answer(reply: Exclude<Reply, "network">): Response {
  if (typeof reply === "number") return new Response(reply === 204 ? null : JSON.stringify({ detail: "x" }), { status: reply });
  return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json", ...reply.headers } });
}
/** A 429 as the server sends it: with a `Retry-After` in seconds (or without one, or with text that is not a number). */
const tooMany = (retryAfter?: string): Reply => ({ status: 429, body: { detail: "x" }, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter } });
/** The claim's other 429, the server's "busy" (one display claiming too often): its detail is exactly the server's text, and it is not a block. */
const busy = (retryAfter?: string): Reply => ({ status: 429, body: { detail: "busy, try again" }, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter } });

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

// Every dashboard holds one TEXT widget: the wall draws it without a request (a stat would ask /api/display/widget-data, which this file's stub refuses).
const note = (id: number) => ({ id, type: "text", title: "Note", config: { style: "paragraph", text: "All is well in the hall." }, x: 0, y: 0, w: 6, h: 2 });
const playlist = (items: Array<string | null>, display = "Hall TV", name = "Wall A", dashboardName = "Ops") => ({
  status: 200,
  body: {
    display: { name: display },
    playlist: {
      name,
      items: items.map((skipped, i) => ({
        id: i + 1, seconds: 60, dashboard: skipped === "dashboard_deleted" ? null : { id: i + 1, name: dashboardName, range: "today", widgets: [note(i + 1)] }, focus: null, skipped,
      })),
    },
    site: { name: "DC Dashboard", timezone: "UTC" },
    build: "test",
    status: {},
  },
});
const three = playlist([null, null, null]);
// The connected screen is the wall: its h1 names the dashboard on screen and the header counts the dashboards it can show ("1 of 3").
const onWall = async (of: number, name = "Ops") => {
  expect(await screen.findByRole("heading", { level: 1, name })).toBeInTheDocument();
  expect(await screen.findByText(`1 of ${of}`)).toBeInTheDocument();
};
const EMPTY = "Nothing to show. Every dashboard in playlist Wall A is skipped or the playlist is empty. An administrator can change it on the Displays page.";
const NOT_CONNECTED = "This screen is not connected. Open its display link once.";
const REVOKED = "This display link was revoked or is not valid. Ask an administrator for a new link.";
const BLOCKED = "Too many wrong links from this address. Try again in about 15 minutes.";
const OFFLINE = "Cannot reach the server. Trying again...";

/**
 * The injected clocks: the LOOP's (claim and playlist poll; every delay it asked for is kept, manualTimers keeps no list) and the WALL's (rotation,
 * widget requests, wake heartbeat, cursor), which no test here moves. `props` is what DisplayApp takes.
 */
function clock() {
  const hand = manualTimers();
  const wall = manualTimers();
  const delays: number[] = [];
  const timers = {
    set: (fn: () => void, ms: number) => {
      delays.push(ms);
      return hand.timers.set(fn, ms);
    },
    clear: (handle: unknown) => hand.timers.clear(handle),
  };
  return { hand, wall, timers, delays, props: { timers, wallTimers: wall.timers } };
}

const count = (key: string) => calls.filter((call) => call.key === key).length;
/** Lets pending promises settle, for the "nothing happened" assertions. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
const advance = (c: ReturnType<typeof clock>, ms: number) => act(async () => { c.hand.advance(ms); await Promise.resolve(); });
const text = () => document.querySelector("[aria-live]")?.textContent;

beforeEach(() => {
  failure.on = false;
  events.length = 0;
  vi.mocked(reloadClean).mockReset();
  vi.mocked(reloadClean).mockImplementation(() => {
    events.push("reloadClean");
  });
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
    const handle = holdSecret(takeFragment()); // what main.tsx does first
    render(<DisplayApp handle={handle} {...c.props} />);
    await onWall(3);

    expect(events).toEqual(["replaceState", CLAIM, "reloadClean", PLAYLIST]);
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
        <DisplayApp handle={holdSecret(SECRET)} {...c.props} />
      </StrictMode>,
    );
    await onWall(3);
    expect(count(CLAIM)).toBe(1);
  });

  it("without a secret it only reads the playlist (the cookie may already be there)", async () => {
    stubFetch({ [PLAYLIST]: [three] });
    render(<DisplayApp handle={null} {...clock().props} />);
    await onWall(3);
    expect(count(CLAIM)).toBe(0);
  });

  it("retries the claim, not the playlist, when the network or the server fails it (the secret is gone from the address)", async () => {
    stubFetch({ [CLAIM]: ["network", 503, 204], [PLAYLIST]: [three] });
    const c = clock();
    render(<DisplayApp handle={holdSecret(SECRET)} {...c.props} />);
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    expect(count(PLAYLIST)).toBe(0);
    await advance(c, 5_000);
    await waitFor(() => expect(count(CLAIM)).toBe(2));
    await advance(c, 10_000);
    await onWall(3);
    expect(count(CLAIM)).toBe(3);
    expect(c.delays.slice(0, 2)).toEqual([5_000, 10_000]);
  });
});

describe("the states", () => {
  it("says it is connecting while the first answer is pending, in the same box", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    render(<DisplayApp handle={null} {...clock().props} />);
    expect(text()).toBe("Connecting...");
    const box = document.querySelector("[aria-live]");
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(box?.getAttribute("aria-live")).toBe("polite");
  });

  // Connected is the wall now (the old "Connected as ..." sentence is gone): it counts the dashboards it can SHOW, a skipped one is not among them, and
  // with none to show it says so in the one full-screen sentence.
  it.each([
    ["three dashboards", [null, null, null], 3],
    ["one skipped", [null, "dashboard_deleted", null], 2],
    ["one dashboard", [null], 1],
    ["one skipped, one shown", ["focus_gone", null], 1],
  ] as const)("connected, %s: the wall", async (_name, items, shown) => {
    stubFetch({ [PLAYLIST]: [playlist([...items])] });
    render(<DisplayApp handle={null} {...clock().props} />);
    await onWall(shown);
    expect(document.querySelector(".wall")).not.toBeNull();
    expect(document.querySelector(".display-screen")).toBeNull();
    expect(document.querySelectorAll("[aria-live]"), "no live region unless a band is up").toHaveLength(0);
  });

  it.each([
    ["two skipped", ["focus_gone", "no_widgets"]],
    ["one dashboard, skipped", ["no_widgets"]],
    ["no dashboard", []],
  ] as const)("connected, %s: the one sentence and no wall", async (_name, items) => {
    stubFetch({ [PLAYLIST]: [playlist([...items])] });
    render(<DisplayApp handle={null} {...clock().props} />);
    expect(await screen.findByText(EMPTY)).toBeInTheDocument();
    expect(document.querySelector(".display-screen")).not.toBeNull();
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(document.querySelector("[aria-live]")).toHaveTextContent(EMPTY);
    expect(document.querySelector(".wall")).toBeNull();
  });

  it("draws names as text, never markup: the dashboard's in the header, the playlist's in the empty sentence", async () => {
    stubFetch({ [PLAYLIST]: [playlist([null, null], "Wall B", "Hall <b>1</b>", "Hall <i>2</i>")] });
    render(<DisplayApp handle={null} {...clock().props} />);
    await onWall(2, "Hall <i>2</i>");
    expect(document.querySelector("b, i")).toBeNull();
    cleanup();
    stubFetch({ [PLAYLIST]: [playlist(["no_widgets"], "Wall B", "Hall <b>1</b>")] });
    render(<DisplayApp handle={null} {...clock().props} />);
    expect(await screen.findByText(/^Nothing to show\. Every dashboard in playlist Hall <b>1<\/b> is skipped/)).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
  });

  it("a 401 with no link tried says the screen is not connected", async () => {
    stubFetch({ [PLAYLIST]: [401] });
    render(<DisplayApp handle={null} {...clock().props} />);
    expect(await screen.findByText(NOT_CONNECTED)).toBeInTheDocument();
  });

  // The server tells a cookie that matches no active display (revoked, deleted, forged) from no cookie at all (review M7): after a reload of a
  // revoked screen the page cannot read the HttpOnly cookie, and "open its link once" would send the person to a link that no longer works.
  it("a 401 'this display link is not valid' with no link tried says the link was revoked, and asks again after 5 minutes, then 15", async () => {
    stubFetch({ [PLAYLIST]: [{ status: 401, body: { detail: "this display link is not valid" } }] });
    const c = clock();
    render(<DisplayApp handle={null} {...c.props} />);
    expect(await screen.findByText(REVOKED)).toBeInTheDocument();
    expect(c.delays).toEqual([FIVE_MINUTES]);
    await advance(c, FIVE_MINUTES);
    await waitFor(() => expect(count(PLAYLIST)).toBe(2));
    await settle();
    expect(text()).toBe(REVOKED);
    expect(c.delays).toEqual([FIVE_MINUTES, FIFTEEN_MINUTES]);
    expect(count(CLAIM)).toBe(0);
  });

  it.each([
    ["not connected", { status: 401, body: { detail: "not connected" } }],
    ["another sentence", { status: 401, body: { detail: "this display link is not valid, really" } }],
    ["no JSON at all", { status: 401, body: "<html>nope</html>" }],
    ["a non-text detail", { status: 401, body: { detail: ["this display link is not valid"] } }],
  ] as const)("a 401 with %s as its detail and no link tried keeps 'not connected' and the 60 second poll", async (_name, reply) => {
    stubFetch({ [PLAYLIST]: [reply] });
    const c = clock();
    render(<DisplayApp handle={null} {...c.props} />);
    expect(await screen.findByText(NOT_CONNECTED)).toBeInTheDocument();
    expect(c.delays).toEqual([60_000]);
  });

  it("a 401 'this display link is not valid' is revoked, and goes back to connected when the answer turns good", async () => {
    stubFetch({ [PLAYLIST]: [{ status: 401, body: { detail: "this display link is not valid" } }, three] });
    const c = clock();
    render(<DisplayApp handle={null} {...c.props} />);
    expect(await screen.findByText(REVOKED)).toBeInTheDocument();
    await advance(c, FIVE_MINUTES);
    await onWall(3);
  });

  it.each([401, 403, 422])("a claim answered %i says the link was revoked or is not valid", async (status) => {
    stubFetch({ [CLAIM]: [status], [PLAYLIST]: [401] });
    render(<DisplayApp handle={holdSecret(SECRET)} {...clock().props} />);
    expect(await screen.findByText(REVOKED)).toBeInTheDocument();
    expect(document.body.innerHTML.includes(SECRET)).toBe(false);
  });

  it("a 401 after the screen was connected says the link was revoked", async () => {
    stubFetch({ [PLAYLIST]: [three, 401] });
    const c = clock();
    render(<DisplayApp handle={null} {...c.props} />);
    await onWall(3);
    await advance(c, 60_000);
    expect(await screen.findByText(REVOKED)).toBeInTheDocument();
  });

  it("behind the revoked sentence the wall is stopped (no timer of its own left), and starts again with the next good read", async () => {
    stubFetch({ [PLAYLIST]: [three, 401, three] });
    const c = clock();
    render(<DisplayApp handle={null} {...c.props} />);
    await onWall(3);
    expect(c.wall.count).toBeGreaterThan(1); // the wall's tick and the page's wake heartbeat run while the wall is shown
    await advance(c, 60_000);
    expect(await screen.findByText(REVOKED)).toBeInTheDocument();
    expect(c.wall.count).toBe(1); // only the page's own wake heartbeat stays; the wall's tick is gone
    await advance(c, FIVE_MINUTES);
    await onWall(3);
    expect(c.wall.count).toBeGreaterThan(1);
  });

  it("a 401 on the playlist right after a good claim is a revoked link too (a link was tried)", async () => {
    stubFetch({ [CLAIM]: [204], [PLAYLIST]: [401] });
    render(<DisplayApp handle={holdSecret(SECRET)} {...clock().props} />);
    expect(await screen.findByText(REVOKED)).toBeInTheDocument();
  });

  it("a 429 says to try again in about 15 minutes", async () => {
    stubFetch({ [CLAIM]: [429], [PLAYLIST]: [401] });
    render(<DisplayApp handle={holdSecret(SECRET)} {...clock().props} />);
    expect(await screen.findByText(BLOCKED)).toBeInTheDocument();
  });

  it("a 429 on the playlist is busy, not blocked: it keeps the wall and asks again after the Retry-After", async () => {
    stubFetch({ [PLAYLIST]: [three, tooMany("1"), playlist([null, null, null, null])] });
    const c = clock();
    render(<DisplayApp handle={null} {...c.props} />);
    await onWall(3);
    await advance(c, 60_000);
    await waitFor(() => expect(count(PLAYLIST)).toBe(2));
    await settle();
    await onWall(3);
    expect(screen.queryByText(BLOCKED)).toBeNull();
    expect(c.delays).toEqual([60_000, 1_000]);
    await advance(c, 999);
    await settle();
    expect(count(PLAYLIST)).toBe(2);
    await advance(c, 1);
    await onWall(4);
    expect(count(PLAYLIST)).toBe(3);
  });

  it("a 429 on the very first playlist read keeps 'Connecting...' and asks again after 60 seconds when there is no Retry-After", async () => {
    stubFetch({ [PLAYLIST]: [tooMany(), three] });
    const c = clock();
    render(<DisplayApp handle={null} {...c.props} />);
    await waitFor(() => expect(count(PLAYLIST)).toBe(1));
    await settle();
    expect(text()).toBe("Connecting...");
    expect(screen.queryByText(BLOCKED)).toBeNull();
    expect(c.delays).toEqual([60_000]);
    await advance(c, 59_999);
    await settle();
    expect(count(PLAYLIST)).toBe(1);
    await advance(c, 1);
    await onWall(3);
  });

  it.each([
    ["0", 1_000],
    ["1", 1_000],
    ["30", 30_000],
    ["60", 60_000],
    ["9999", 60_000],
    ["soon", 60_000],
    ["", 60_000],
    ["-5", 60_000],
    ["Wed, 21 Oct 2026 07:28:00 GMT", 60_000],
  ])("a playlist 429 with Retry-After %j waits %i ms (clamped to 1..60 seconds, 60 when it is not a number)", async (header, wait) => {
    stubFetch({ [PLAYLIST]: [tooMany(header), three] });
    const c = clock();
    render(<DisplayApp handle={null} {...c.props} />);
    await waitFor(() => expect(c.delays).toEqual([wait]));
    await advance(c, wait);
    await onWall(3);
  });

  it("a 429 on the playlist after a good claim retries the playlist only: the claim is never made again", async () => {
    stubFetch({ [CLAIM]: [204], [PLAYLIST]: [tooMany("1"), three] });
    const c = clock();
    const handle = holdSecret(SECRET)!;
    render(<DisplayApp handle={handle} {...c.props} />);
    await waitFor(() => expect(c.delays).toEqual([1_000]));
    await settle();
    expect(text()).toBe("Connecting...");
    expect(handle.secret()).toBeNull();
    await advance(c, 1_000);
    await onWall(3);
    expect(count(CLAIM)).toBe(1);
  });

  it("a network error, then success, clears the message", async () => {
    stubFetch({ [PLAYLIST]: ["network", three] });
    const c = clock();
    render(<DisplayApp handle={null} {...c.props} />);
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    await advance(c, 5_000);
    await onWall(3);
    expect(screen.queryByText(OFFLINE)).toBeNull();
  });

  it("once the wall is up a failed read says nothing: no sentence over the dashboards, a silent retry after about 5 seconds, then the new playlist", async () => {
    stubFetch({ [PLAYLIST]: [three, "network", 503, playlist([null, null, null, null])] });
    const c = clock();
    render(<DisplayApp handle={null} {...c.props} />);
    await onWall(3);
    await advance(c, 60_000);
    await waitFor(() => expect(count(PLAYLIST)).toBe(2));
    await settle();
    expect(screen.queryByText(OFFLINE)).toBeNull();
    await onWall(3);
    expect(c.delays[1]).toBeGreaterThanOrEqual(5_000); // 5 seconds and a random 0 to 30 percent
    expect(c.delays[1]).toBeLessThanOrEqual(6_500);
    await advance(c, c.delays[1]);
    await waitFor(() => expect(count(PLAYLIST)).toBe(3));
    await settle();
    expect(screen.queryByText(OFFLINE)).toBeNull();
    expect(c.delays[2]).toBeGreaterThanOrEqual(10_000);
    expect(c.delays[2]).toBeLessThanOrEqual(13_000);
    await advance(c, c.delays[2]);
    await onWall(4);
    expect(count(PLAYLIST)).toBe(4);
    expect(screen.queryByText(OFFLINE)).toBeNull();
  });

  it("a 5xx says the server cannot be reached, and a 200 that is not a playlist does the same", async () => {
    stubFetch({ [PLAYLIST]: [500, 502, { status: 200, body: { oops: true } }] });
    const c = clock();
    render(<DisplayApp handle={null} {...c.props} />);
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
    render(<DisplayApp handle={holdSecret(SECRET)} {...clock().props} />);
    expect(document.querySelector(".display-screen"), "the full-screen states are one dark box").not.toBeNull();
    await onWall(3);
    expect(document.title).toBe("Display");
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark");
    expect(document.body.innerHTML.includes(SECRET)).toBe(false);
    expect(document.querySelector(".display-screen")).toBeNull(); // the wall is its own page
  });
});

describe("polling", () => {
  it("reads the playlist again every 60 seconds and shows the new answer", async () => {
    stubFetch({ [PLAYLIST]: [three, playlist([null, null, null, null])] });
    const c = clock();
    render(<DisplayApp handle={null} {...c.props} />);
    await onWall(3);
    await advance(c, 59_999);
    await settle();
    expect(count(PLAYLIST)).toBe(1);
    await advance(c, 1);
    await onWall(4);
    expect(count(PLAYLIST)).toBe(2);
    expect(c.delays).toEqual([60_000, 60_000].slice(0, c.delays.length));
  });

  it("a screen with no link polls the playlist every 60 seconds too", async () => {
    stubFetch({ [PLAYLIST]: [401, three] });
    const c = clock();
    render(<DisplayApp handle={null} {...c.props} />);
    expect(await screen.findByText(NOT_CONNECTED)).toBeInTheDocument();
    expect(c.delays).toEqual([60_000]);
    await advance(c, 60_000);
    await onWall(3);
  });

  it("a revoked screen asks again after 5 minutes, not before, and goes back to connected when the answer is good", async () => {
    stubFetch({ [CLAIM]: [401], [PLAYLIST]: [three] });
    const c = clock();
    render(<DisplayApp handle={holdSecret(SECRET)} {...c.props} />);
    expect(await screen.findByText(REVOKED)).toBeInTheDocument();
    expect(c.delays).toEqual([FIVE_MINUTES]);
    await advance(c, FIVE_MINUTES - 1);
    await settle();
    expect(count(PLAYLIST)).toBe(0);
    await advance(c, 1);
    await onWall(3);
    expect(c.delays).toEqual([FIVE_MINUTES, 60_000]);
    expect(count(CLAIM)).toBe(1);
  });

  it("a screen revoked later checks after 5 minutes, then 15, and stays on the text while the answer is 401", async () => {
    stubFetch({ [PLAYLIST]: [three, 401] });
    const c = clock();
    render(<DisplayApp handle={null} {...c.props} />);
    await onWall(3);
    await advance(c, 60_000);
    await screen.findByText(REVOKED);
    expect(c.delays).toEqual([60_000, FIVE_MINUTES]);
    await advance(c, FIVE_MINUTES);
    await waitFor(() => expect(count(PLAYLIST)).toBe(3));
    await settle();
    expect(text()).toBe(REVOKED);
    expect(c.delays).toEqual([60_000, FIVE_MINUTES, FIFTEEN_MINUTES]);
  });

  it("backs off 5, 10, 20, 40, 60, 60 seconds while the server cannot be reached, then starts again from 5", async () => {
    stubFetch({ [PLAYLIST]: ["network", "network", "network", "network", "network", "network", three, "network"] });
    const c = clock();
    render(<DisplayApp handle={null} {...c.props} />);
    const expected = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000];
    for (let i = 0; i < expected.length; i += 1) {
      await waitFor(() => expect(c.delays).toHaveLength(i + 1));
      expect(c.delays[i]).toBe(expected[i]);
      await advance(c, c.delays[i]);
    }
    await onWall(3);
    expect(c.delays.at(-1)).toBe(60_000); // the good answer: back to the normal poll
    await advance(c, 60_000);
    await waitFor(() => expect(c.delays).toHaveLength(8));
    await settle();
    // the wall was drawn once, so this blip is silent: the wall stays and the retry starts again from 5 s (plus its random 0 to 30 percent)
    expect(screen.queryByText(OFFLINE)).toBeNull();
    await onWall(3);
    expect(c.delays.at(-1)).toBeGreaterThanOrEqual(5_000);
    expect(c.delays.at(-1)).toBeLessThanOrEqual(6_500);
  });

  it("after a 429 on the claim it claims again in 15 minutes", async () => {
    stubFetch({ [CLAIM]: [429, 204], [PLAYLIST]: [three] });
    const c = clock();
    render(<DisplayApp handle={holdSecret(SECRET)} {...c.props} />);
    expect(await screen.findByText(BLOCKED)).toBeInTheDocument();
    expect(c.delays).toEqual([900_000]);
    await advance(c, 900_000);
    await onWall(3);
    expect(count(CLAIM)).toBe(2);
  });

  it("a 429 on the claim keeps the blocked sentence and claims again after its Retry-After, the secret still in the handle", async () => {
    stubFetch({ [CLAIM]: [tooMany("120"), 204], [PLAYLIST]: [three] });
    const c = clock();
    const handle = holdSecret(SECRET)!;
    const release = vi.spyOn(handle, "release");
    render(<DisplayApp handle={handle} {...c.props} />);
    expect(await screen.findByText(BLOCKED)).toBeInTheDocument();
    expect(c.delays).toEqual([120_000]);
    expect(release).not.toHaveBeenCalled();
    expect(handle.secret() === SECRET).toBe(true);
    await advance(c, 119_999);
    await settle();
    expect(count(CLAIM)).toBe(1);
    expect(text()).toBe(BLOCKED);
    await advance(c, 1);
    await onWall(3);
    expect(count(CLAIM)).toBe(2);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ secret: SECRET });
    expect(release).toHaveBeenCalledTimes(1);
    expect(handle.secret()).toBeNull();
  });

  it.each([
    ["1", 5_000],
    ["5", 5_000],
    ["300", 300_000],
    ["900", 900_000],
    ["99999", 900_000],
    ["soon", 900_000],
    ["", 900_000],
    ["-1", 900_000],
  ])("a claim 429 with Retry-After %j waits %i ms (clamped to 5..900 seconds, 900 when it is not a number)", async (header, wait) => {
    stubFetch({ [CLAIM]: [tooMany(header), 204], [PLAYLIST]: [three] });
    const c = clock();
    render(<DisplayApp handle={holdSecret(SECRET)} {...c.props} />);
    expect(await screen.findByText(BLOCKED)).toBeInTheDocument();
    expect(c.delays).toEqual([wait]);
    await advance(c, wait);
    await onWall(3);
    expect(count(CLAIM)).toBe(2);
  });

  it("a busy 429 on the claim is not a block: the page keeps 'Connecting...', the secret stays, and the claim is made again after 60 seconds", async () => {
    stubFetch({ [CLAIM]: [busy("60"), 204], [PLAYLIST]: [three] });
    const c = clock();
    const handle = holdSecret(SECRET)!;
    const release = vi.spyOn(handle, "release");
    render(<DisplayApp handle={handle} {...c.props} />);
    await waitFor(() => expect(count(CLAIM)).toBe(1));
    await settle();
    expect(text()).toBe("Connecting...");
    expect(screen.queryByText(BLOCKED)).toBeNull();
    expect(c.delays).toEqual([60_000]);
    expect(release).not.toHaveBeenCalled();
    expect(handle.secret() === SECRET).toBe(true);
    await advance(c, 59_999);
    await settle();
    expect(count(CLAIM)).toBe(1);
    expect(text()).toBe("Connecting...");
    await advance(c, 1);
    await onWall(3);
    expect(count(CLAIM)).toBe(2);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ secret: SECRET });
    expect(release).toHaveBeenCalledTimes(1);
    expect(handle.secret()).toBeNull();
  });

  it.each([
    ["0", 5_000],
    ["1", 5_000],
    ["5", 5_000],
    ["30", 30_000],
    ["120", 120_000],
    ["9999", 120_000],
    ["soon", 60_000],
    ["", 60_000],
    ["-5", 60_000],
  ])("a busy claim 429 with Retry-After %j waits %i ms (clamped to 5..120 seconds, 60 when it is not a number)", async (header, wait) => {
    stubFetch({ [CLAIM]: [busy(header), 204], [PLAYLIST]: [three] });
    const c = clock();
    render(<DisplayApp handle={holdSecret(SECRET)} {...c.props} />);
    await waitFor(() => expect(c.delays).toEqual([wait]));
    expect(text()).toBe("Connecting...");
    await advance(c, wait);
    await onWall(3);
    expect(count(CLAIM)).toBe(2);
  });

  it("a busy claim 429 with no Retry-After at all waits 60 seconds and never shows the blocked sentence", async () => {
    stubFetch({ [CLAIM]: [busy(), 204], [PLAYLIST]: [three] });
    const c = clock();
    render(<DisplayApp handle={holdSecret(SECRET)} {...c.props} />);
    await waitFor(() => expect(c.delays).toEqual([60_000]));
    expect(screen.queryByText(BLOCKED)).toBeNull();
    await advance(c, 60_000);
    await onWall(3);
  });

  it.each([
    ["another detail", { status: 429, body: { detail: "too many wrong links from this address" }, headers: { "Retry-After": "120" } }],
    ["a body that is not JSON (a proxy's page)", { status: 429, body: "<html>slow down</html>", headers: { "Retry-After": "120" } }],
    ["a body with no detail", { status: 429, body: {}, headers: { "Retry-After": "120" } }],
    ["a busy text that only contains the server's", { status: 429, body: { detail: "busy, try again later" }, headers: { "Retry-After": "120" } }],
  ] as const)("a claim 429 with %s is still the blocked address: the blocked sentence and the existing retry rule", async (_name, reply) => {
    stubFetch({ [CLAIM]: [reply, 204], [PLAYLIST]: [three] });
    const c = clock();
    render(<DisplayApp handle={holdSecret(SECRET)} {...c.props} />);
    expect(await screen.findByText(BLOCKED)).toBeInTheDocument();
    expect(c.delays).toEqual([120_000]);
    await advance(c, 120_000);
    await onWall(3);
  });

  it("a busy claim 429 never ends in the memo: the next try of the page can claim again, with the secret still held", async () => {
    stubFetch({ [CLAIM]: [busy("60"), busy("60"), 204], [PLAYLIST]: [three] });
    const c = clock();
    const handle = holdSecret(SECRET)!;
    render(<DisplayApp handle={handle} {...c.props} />);
    await waitFor(() => expect(count(CLAIM)).toBe(1));
    await settle();
    expect(claimMemoSnapshot(), "a busy answer is no definite answer, so it is forgotten").toBeNull();
    await advance(c, 60_000);
    await waitFor(() => expect(count(CLAIM)).toBe(2));
    await settle();
    expect(claimMemoSnapshot()).toBeNull();
    expect(text()).toBe("Connecting...");
    expect(handle.secret() === SECRET).toBe(true);
    await advance(c, 60_000);
    await onWall(3);
    expect(count(CLAIM)).toBe(3);
    expect(handle.secret()).toBeNull();
  });

  it("unmounting stops every timer and ignores a late answer", async () => {
    stubFetch({ [PLAYLIST]: [three] });
    const c = clock();
    const view = render(<DisplayApp handle={null} {...c.props} />);
    await onWall(3);
    expect(c.hand.count, "the loop's poll").toBe(1);
    expect(c.wall.count, "the wall's tick, its wake heartbeat and its cursor").toBeGreaterThan(0);
    view.unmount();
    expect(c.hand.count).toBe(0);
    expect(c.wall.count).toBe(0);
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
    render(<DisplayApp handle={null} {...c.props} />);
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark");
    expect(document.title).toBe("Display");
    expect(document.querySelector(".display-screen")).not.toBeNull();
    expect(c.delays).toEqual([5_000]);
    failure.on = false;
    stubFetch({ [PLAYLIST]: [three] });
    await advance(c, 5_000); // and the retry mounts the real screen
    await onWall(3);
  });
});

describe("the secret is released after the first definite answer", () => {
  // The secret is a test value. The checks compare, never print it.
  const carries = (call: Call) => JSON.stringify(call.init).includes(SECRET);

  it.each([
    [204, "ok"],
    [401, "refused"],
    [403, "refused"],
    [422, "refused"],
  ])("a claim answered %i releases the secret once, and nothing sent later (poll, recheck, a second mount) carries it", async (status, outcome) => {
    stubFetch({ [CLAIM]: [status], [PLAYLIST]: [three] });
    const c = clock();
    const handle = holdSecret(SECRET)!;
    const release = vi.spyOn(handle, "release");
    const view = render(<DisplayApp handle={handle} {...c.props} />);
    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    await settle();
    expect(handle.secret()).toBeNull();
    await expect(claimMemoSnapshot()?.outcome).resolves.toBe(outcome);

    // the screen mounts again (an error boundary's retry) and the clock runs on: the playlist is read, the claim is not made again
    view.unmount();
    render(<DisplayApp handle={handle} {...c.props} />);
    await settle();
    await advance(c, 300_000);
    await settle();
    await advance(c, 300_000);
    await settle();
    expect(count(CLAIM)).toBe(1);
    expect(count(PLAYLIST)).toBeGreaterThan(0);
    expect(calls.slice(1).some(carries)).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(handle.secret()).toBeNull();
  });

  it.each([
    ["a 429", 429, 900_000],
    ["a network error", "network", 5_000],
    ["a 503", 503, 5_000],
  ] as const)("%s is not a definite answer: the secret is kept and the retry sends it again", async (_name, reply, wait) => {
    stubFetch({ [CLAIM]: [reply, 204], [PLAYLIST]: [three] });
    const c = clock();
    const handle = holdSecret(SECRET)!;
    const release = vi.spyOn(handle, "release");
    render(<DisplayApp handle={handle} {...c.props} />);
    await waitFor(() => expect(count(CLAIM)).toBe(1));
    await settle();
    expect(release).not.toHaveBeenCalled();
    expect(handle.secret() === SECRET).toBe(true);
    expect(claimMemoSnapshot(), "a claim with no answer is forgotten, so the next try can be made").toBeNull();

    await advance(c, wait);
    await onWall(3);
    expect(count(CLAIM)).toBe(2);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ secret: SECRET });
    expect(release).toHaveBeenCalledTimes(1);
    expect(handle.secret()).toBeNull();
  });

  it("the memo of the claim holds the answer, never the secret: not while the claim is on its way, not after", async () => {
    let reply!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input) === "/api/display/claim" ? new Promise<Response>((resolve) => { reply = resolve; }) : Promise.resolve(answer(three)),
      ),
    );
    const handle = holdSecret(SECRET)!;
    render(<DisplayApp handle={handle} {...clock().props} />);
    await waitFor(() => expect(claimMemoSnapshot()).not.toBeNull());
    const scan = () => {
      const memo = claimMemoSnapshot()!;
      expect(JSON.stringify(memo).includes(SECRET)).toBe(false);
      expect(Object.values(memo as Record<string, unknown>).some((value) => typeof value === "string" && value.includes(SECRET))).toBe(false);
      expect(Object.keys(memo)).toEqual(["outcome"]);
    };
    scan();
    expect(handle.secret() === SECRET).toBe(true);
    await act(async () => {
      reply(answer(204));
      await claimMemoSnapshot()!.outcome;
    });
    await expect(claimMemoSnapshot()!.outcome).resolves.toBe("ok");
    scan();
    await settle();
    expect(handle.secret()).toBeNull();
    expect(JSON.stringify(handle).includes(SECRET)).toBe(false);
  });

  it("StrictMode's double effect shares one claim and releases the secret once", async () => {
    stubFetch({ [CLAIM]: [204], [PLAYLIST]: [three] });
    const handle = holdSecret(SECRET)!;
    const release = vi.spyOn(handle, "release");
    render(
      <StrictMode>
        <DisplayApp handle={handle} {...clock().props} />
      </StrictMode>,
    );
    await onWall(3);
    expect(count(CLAIM)).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(handle.secret()).toBeNull();
  });

  it("an error boundary that mounts the screen again after the answer does not claim again", async () => {
    stubFetch({ [CLAIM]: [204], [PLAYLIST]: [three] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const c = clock();
    const handle = holdSecret(SECRET);
    const boom = { on: true };
    function Probe() {
      const [state, setState] = useState<DisplayState | null>(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the probe mounts once per boundary try, like the real screen
      useEffect(() => startDisplay(handle, setState, { timers: c.timers }), []);
      if (boom.on && state?.kind === "connected") throw new Error("render failed");
      return <p aria-live="polite">{state?.kind ?? "starting"}</p>;
    }
    render(
      <DisplayBoundary timers={c.timers}>
        <Probe />
      </DisplayBoundary>,
    );
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    expect(count(CLAIM)).toBe(1);
    expect(handle?.secret()).toBeNull();

    boom.on = false;
    await advance(c, 5_000);
    expect(await screen.findByText("connected")).toBeInTheDocument();
    expect(count(CLAIM)).toBe(1);
    expect(calls.slice(1).some(carries)).toBe(false);
  });
});

describe("the page reloads without the fragment after a good claim (adversarial review M1)", () => {
  // replaceState clears the address bar, but the page's navigation entry keeps `/display#<secret>` for the document's whole life; only a new
  // document drops it. The cookie is set by then, and a load without a fragment makes no claim, so the reload cannot loop.
  const reloads = () => vi.mocked(reloadClean).mock.calls.length;

  it("a 204 reloads once, after the cookie answer, before the first playlist request, and the sentence does not change", async () => {
    window.history.replaceState(null, "", `/display#${SECRET}`);
    stubFetch({ [CLAIM]: [204], [PLAYLIST]: [three] });
    const handle = holdSecret(takeFragment());
    render(<DisplayApp handle={handle} {...clock().props} />);
    await onWall(3);
    expect(reloads()).toBe(1);
    expect(events).toEqual([CLAIM, "reloadClean", PLAYLIST]);
    expect(vi.mocked(reloadClean).mock.calls[0]).toEqual([]); // it is told nothing, above all not the secret
  });

  it.each([
    ["a 401", 401, REVOKED],
    ["a 403", 403, REVOKED],
    ["a 422", 422, REVOKED],
    ["a 429", 429, BLOCKED],
    ["a 503", 503, OFFLINE],
    ["a network error", "network", OFFLINE],
  ] as const)("%s never reloads: the page keeps its own sentence (a reload would say 'not connected')", async (_name, reply, sentence) => {
    stubFetch({ [CLAIM]: [reply], [PLAYLIST]: [three] });
    render(<DisplayApp handle={holdSecret(SECRET)} {...clock().props} />);
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    await settle();
    expect(reloads()).toBe(0);
    expect(count(CLAIM)).toBe(1);
  });

  it("a claim that had no answer reloads only when the retry is accepted, and then once", async () => {
    stubFetch({ [CLAIM]: ["network", 204], [PLAYLIST]: [three] });
    const c = clock();
    render(<DisplayApp handle={holdSecret(SECRET)} {...c.props} />);
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    expect(reloads()).toBe(0);
    await advance(c, 5_000);
    await onWall(3);
    expect(count(CLAIM)).toBe(2);
    expect(reloads()).toBe(1);
  });

  it("a screen opened without a link makes no claim and does not reload (the cookie is already there)", async () => {
    stubFetch({ [PLAYLIST]: [three] });
    render(<DisplayApp handle={null} {...clock().props} />);
    await onWall(3);
    expect(reloads()).toBe(0);
  });

  it("StrictMode's double effect reloads once", async () => {
    stubFetch({ [CLAIM]: [204], [PLAYLIST]: [three] });
    render(
      <StrictMode>
        <DisplayApp handle={holdSecret(SECRET)} {...clock().props} />
      </StrictMode>,
    );
    await onWall(3);
    expect(count(CLAIM)).toBe(1);
    expect(reloads()).toBe(1);
  });

  it("a second mount of the screen after the claim (an error boundary's retry) does not reload again", async () => {
    stubFetch({ [CLAIM]: [204], [PLAYLIST]: [three] });
    const c = clock();
    const handle = holdSecret(SECRET);
    const view = render(<DisplayApp handle={handle} {...c.props} />);
    await onWall(3);
    view.unmount();
    render(<DisplayApp handle={handle} {...c.props} />);
    await onWall(3);
    expect(count(CLAIM)).toBe(1);
    expect(reloads()).toBe(1);
  });
});

describe("the wall in the page (w29)", () => {
  it("a wake (the page becomes visible again) reads the playlist now, through the loop, and leaves the claim alone", async () => {
    stubFetch({ [CLAIM]: [204], [PLAYLIST]: [three, playlist([null, null, null, null])] });
    const c = clock();
    const handle = holdSecret(SECRET)!;
    render(<DisplayApp handle={handle} {...c.props} />);
    await onWall(3);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await onWall(4);
    expect(count(PLAYLIST)).toBe(2);
    expect(count(CLAIM)).toBe(1);
    expect(c.hand.count, "the poll timer was replaced, not doubled").toBe(1);
    expect(calls.slice(1).some((call) => JSON.stringify(call.init).includes(SECRET))).toBe(false);
  });

  it("keeps one chunk-reload listener on the window, also under StrictMode's double effect, and removes it when the page goes", async () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const net = () => added.mock.calls.filter(([type]) => type === "vite:preloadError").length - removed.mock.calls.filter(([type]) => type === "vite:preloadError").length;
    stubFetch({ [PLAYLIST]: [three] });
    const view = render(
      <StrictMode>
        <DisplayApp handle={null} {...clock().props} />
      </StrictMode>,
    );
    await onWall(3);
    expect(net()).toBe(1);
    view.unmount();
    expect(net()).toBe(0);
  });

  describe("the wake lock", () => {
    afterEach(() => { delete (navigator as unknown as Record<string, unknown>).wakeLock; });

    it("asks for the screen lock while the page is up and gives it back when it goes", async () => {
      const release = vi.fn(() => Promise.resolve());
      const request = vi.fn((_type: string) => Promise.resolve({ release }));
      Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true });
      stubFetch({ [PLAYLIST]: [three] });
      const view = render(<DisplayApp handle={null} {...clock().props} />);
      await onWall(3);
      await settle();
      expect(request).toHaveBeenCalledWith("screen");
      expect(release).not.toHaveBeenCalled();
      view.unmount();
      await settle();
      expect(release).toHaveBeenCalledTimes(1);
    });

    it("does nothing, and shows the wall all the same, in a browser with no wake lock (plain http)", async () => {
      expect("wakeLock" in navigator).toBe(false);
      stubFetch({ [PLAYLIST]: [three] });
      render(<DisplayApp handle={null} {...clock().props} />);
      await onWall(3);
    });
  });
});
