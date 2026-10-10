import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../api/client";
import type { Role } from "../api/types";
import { RoleChangedNotice } from "../components/RoleChangedNotice";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { useAuth } from "./AuthProvider";
import { useQueryClient } from "@tanstack/react-query";

/** What the fake server answers; tests change it between events. */
const server = {
  me: "ok" as "ok" | 401 | "network",
  role: "operator" as Role,
  loginStatus: 200,
  loginRole: "viewer" as Role,
  assetsStatus: 403,
};

const routes = () => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": () => {
    if (server.me === "network") throw new TypeError("Failed to fetch");
    if (server.me === 401) return { status: 401, body: { detail: "not authenticated" } };
    return { body: { id: 1, username: "u", role: server.role } };
  },
  "POST /api/login": () =>
    server.loginStatus === 200
      ? { body: { id: 2, username: "v", role: server.loginRole } }
      : { status: server.loginStatus, body: { detail: "nope" } },
  "POST /api/logout": { status: 204 },
  "GET /api/assets": () => ({ status: server.assetsStatus, body: { detail: "insufficient role" } }),
});

interface Capture {
  /** Every distinct roleChange object the page has been handed (by identity). */
  seen: Set<unknown>;
  client?: QueryClient;
}

function Harness({ capture }: { capture: Capture }) {
  const { user, roleChange, login, logout } = useAuth();
  capture.client = useQueryClient();
  if (roleChange) capture.seen.add(roleChange);
  return (
    <>
      <p>{user ? `${user.username} (${user.role})` : "signed out"}</p>
      <button onClick={() => void api.get("/api/assets").catch(() => {})}>load assets</button>
      <button onClick={() => void login("v", "p").catch(() => {})}>sign in</button>
      <button onClick={() => void logout()}>sign out</button>
      <RoleChangedNotice />
    </>
  );
}

