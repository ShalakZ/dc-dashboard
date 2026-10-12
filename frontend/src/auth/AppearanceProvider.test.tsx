import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { MIRROR_KEY, type Appearance } from "../lib/appearance";
import { renderWithProviders } from "../test/render";
import { AppearanceProvider, useAppearance } from "./AppearanceProvider";
import { AuthProvider, useAuth } from "./AuthProvider";

const html = document.documentElement;
const look = () => `${html.getAttribute("data-mode")}/${html.getAttribute("data-theme")}`;
const mirror = () => localStorage.getItem(MIRROR_KEY);
const LIGHT_NAVY: Appearance = { mode: "light", theme: "navy-gold" };

type Reply = { status?: number; body?: unknown };
type Held = { body: Record<string, string>; reply(reply: Reply): void };

/** A server whose GET /api/me answers `server.me` (null = 401) and whose preference saves wait until the test answers them. */
function startServer(me: { id: number; username: string; role: string; preferences: Appearance } | null) {
  const server = {
    me,
    loginAs: null as { id: number; username: string; role: string; preferences: Appearance } | null,
    puts: [] as Held[],
    meCalls: 0,
  };
  const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split("?")[0];
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && path === "/api/setup") return Promise.resolve(json(200, { needed: false }));
      if (method === "GET" && path === "/api/me") {
        server.meCalls += 1;
        return Promise.resolve(server.me ? json(200, server.me) : json(401, { detail: "not authenticated" }));
      }
      if (method === "POST" && path === "/api/login") return Promise.resolve(json(200, server.loginAs));
      if (method === "POST" && path === "/api/logout") return Promise.resolve(json(204, null));
      if (method === "PUT" && path === "/api/me/preferences") {
        return new Promise<Response>((resolve) => {
          server.puts.push({ body: JSON.parse(String(init?.body)), reply: ({ status = 200, body = {} }) => resolve(json(status, body)) });
        });
      }
      return Promise.resolve(json(500, { detail: `no mock for ${method} ${path}` }));
    }),
  );
  return server;
}

const user = (name: string, preferences: Appearance) => ({ id: name === "ann" ? 1 : 2, username: name, role: "admin", preferences });

function Probe() {
  const { mode, theme, dark, setMode, setTheme, error } = useAppearance();
  const { user: who, loading, login, logout } = useAuth();
  return (
    <>
      <p data-testid="state">{`${mode}/${theme}/${dark ? "dark" : "light"}`}</p>
      <p data-testid="who">{loading ? "loading" : (who?.username ?? "nobody")}</p>
      {error && <p role="alert">{error}</p>}
      <button onClick={() => setMode("light")}>light</button>
      <button onClick={() => setMode("dark")}>dark</button>
      <button onClick={() => setMode("system")}>system</button>
      <button onClick={() => setTheme("graphite")}>graphite</button>
      <button onClick={() => setTheme("desert-gold")}>desert</button>
      <button onClick={() => void login("bob", "pw")}>sign in bob</button>
      <button onClick={() => void logout()}>sign out</button>
    </>
  );
}

const state = () => screen.getByTestId("state").textContent;
const click = (name: string) => userEvent.click(screen.getByRole("button", { name }));
const ready = () => waitFor(() => expect(screen.getByTestId("who")).not.toHaveTextContent("loading"));
const alertText = () => screen.queryByRole("alert")?.textContent ?? null;

async function mount() {
  renderWithProviders(<Probe />);
  await ready();
  await act(async () => {}); // the effects of the render that showed the user
}

/** A matchMedia whose answer the test can flip; `fire` calls the "change" handlers that are registered right now. */
function stubMatchMedia(matches: boolean) {
  const handlers = new Set<(event: { matches: boolean }) => void>();
  const query = {
    matches,
    addEventListener: vi.fn((_type: string, handler: (event: { matches: boolean }) => void) => handlers.add(handler)),
    removeEventListener: vi.fn((_type: string, handler: (event: { matches: boolean }) => void) => handlers.delete(handler)),
  };
  Object.defineProperty(window, "matchMedia", { value: () => query, configurable: true, writable: true });
  const fire = (next: boolean) => act(() => {
    query.matches = next;
    handlers.forEach((handler) => handler({ matches: next }));
  });
  return { query, handlers, fire };
}

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("useAppearance without a provider", () => {
  it("answers light and navy-gold, and its setters do nothing", async () => {
    render(<Probe2 />);
    expect(screen.getByTestId("alone")).toHaveTextContent("light/navy-gold/false");
    await userEvent.click(screen.getByRole("button", { name: "dark" }));
    expect(screen.getByTestId("alone")).toHaveTextContent("light/navy-gold/false");
    expect(mirror()).toBeNull();
  });
});

