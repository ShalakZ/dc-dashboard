import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { RETURN_KEY, useAuth } from "./AuthProvider";
import { RequireAuth } from "./RequireAuth";

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
  "GET /api/me": { body: { id: 1, username: "u", role: "admin" } },
};

function SignOut() {
  const { logout } = useAuth();
  return <button type="button" onClick={() => void logout()}>sign out now</button>;
}

describe("RequireAuth", () => {
  beforeEach(() => sessionStorage.clear());

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
});