let calls: ReturnType<typeof mockFetch>;
const meCalls = () => calls.filter((c) => c.method === "GET" && c.path === "/api/me").length;
const focus = () => act(() => { fireEvent.focus(window); });
/** Let any request started by the last event finish, so "nothing happened" really means nothing. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

async function open(): Promise<Capture> {
  calls = mockFetch(routes());
  const capture: Capture = { seen: new Set() };
  renderWithProviders(<Harness capture={capture} />);
  await screen.findByText(`u (${server.role})`);
  return capture;
}

beforeEach(() => {
  Object.assign(server, { me: "ok", role: "operator", loginStatus: 200, loginRole: "viewer", assetsStatus: 403 });
  vi.useFakeTimers({ toFake: ["Date"] }); // only the clock: waitFor and fetch keep running on real timers
  vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AuthProvider refresh on focus", () => {
  it("fetches /api/me once when the window gains focus", async () => {
    await open();
    expect(meCalls()).toBe(1);
    await focus();
    await waitFor(() => expect(meCalls()).toBe(2));
    await settle();
    expect(meCalls()).toBe(2);
  });

  it("fetches when the tab becomes visible, not when it becomes hidden", async () => {
    await open();
    const setVisibility = (state: string) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    };
    try {
      setVisibility("hidden");
      await settle();
      expect(meCalls()).toBe(1);
      setVisibility("visible");
      await waitFor(() => expect(meCalls()).toBe(2));
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  it("fetches once for a burst of five focus events within 10 seconds, and again after the 10 seconds", async () => {
    await open();
    for (let i = 0; i < 5; i += 1) await focus();
    await settle();
    expect(meCalls()).toBe(2);
    later(9_000);
    await focus();
    await settle();
    expect(meCalls()).toBe(2);
    later(1_500);
    await focus();
    await waitFor(() => expect(meCalls()).toBe(3));
  });

  it("shows no banner when the role is the same", async () => {
    await open();
    await focus();
    await waitFor(() => expect(meCalls()).toBe(2));
    await settle();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("announces a changed role with both roles and leaves the user object alone", async () => {
    const capture = await open();
    server.role = "viewer";
    await focus();
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("Your role changed from operator to viewer. Reload the page to continue.");
    expect(screen.getByText("u (operator)")).toBeInTheDocument(); // nothing under an open editor moved
    expect(capture.seen.size).toBe(1);
  });

  it("announces the same new role once: a second refresh does not hand the page a new announcement", async () => {
    const capture = await open();
    server.role = "viewer";
    await focus();
    await screen.findByRole("status");
    later(11_000);
    await focus();
    await waitFor(() => expect(meCalls()).toBe(3));
    await settle();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(capture.seen.size).toBe(1);
  });

  it("says so again when the role changes again, still measured from the role the page loaded with", async () => {
    await open();
    server.role = "viewer";
    await focus();
    await screen.findByText(/changed from operator to viewer/);
    later(11_000);
    server.role = "admin";
    await focus();
    expect(await screen.findByText(/changed from operator to admin/)).toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("takes the banner away when the role is back to the one the page loaded with", async () => {
    await open();
    server.role = "viewer";
    await focus();
    await screen.findByRole("status");
    later(11_000);
    server.role = "operator";
    await focus();
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("signs out, with no banner, when /api/me answers 401 during a refresh", async () => {
    const capture = await open();
    capture.client!.setQueryData(["probe"], "cached");
    server.me = 401;
    await focus();
    expect(await screen.findByText("signed out")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(capture.client!.getQueryData(["probe"])).toBeUndefined();
  });

  it("ignores a network error: still signed in, no banner", async () => {
    await open();
    server.me = "network";
    await focus();
    await waitFor(() => expect(meCalls()).toBe(2));
    await settle();
    expect(screen.getByText("u (operator)")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not fetch while signed out", async () => {
    server.me = 401;
    calls = mockFetch(routes());
    renderWithProviders(<Harness capture={{ seen: new Set() }} />);
    await screen.findByText("signed out");
    expect(meCalls()).toBe(1);
    await focus();
    later(11_000);
    await focus();
    await settle();
    expect(meCalls()).toBe(1);
  });

  it("does not call signing out and signing in as someone else a role change", async () => {
    const user = userEvent.setup({ advanceTimers: (ms) => vi.setSystemTime(Date.now() + ms) });
    const capture = await open();
    server.role = "viewer";
    await focus();
    await screen.findByRole("status"); // a banner from the first session
    await user.click(screen.getByRole("button", { name: "sign out" }));
    await screen.findByText("signed out");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "sign in" }));
    await screen.findByText("v (viewer)");
    later(11_000);
    await focus();
    await waitFor(() => expect(meCalls()).toBe(3));
    await settle();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(capture.seen.size).toBe(1); // only the first session's announcement ever existed
  });
});

describe("AuthProvider refresh racing a sign-out", () => {
  it("drops an answer that arrives after the user signed out", async () => {
    await open();
    const inner = fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("/api/me") ? gate.then(() => inner(input, init)) : inner(input, init));
    server.role = "viewer";
    await focus();
    await userEvent.setup().click(screen.getByRole("button", { name: "sign out" }));
    await screen.findByText("signed out");
    release();
    await settle();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("signed out")).toBeInTheDocument();
  });
});

describe("AuthProvider refresh after a 403", () => {
  it("refetches /api/me when another request is answered 403", async () => {
    await open();
    await userEvent.setup({ advanceTimers: later }).click(screen.getByRole("button", { name: "load assets" }));
    await waitFor(() => expect(meCalls()).toBe(2));
  });

  it("finds the role change behind the 403 and announces it", async () => {
    await open();
    server.role = "viewer";
    await userEvent.setup({ advanceTimers: later }).click(screen.getByRole("button", { name: "load assets" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Your role changed from operator to viewer");
  });

  it("does not refetch for a 403 from /api/login (a wrong-credentials style answer)", async () => {
    server.loginStatus = 403;
    await open();
    await userEvent.setup({ advanceTimers: later }).click(screen.getByRole("button", { name: "sign in" }));
    await settle();
    expect(calls.some((c) => c.path === "/api/login")).toBe(true);
    expect(meCalls()).toBe(1);
  });

  it("shares the 10 second limit with the focus refresh", async () => {
    await open();
    await focus();
    await waitFor(() => expect(meCalls()).toBe(2));
    await userEvent.setup({ advanceTimers: later }).click(screen.getByRole("button", { name: "load assets" }));
    await settle();
    expect(meCalls()).toBe(2);
    later(10_500);
    await userEvent.setup({ advanceTimers: later }).click(screen.getByRole("button", { name: "load assets" }));
    await waitFor(() => expect(meCalls()).toBe(3));
  });
});
