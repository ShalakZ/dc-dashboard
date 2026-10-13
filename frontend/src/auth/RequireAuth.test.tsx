import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, type ComponentProps } from "react";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { userFor } from "../test/users";
import { RETURN_KEY, useAuth } from "./AuthProvider";
import { RequireAuth } from "./RequireAuth";

// What the page looks like in the commit that holds a <Navigate>: its effect only starts the route change afterwards, so a layout effect that runs in
// the same commit sees the last frame the visitor gets before the route changes. An empty page there is a white flash between two screens.
// `pending` counts the mounted <Pending /> (it makes the loading bar run), which a redirect must not keep.
const redirects = vi.hoisted(() => [] as { to: string; shell: boolean; pending: number }[]);
const pendingMounted = vi.hoisted(() => ({ count: 0 }));
vi.mock("../components/Pending", () => ({
  Pending: () => {
    useLayoutEffect(() => {
      pendingMounted.count += 1;
      return () => { pendingMounted.count -= 1; };
    }, []);
    return null;
  },
}));
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  function Navigate(props: ComponentProps<typeof actual.Navigate>) {
    useLayoutEffect(() => { redirects.push({ to: String(props.to), shell: document.querySelector(".sk-shell") !== null, pending: pendingMounted.count }); }, [props.to]);
    return <actual.Navigate {...props} />;
  }
  return { ...actual, Navigate };
});

/** Keeps the answers to the given paths waiting; `release(path)` lets one through. Call it after `mockFetch`. */
function hold(...paths: string[]) {
  const inner = globalThis.fetch;
  const waiting = new Map<string, () => void>();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (!paths.includes(path)) return inner(input, init);
    return new Promise<Response>((resolve) => waiting.set(path, () => resolve(inner(input, init))));
  });
  return (path: string) => act(async () => { waiting.get(path)?.(); });
}

const signedIn: Routes = {
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor("admin") },
};

function SignOut() {
  const { logout } = useAuth();
  return <button type="button" onClick={() => void logout()}>sign out now</button>;
}