function Probe2() {
  const { mode, theme, dark, setMode } = useAppearance();
  return (
    <>
      <p data-testid="alone">{`${mode}/${theme}/${dark}`}</p>
      <button onClick={() => setMode("dark")}>dark</button>
    </>
  );
}

describe("what the provider shows and remembers", () => {
  it("starts from the mirror, writes nothing on mount, and a sign-in page with no session keeps that look", async () => {
    const stored = JSON.stringify({ mode: "dark", theme: "graphite" });
    localStorage.setItem(MIRROR_KEY, stored);
    html.setAttribute("data-mode", "dark"); // what public/theme-init.js painted
    html.setAttribute("data-theme", "graphite");
    startServer(null);
    renderWithProviders(<Probe />);
    expect(state()).toBe("dark/graphite/dark"); // before any answer
    expect(look()).toBe("dark/graphite");
    expect(mirror()).toBe(stored);
    await ready();
    expect(screen.getByTestId("who")).toHaveTextContent("nobody"); // the first /api/me answered 401
    expect(state()).toBe("dark/graphite/dark");
    expect(look()).toBe("dark/graphite");
    expect(mirror()).toBe(stored);
  });

  it("adopts the signed-in account's preferences and replaces the mirror", async () => {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(LIGHT_NAVY));
    startServer(user("ann", { mode: "dark", theme: "maroon-gold" }));
    await mount();
    expect(state()).toBe("dark/maroon-gold/dark");
    expect(look()).toBe("dark/maroon-gold");
    expect(JSON.parse(mirror() ?? "null")).toEqual({ mode: "dark", theme: "maroon-gold" });
  });

  it("reads an account without preferences as the defaults", async () => {
    const bare = { id: 1, username: "ann", role: "admin" };
    startServer(bare as never);
    await mount();
    expect(state()).toBe("light/navy-gold/light");
    expect(look()).toBe("light/navy-gold");
  });

  it("keeps the mirror and the look on sign-out, and the next account signing in gets its own", async () => {
    const server = startServer(user("ann", { mode: "dark", theme: "graphite" }));
    server.loginAs = user("bob", { mode: "light", theme: "desert-gold" });
    await mount();
    await click("sign out");
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("nobody"));
    expect(look()).toBe("dark/graphite");
    expect(JSON.parse(mirror() ?? "null")).toEqual({ mode: "dark", theme: "graphite" });
    await click("sign in bob");
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("bob"));
    expect(look()).toBe("light/desert-gold");
    expect(JSON.parse(mirror() ?? "null")).toEqual({ mode: "light", theme: "desert-gold" });
  });

  it("the role re-check on focus does not overwrite a choice the user just made", async () => {
    const server = startServer(user("ann", LIGHT_NAVY));
    await mount();
    await click("dark");
    server.puts[0].reply({ body: { mode: "dark", theme: "navy-gold" } });
    await waitFor(() => expect(look()).toBe("dark/navy-gold"));
    const before = server.meCalls;
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(server.meCalls).toBe(before + 1)); // /api/me still says light
    await act(async () => {});
    expect(state()).toBe("dark/navy-gold/dark");
    expect(look()).toBe("dark/navy-gold");
    expect(JSON.parse(mirror() ?? "null")).toEqual({ mode: "dark", theme: "navy-gold" });
  });
});

