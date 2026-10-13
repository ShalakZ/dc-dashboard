import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { holdFetch } from "../test/holdFetch";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { RequireAuth } from "./RequireAuth";
import { useAuth } from "./AuthProvider";
import { useAssets } from "../api/queries";

function AssetCount() {
  const { data, error } = useAssets();
  if (error) return <p role="alert">{error.message}</p>;
  return <p>{data ? `${data.length} assets` : "loading assets"}</p>;
}

function WhoAmI() {
  const { user, hasRole } = useAuth();
  return <p>{user?.username} admin:{String(hasRole("admin"))} operator:{String(hasRole("operator"))}</p>;
}

describe("AuthProvider", () => {
  it("redirects to /setup when no user exists yet", async () => {
    mockFetch({ "GET /api/setup": { body: { needed: true } }, "GET /api/me": { status: 401, body: { detail: "x" } } });
    renderWithProviders(<RequireAuth><WhoAmI /></RequireAuth>, { route: "/assets" });
    expect(await screen.findByText("setup page")).toBeInTheDocument();
  });

  it("test_login_redirects_back_after_401: unauthenticated users go to login with the return path", async () => {
    mockFetch({ "GET /api/setup": { body: { needed: false } }, "GET /api/me": { status: 401, body: { detail: "x" } } });
    renderWithProviders(<RequireAuth><WhoAmI /></RequireAuth>, { route: "/assets/4" });
    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(sessionStorage.getItem("dcdash.returnTo")).toBe("/assets/4");
  });

  it("returns to the login page when a request answers 401 mid-session", async () => {
    mockFetch({
      "GET /api/setup": { body: { needed: false } },
      "GET /api/me": { body: { id: 1, username: "root", role: "admin" } },
      // session expired between /api/me and the page's own request
      "GET /api/assets": { status: 401, body: { detail: "not authenticated" } },
    });
    renderWithProviders(<RequireAuth><AssetCount /></RequireAuth>, { route: "/assets" });
    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(sessionStorage.getItem("dcdash.returnTo")).toBe("/assets");
  });

  it("exposes the user and role checks", async () => {
    mockFetch({
      "GET /api/setup": { body: { needed: false } },
      "GET /api/me": { body: { id: 1, username: "op", role: "operator" } },
    });
    renderWithProviders(<RequireAuth><WhoAmI /></RequireAuth>);
    await waitFor(() => expect(screen.getByText(/op admin:false operator:true/)).toBeInTheDocument());
  });
});

/** What the bootstrap (the first /api/setup and /api/me) finds: the fake server's answers, changed between events. */
const server = {
  setup: "ok" as "ok" | "needed" | "network" | 502 | 503,
  me: "ok" as "ok" | 401 | "network" | 502 | 503 | 504,
};

const bootstrapRoutes = () => ({
  "GET /api/setup": () => {
    if (server.setup === "network") throw new TypeError("Failed to fetch");
    if (typeof server.setup === "number") return { status: server.setup, body: { detail: "Bad Gateway" } };
    return { body: { needed: server.setup === "needed" } };
  },
  "GET /api/me": () => {
    if (server.me === "network") throw new TypeError("Failed to fetch");
    if (server.me === 401) return { status: 401, body: { detail: "not authenticated" } };
    if (typeof server.me === "number") return { status: server.me, body: { detail: "Bad Gateway" } };
    return { body: { id: 1, username: "u", role: "admin" } };
  },
  "POST /api/login": { body: { id: 2, username: "v", role: "viewer" } },
});

function Probe() {
  const { user, loading, unreachable, setupNeeded, retryNow, login } = useAuth();
  return (
    <>
      <p data-testid="state">{JSON.stringify({ loading, unreachable, setupNeeded, user: user?.username ?? null })}</p>
      <button type="button" onClick={retryNow}>retry</button>
      <button type="button" onClick={() => void login("v", "p")}>sign in</button>
    </>
  );
}
const read = () => JSON.parse(screen.getByTestId("state").textContent ?? "{}") as { loading: boolean; unreachable: boolean; setupNeeded: boolean; user: string | null };