describe("RequireAuth", () => {
  beforeEach(() => {
    sessionStorage.clear();
    redirects.length = 0;
  });

  it("shows the shell skeleton, not the bare line, while the sign-in check is out, then the page", async () => {
    mockFetch(signedIn);
    const release = hold("/api/setup", "/api/me");
    const { container } = renderWithProviders(<RequireAuth><p>the page</p></RequireAuth>, { route: "/assets" });

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector(".shell.sk-shell")).toBeInTheDocument();
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    expect(screen.queryByText("the page")).not.toBeInTheDocument();

    await release("/api/setup");
    expect(container.querySelector(".sk-shell")).toBeInTheDocument(); // still waiting for /api/me
    await release("/api/me");
    expect(await screen.findByText("the page")).toBeInTheDocument();
    expect(container.querySelector(".sk-shell")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("owns the one loading bar: it is there once while loading and is the same element when the page shows", async () => {
    mockFetch(signedIn);
    const release = hold("/api/setup", "/api/me");
    const { container } = renderWithProviders(<RequireAuth><p>the page</p></RequireAuth>, { route: "/assets" });

    expect(container.querySelectorAll(".top-progress")).toHaveLength(1);
    const bar = container.querySelector(".top-progress");
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(bar?.nextElementSibling).toHaveClass("sk-shell"); // next to the shell, as Layout's was

    await release("/api/setup");
    await release("/api/me");
    await screen.findByText("the page");
    expect(container.querySelectorAll(".top-progress")).toHaveLength(1);
    expect(container.querySelector(".top-progress")).toBe(bar);
  });

  it("sends a first visit to /setup, with no loading bar left behind", async () => {
    mockFetch({ "GET /api/setup": { body: { needed: true } }, "GET /api/me": { status: 401, body: { detail: "x" } } });
    const { container } = renderWithProviders(<RequireAuth><p>the page</p></RequireAuth>, { route: "/assets" });
    expect(await screen.findByText("setup page")).toBeInTheDocument();
    expect(container.querySelector(".top-progress")).not.toBeInTheDocument();
    expect(container.querySelector(".sk-shell")).not.toBeInTheDocument();
  });

  it("keeps the shell skeleton (and no Pending) in the frame that carries the redirect to /setup, so the last frame is not an empty page", async () => {
    mockFetch({ "GET /api/setup": { body: { needed: true } }, "GET /api/me": { status: 401, body: { detail: "x" } } });
    renderWithProviders(<RequireAuth><p>the page</p></RequireAuth>, { route: "/assets" });
    expect(await screen.findByText("setup page")).toBeInTheDocument();
    expect(redirects).toEqual([{ to: "/setup", shell: true, pending: 0 }]);
  });

  it("keeps the shell skeleton (and no Pending) in the frame that carries the redirect to /login, for a lost session and for an explicit sign-out", async () => {
    mockFetch({ "GET /api/setup": { body: { needed: false } }, "GET /api/me": { status: 401, body: { detail: "not authenticated" } } });
    const lost = renderWithProviders(<RequireAuth><p>the page</p></RequireAuth>, { route: "/assets" });
    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(redirects).toEqual([{ to: "/login", shell: true, pending: 0 }]);
    expect(sessionStorage.getItem(RETURN_KEY)).toBe("/assets"); // the page asked for is still remembered
    lost.unmount();

    redirects.length = 0;
    sessionStorage.clear();
    mockFetch({ ...signedIn, "POST /api/logout": { status: 204 } });
    renderWithProviders(<RequireAuth><SignOut /></RequireAuth>, { route: "/assets" });
    await userEvent.click(await screen.findByRole("button", { name: "sign out now" }));
    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(redirects).toEqual([{ to: "/login", shell: true, pending: 0 }]);
    await waitFor(() => expect(sessionStorage.getItem(RETURN_KEY)).toBeNull()); // and nothing is remembered
  });

  it("sends a 401 from /api/me to /login and remembers the page asked for", async () => {
    mockFetch({ "GET /api/setup": { body: { needed: false } }, "GET /api/me": { status: 401, body: { detail: "not authenticated" } } });
    const { container } = renderWithProviders(<RequireAuth><p>the page</p></RequireAuth>, { route: "/assets/4?tab=chart" });
    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(sessionStorage.getItem(RETURN_KEY)).toBe("/assets/4?tab=chart");
    expect(container.querySelector(".top-progress")).not.toBeInTheDocument();
    expect(container.querySelector(".sk-shell")).not.toBeInTheDocument();
  });

  it("forgets the page after an explicit sign-out", async () => {
    mockFetch({ ...signedIn, "POST /api/logout": { status: 204 } });
    renderWithProviders(<RequireAuth><SignOut /></RequireAuth>, { route: "/assets" });
    await userEvent.click(await screen.findByRole("button", { name: "sign out now" }));
    expect(await screen.findByText("login page")).toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem(RETURN_KEY)).toBeNull());
  });

  describe("when the server cannot be reached", () => {
    // The first request of the bootstrap fails the way a stopped api does behind Caddy; `answer` is what it says from then on.
    const answer = { setup: "network" as "network" | 502 | "ok", me: "ok" as "ok" | 401 };
    const routes = (): Routes => ({
      "GET /api/setup": () => {
        if (answer.setup === "network") throw new TypeError("Failed to fetch");
        if (answer.setup === 502) return { status: 502, body: { detail: "502 Bad Gateway" } };
        return { body: { needed: false } };
      },
      "GET /api/me": () => (answer.me === 401 ? { status: 401, body: { detail: "not authenticated" } } : { body: userFor("admin") }),
    });
    beforeEach(() => {
      Object.assign(answer, { setup: "network", me: "ok" });
    });

    it.each(["network", 502] as const)("shows the panel (%s), not a redirect: the URL stays, nothing is remembered, the page is not rendered", async (kind) => {
      answer.setup = kind;
      mockFetch(routes());
      const { container } = renderWithProviders(<RequireAuth><p>the page</p></RequireAuth>, { route: "/assets/4?tab=chart" });

      expect(await screen.findByRole("heading", { level: 1, name: "Can't reach the server" })).toBeInTheDocument();
      expect(screen.getByText("The server is not answering. It may be starting or restarting. This page tries again every few seconds.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry now" })).toBeInTheDocument();
      expect(screen.queryByText("the page")).not.toBeInTheDocument();
      expect(screen.queryByText("login page")).not.toBeInTheDocument();
      expect(screen.queryByText("setup page")).not.toBeInTheDocument();
      expect(redirects).toEqual([]); // no <Navigate> was ever rendered
      expect(sessionStorage.getItem(RETURN_KEY)).toBeNull();
      expect(container.querySelector(".sk-shell")).not.toBeInTheDocument();
      expect(container.querySelector("main.auth .auth-card")).toBeInTheDocument(); // the sign-in card's classes
      expect(pendingMounted.count).toBe(0); // the loading bar is not left running
    });

    it("Retry now asks again, and the page appears when the server is back, with nothing remembered on the way", async () => {
      mockFetch(routes());
      renderWithProviders(<RequireAuth><p>the page</p></RequireAuth>, { route: "/assets" });
      await userEvent.click(await screen.findByRole("button", { name: "Retry now" }));
      expect(screen.getByRole("heading", { name: "Can't reach the server" })).toBeInTheDocument(); // still down: still the panel

      answer.setup = "ok";
      await userEvent.click(await screen.findByRole("button", { name: "Retry now" }));
      expect(await screen.findByText("the page")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Can't reach the server" })).not.toBeInTheDocument();
      expect(redirects).toEqual([]);
      expect(sessionStorage.getItem(RETURN_KEY)).toBeNull();
    });

    it("when the server is back and the session is gone, the visitor goes to the sign-in page and the page asked for is remembered then", async () => {
      mockFetch(routes());
      renderWithProviders(<RequireAuth><p>the page</p></RequireAuth>, { route: "/assets/4" });
      await userEvent.click(await screen.findByRole("button", { name: "Retry now" }));
      expect(sessionStorage.getItem(RETURN_KEY)).toBeNull();

      Object.assign(answer, { setup: "ok", me: 401 });
      await userEvent.click(await screen.findByRole("button", { name: "Retry now" }));
      expect(await screen.findByText("login page")).toBeInTheDocument();
      expect(sessionStorage.getItem(RETURN_KEY)).toBe("/assets/4");
      expect(redirects).toEqual([{ to: "/login", shell: true, pending: 0 }]);
    });
  });
});