describe("saving", () => {
  it("applies and mirrors a choice at once, then sends only the key that changed", async () => {
    const server = startServer(user("ann", LIGHT_NAVY));
    await mount();
    await click("graphite");
    expect(state()).toBe("light/graphite/light");
    expect(look()).toBe("light/graphite");
    expect(JSON.parse(mirror() ?? "null")).toEqual({ mode: "light", theme: "graphite" });
    expect(server.puts.map((p) => p.body)).toEqual([{ theme: "graphite" }]);
    server.puts[0].reply({ body: { mode: "light", theme: "graphite" } });
    await act(async () => {});
    expect(server.puts).toHaveLength(1);
    expect(alertText()).toBeNull();
  });

  it("three quick choices end at the last one with one PUT in flight at a time (Light, Dark, Match my device, Light)", async () => {
    const server = startServer(user("ann", LIGHT_NAVY));
    await mount();
    await click("dark");
    await click("system");
    await click("light");
    expect(state()).toBe("light/navy-gold/light"); // the last choice shows at once
    expect(server.puts.map((p) => p.body)).toEqual([{ mode: "dark" }]); // the others wait for the one in flight
    server.puts[0].reply({ body: { mode: "dark", theme: "navy-gold" } });
    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(server.puts[1].body).toEqual({ mode: "light" });
    expect(state()).toBe("light/navy-gold/light"); // the answer to the first PUT does not undo the newer choice
    expect(look()).toBe("light/navy-gold");
    server.puts[1].reply({ body: { mode: "light", theme: "navy-gold" } });
    await act(async () => {});
    expect(server.puts).toHaveLength(2);
    expect(state()).toBe("light/navy-gold/light");
    expect(JSON.parse(mirror() ?? "null")).toEqual(LIGHT_NAVY);
  });

  it("a failure with nothing newer waiting puts the confirmed look back and says so; the next success clears the line", async () => {
    const server = startServer(user("ann", LIGHT_NAVY));
    await mount();
    await click("dark");
    expect(look()).toBe("dark/navy-gold");
    server.puts[0].reply({ status: 500, body: { detail: "boom" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Not saved. Check the connection and try again.");
    expect(state()).toBe("light/navy-gold/light");
    expect(look()).toBe("light/navy-gold");
    expect(JSON.parse(mirror() ?? "null")).toEqual(LIGHT_NAVY);
    expect(server.puts).toHaveLength(1);
    await click("dark");
    server.puts[1].reply({ body: { mode: "dark", theme: "navy-gold" } });
    await waitFor(() => expect(alertText()).toBeNull());
    expect(look()).toBe("dark/navy-gold");
  });

  it("a PUT that fails while a newer choice waits does not flash the old look; the newer choice is then sent and may fail on its own", async () => {
    const server = startServer(user("ann", LIGHT_NAVY));
    await mount();
    await click("dark");
    await click("graphite"); // waits behind the first PUT
    expect(look()).toBe("dark/graphite");
    server.puts[0].reply({ status: 500, body: { detail: "boom" } });
    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(look()).toBe("dark/graphite"); // not light/navy-gold, not even for a moment
    expect(JSON.parse(mirror() ?? "null")).toEqual({ mode: "dark", theme: "graphite" });
    expect(server.puts[1].body).toEqual({ mode: "dark", theme: "graphite" }); // everything that still differs from what the server confirmed
    await act(async () => {});
    expect(alertText()).toBeNull(); // no false alarm about a choice that was already replaced
    server.puts[1].reply({ status: 500, body: { detail: "boom" } });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(look()).toBe("light/navy-gold");
    expect(server.puts).toHaveLength(2);
  });

  it("a new choice clears the line of an earlier failure at once", async () => {
    const server = startServer(user("ann", LIGHT_NAVY));
    await mount();
    await click("dark");
    server.puts[0].reply({ status: 500, body: { detail: "boom" } });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await click("graphite"); // its own PUT is still out
    expect(server.puts).toHaveLength(2);
    expect(alertText()).toBeNull();
  });

  it("adopts the server's merged answer when it is the last word", async () => {
    const server = startServer(user("ann", LIGHT_NAVY));
    await mount();
    await click("dark");
    server.puts[0].reply({ body: { mode: "dark", theme: "maroon-gold" } }); // another browser had changed the theme
    await waitFor(() => expect(state()).toBe("dark/maroon-gold/dark"));
    expect(look()).toBe("dark/maroon-gold");
    expect(JSON.parse(mirror() ?? "null")).toEqual({ mode: "dark", theme: "maroon-gold" });
  });

  it("ignores a stale answer after another account signed in, and the new account's queue is free at once", async () => {
    const server = startServer(user("ann", LIGHT_NAVY));
    server.loginAs = user("bob", { mode: "light", theme: "desert-gold" });
    await mount();
    await click("dark"); // ann's PUT stays out
    await click("sign in bob");
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("bob"));
    expect(look()).toBe("light/desert-gold");
    await click("graphite"); // not blocked by ann's PUT
    expect(server.puts).toHaveLength(2);
    expect(server.puts[1].body).toEqual({ theme: "graphite" });
    server.puts[0].reply({ body: { mode: "dark", theme: "navy-gold" } }); // ann's answer arrives late
    await act(async () => {});
    expect(state()).toBe("light/graphite/light");
    expect(look()).toBe("light/graphite");
    server.puts[1].reply({ status: 500, body: { detail: "boom" } }); // a failure of bob's own save puts back bob's look
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(look()).toBe("light/desert-gold"); // bob's confirmed look, not ann's
    expect(JSON.parse(mirror() ?? "null")).toEqual({ mode: "light", theme: "desert-gold" });
  });

  it("does not pop up an error for a failure of the previous account", async () => {
    const server = startServer(user("ann", LIGHT_NAVY));
    server.loginAs = user("bob", LIGHT_NAVY);
    await mount();
    await click("dark");
    await click("sign in bob");
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("bob"));
    server.puts[0].reply({ status: 500, body: { detail: "boom" } });
    await act(async () => {});
    expect(alertText()).toBeNull();
    expect(look()).toBe("light/navy-gold");
  });
});

describe("Match my device", () => {
  it("follows a live change of the device while the mode is system, and stops once Light or Dark is chosen", async () => {
    const media = stubMatchMedia(false);
    const server = startServer(user("ann", { mode: "system", theme: "navy-gold" }));
    await mount();
    expect(state()).toBe("system/navy-gold/light");
    expect(look()).toBe("light/navy-gold");
    expect(media.handlers.size).toBe(1);
    await media.fire(true);
    expect(state()).toBe("system/navy-gold/dark");
    expect(look()).toBe("dark/navy-gold");
    await media.fire(false);
    expect(look()).toBe("light/navy-gold");
    await click("dark");
    expect(media.handlers.size).toBe(0);
    server.puts[0].reply({ body: { mode: "dark", theme: "navy-gold" } });
    await act(async () => {});
    await media.fire(false);
    expect(look()).toBe("dark/navy-gold");
    await click("system");
    expect(media.handlers.size).toBe(1);
    expect(look()).toBe("light/navy-gold"); // resolved against the device again
  });

  it("also follows the device on a sign-in page (no session), because the mirror says system", async () => {
    localStorage.setItem(MIRROR_KEY, JSON.stringify({ mode: "system", theme: "graphite" }));
    const media = stubMatchMedia(false);
    startServer(null);
    await mount();
    expect(screen.getByTestId("who")).toHaveTextContent("nobody");
    await media.fire(true);
    expect(look()).toBe("dark/graphite");
    expect(state()).toBe("system/graphite/dark");
    expect(JSON.parse(mirror() ?? "null")).toEqual({ mode: "system", theme: "graphite" }); // the mirror keeps the choice, not the resolved mode
  });

  it("registers its device listener once under StrictMode (mount, unmount, mount) and removes what it added", async () => {
    localStorage.setItem(MIRROR_KEY, JSON.stringify({ mode: "system", theme: "navy-gold" }));
    const media = stubMatchMedia(false);
    startServer(null);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <AuthProvider>
              <AppearanceProvider><Probe /></AppearanceProvider>
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    );
    await ready();
    expect(media.query.addEventListener.mock.calls.length - media.query.removeEventListener.mock.calls.length).toBe(1);
    expect(media.handlers.size).toBe(1);
    view.unmount();
    expect(media.handlers.size).toBe(0);
  });
});