/**
 * The bootstrap retries after 3, 6, 10 and then every 15 seconds. Those four delays are held back here (and the clearing of a held timer is
 * recorded) so a test fires a retry by hand; every other timer, waitFor's included, runs for real.
 */
function holdRetryTimers() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const held: { ms: number; handle: number; fire: () => void; cleared: boolean; fired: boolean }[] = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms !== 3_000 && ms !== 6_000 && ms !== 10_000 && ms !== 15_000) return realSet(fn, ms, ...rest);
    const entry = { ms, handle: 9_000_000 + held.length, cleared: false, fired: false, fire: () => { entry.fired = true; fn(); } };
    held.push(entry);
    return entry.handle as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle?: number) => {
    const entry = held.find((candidate) => candidate.handle === handle);
    if (entry) entry.cleared = true;
    else realClear(handle);
  }) as typeof clearTimeout);
  return held;
}
/** Fires the timer held at `index`, the way the clock would. */
const fire = (held: ReturnType<typeof holdRetryTimers>, index: number) => act(async () => { held[index].fire(); });

describe("AuthProvider bootstrap", () => {
  beforeEach(() => {
    Object.assign(server, { setup: "ok", me: "ok" });
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["no user exists yet", { setup: "needed", me: 401 }, { setupNeeded: true, unreachable: false, user: null }],
    ["a session", { setup: "ok", me: "ok" }, { setupNeeded: false, unreachable: false, user: "u" }],
    ["no session (401 on /api/me)", { setup: "ok", me: 401 }, { setupNeeded: false, unreachable: false, user: null }],
  ] as const)("finds %s exactly as before", async (_name, answers, expected) => {
    Object.assign(server, answers);
    const held = holdRetryTimers();
    mockFetch(bootstrapRoutes());
    renderWithProviders(<Probe />);
    await waitFor(() => expect(read().loading).toBe(false));
    expect(read()).toEqual({ loading: false, ...expected });
    expect(held).toHaveLength(0); // nothing to retry
  });

  it("a network failure on /api/setup is 'unreachable': no user, loading over, a retry in 3 s, and a later answer signs in", async () => {
    server.setup = "network";
    const held = holdRetryTimers();
    mockFetch(bootstrapRoutes());
    renderWithProviders(<Probe />);
    await waitFor(() => expect(read().unreachable).toBe(true));
    expect(read()).toEqual({ loading: false, unreachable: true, setupNeeded: false, user: null });
    expect(held.map((timer) => timer.ms)).toEqual([3_000]);

    server.setup = "ok";
    await fire(held, 0);
    await waitFor(() => expect(read().user).toBe("u"));
    expect(read()).toEqual({ loading: false, unreachable: false, setupNeeded: false, user: "u" });
    expect(held).toHaveLength(1); // no further retry
  });

  it.each([
    ["/api/me", { me: 502 }],
    ["/api/me", { me: 503 }],
    ["/api/me", { me: 504 }],
    ["/api/me", { me: "network" }],
    ["/api/setup", { setup: 502 }],
    ["/api/setup", { setup: 503 }],
  ] as const)("a failure of %s that is not an answer (%j) is 'unreachable', not a signed-out visitor", async (_path, answers) => {
    Object.assign(server, answers);
    holdRetryTimers();
    mockFetch(bootstrapRoutes());
    renderWithProviders(<Probe />);
    await waitFor(() => expect(read().unreachable).toBe(true));
    expect(read()).toEqual({ loading: false, unreachable: true, setupNeeded: false, user: null });
  });

  it("retries after 3 s, 6 s, 10 s and then every 15 s while the server stays away, then finds a signed-out visitor when the server says 401", async () => {
    server.setup = "network";
    const held = holdRetryTimers();
    mockFetch(bootstrapRoutes());
    renderWithProviders(<Probe />);
    await waitFor(() => expect(held).toHaveLength(1));
    for (let i = 0; i < 5; i += 1) {
      await fire(held, i);
      await waitFor(() => expect(held).toHaveLength(i + 2));
    }
    expect(held.map((timer) => timer.ms)).toEqual([3_000, 6_000, 10_000, 15_000, 15_000, 15_000]);
    expect(read().unreachable).toBe(true);

    Object.assign(server, { setup: "ok", me: 401 });
    await fire(held, 5);
    await waitFor(() => expect(read().unreachable).toBe(false));
    expect(read()).toEqual({ loading: false, unreachable: false, setupNeeded: false, user: null }); // a 401 is signed out, as before; it never signs anyone in
    expect(held).toHaveLength(6);
  });

  it("an answer on a retry that says a first user is needed sets that up", async () => {
    server.me = 502;
    const held = holdRetryTimers();
    mockFetch(bootstrapRoutes());
    renderWithProviders(<Probe />);
    await waitFor(() => expect(read().unreachable).toBe(true));
    server.setup = "needed";
    await fire(held, 0);
    await waitFor(() => expect(read().setupNeeded).toBe(true));
    expect(read()).toEqual({ loading: false, unreachable: false, setupNeeded: true, user: null });
  });

  it("never signs anyone in on an error: the user stays null for as long as the server stays away", async () => {
    server.me = 502;
    const held = holdRetryTimers();
    mockFetch(bootstrapRoutes());
    renderWithProviders(<Probe />);
    await waitFor(() => expect(read().unreachable).toBe(true));
    await fire(held, 0);
    await waitFor(() => expect(held).toHaveLength(2));
    expect(read().user).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("unmounting cancels the retry: its timer is cleared and a late firing asks for nothing", async () => {
    server.setup = "network";
    const held = holdRetryTimers();
    const calls = mockFetch(bootstrapRoutes());
    const { unmount } = renderWithProviders(<Probe />);
    await waitFor(() => expect(held).toHaveLength(1));
    const asked = calls.length;
    unmount();
    expect(held[0].cleared).toBe(true);
    await fire(held, 0); // as if the clear had come too late
    expect(calls).toHaveLength(asked);
  });

  it("retryNow asks at once and takes the place of the waiting retry; while that request is out, another press starts no second one", async () => {
    server.setup = "network";
    const held = holdRetryTimers();
    mockFetch(bootstrapRoutes());
    renderWithProviders(<Probe />);
    await waitFor(() => expect(held).toHaveLength(1));

    let started = 0;
    const gate = holdFetch((_method, path) => {
      if (path === "/api/setup") started += 1;
      return path === "/api/setup";
    });
    server.setup = "ok";
    await userEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(started).toBe(1);
    expect(held[0].cleared).toBe(true); // the 3 s retry is not left waiting behind it
    await userEvent.click(screen.getByRole("button", { name: "retry" }));
    await userEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(started).toBe(1);

    await act(async () => { gate.release(); });
    await waitFor(() => expect(read().user).toBe("u"));
    expect(read().unreachable).toBe(false);
    expect(started).toBe(1);
  });

  it("a person who signs in while the server is unreachable (on the sign-in page) ends the retrying and the unreachable state", async () => {
    server.setup = "network";
    const held = holdRetryTimers();
    mockFetch(bootstrapRoutes());
    renderWithProviders(<Probe />);
    await waitFor(() => expect(held).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "sign in" }));
    await waitFor(() => expect(read().user).toBe("v"));
    expect(read().unreachable).toBe(false);
    expect(held[0].cleared).toBe(true);
    server.setup = "ok";
    await fire(held, 0); // a stale firing must not ask again or replace them
    await userEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(read().user).toBe("v");
    expect(held).toHaveLength(1);
  });
});
