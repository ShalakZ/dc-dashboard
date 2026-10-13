import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { api } from "../api/client";
import { Layout } from "../components/Layout";
import { LoginPage } from "../pages/LoginPage";
import { mockFetch, shellRoutes } from "../test/fetchMock";
import { userFor } from "../test/users";
import "../test/routerRequestShim";
import { RETURN_KEY, AuthProvider } from "./AuthProvider";
import { RequireAuth } from "./RequireAuth";

// The real RequireAuth, Layout (top bar, profile menu, SignOutDialog) and LoginPage together: the order of events on sign-out
// (the session ends, RequireAuth renders with no user, then the dialog navigates) is what these pin down, so nothing is stubbed.

function Billing() {
  return (
    <div>
      <p>billing page</p>
      <button type="button" onClick={() => void api.get("/api/expiring").catch(() => undefined)}>Load more</button>
    </div>
  );
}

function renderApp(route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<><LoginPage /><Link to="/billing">visit billing</Link></>} />
            <Route element={<RequireAuth><Layout /></RequireAuth>}>
              <Route path="/" element={<p>home page</p>} />
              <Route path="/billing" element={<Billing />} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The server side of one session: signed in until the logout or an expiry, and signed in again by the next login. */
function server(options: { expireOnRequest?: boolean; logoutFails?: boolean } = {}) {
  let signedIn = true;
  const user = userFor("admin");
  return mockFetch({
    ...shellRoutes,
    "GET /api/setup": { body: { needed: false } },
    "GET /api/me": () => (signedIn ? { body: user } : { status: 401, body: { detail: "not authenticated" } }),
    "GET /api/expiring": () => {
      if (options.expireOnRequest) signedIn = false;
      return { status: 401, body: { detail: "not authenticated" } };
    },
    "POST /api/logout": () => {
      if (options.logoutFails) return { status: 500, body: { detail: "logout failed" } };
      signedIn = false;
      return { status: 204 };
    },
    "POST /api/login": () => {
      signedIn = true;
      return { body: user };
    },
  });
}

/** Keeps the logout request waiting (the server has not answered it yet) until the returned function is called. Call it after `server()`. */
function holdLogout() {
  const inner = globalThis.fetch;
  let release = () => {};
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith("/api/logout")) return inner(input, init);
    return new Promise<Response>((resolve) => { release = () => resolve(inner(input, init)); });
  });
  return () => release();
}

async function openSignOutDialog() {
  await userEvent.click(await screen.findByRole("button", { name: /^u Administrator$/ }));
  await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
  return screen.findByRole("dialog", { name: "Sign out of DC Dashboard?" });
}

async function signInAgain() {
  await userEvent.type(await screen.findByLabelText("Username"), "u");
  await userEvent.type(screen.getByLabelText("Password"), "secret-123");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("the page remembered across a sign-in", () => {
  beforeEach(() => sessionStorage.clear());

  it("is forgotten by an explicit sign-out, so signing in again lands on / (where the default dashboard is picked)", async () => {
    server();
    renderApp("/billing");
    expect(await screen.findByText("billing page")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /^u Administrator$/ }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign out of DC Dashboard?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));

    await signInAgain();
    expect(await screen.findByText("home page")).toBeInTheDocument();
    expect(screen.queryByText("billing page")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(RETURN_KEY)).toBeNull();
  });

  it("leaves nothing under the return key at the sign-in page after an explicit sign-out", async () => {
    server();
    renderApp("/billing");
    await userEvent.click(await screen.findByRole("button", { name: /^u Administrator$/ }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign out of DC Dashboard?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    await screen.findByLabelText("Username");
    expect(sessionStorage.getItem(RETURN_KEY)).toBeNull();
  });

  it("is kept when the session expires mid-session, so signing in again goes back to it", async () => {
    server({ expireOnRequest: true });
    renderApp("/billing");
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await screen.findByLabelText("Username");
    expect(sessionStorage.getItem(RETURN_KEY)).toBe("/billing");

    await signInAgain();
    expect(await screen.findByText("billing page")).toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem(RETURN_KEY)).toBeNull());
  });

  it("is kept for a signed-out visit that follows a sign-in and then an expiry (the sign-out mark does not outlive the next sign-in)", async () => {
    server({ expireOnRequest: true });
    renderApp("/login");
    await signInAgain(); // no remembered page: /
    expect(await screen.findByText("home page")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^u Administrator$/ }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign out of DC Dashboard?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    await signInAgain();
    expect(await screen.findByText("home page")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Billing" }));
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await screen.findByLabelText("Username");
    expect(sessionStorage.getItem(RETURN_KEY)).toBe("/billing");
  });

  it("is not remembered by a 401 that lands while the sign-out request is still out", async () => {
    server();
    const answerLogout = holdLogout();
    renderApp("/billing");
    await screen.findByText("billing page");
    const dialog = await openSignOutDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    await act(async () => {
      await api.get("/api/expiring").catch(() => undefined); // a poll that was already on its way gets the session's 401 first
    });
    await screen.findByLabelText("Username");
    expect(sessionStorage.getItem(RETURN_KEY)).toBeNull();

    await act(async () => answerLogout());
    await signInAgain();
    expect(await screen.findByText("home page")).toBeInTheDocument();
  });

  it("leaves a user whose sign-out failed signed in, and a later expiry remembers the page again", async () => {
    server({ logoutFails: true, expireOnRequest: true });
    renderApp("/billing");
    await screen.findByText("billing page");
    const dialog = await openSignOutDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("logout failed");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("billing page")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByLabelText("Username");
    expect(sessionStorage.getItem(RETURN_KEY)).toBe("/billing");
  });

  it("remembers a page visited while signed out after an explicit sign-out (the mark ends when the sign-in page shows)", async () => {
    server();
    renderApp("/");
    await userEvent.click(await screen.findByRole("button", { name: /^u Administrator$/ }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign out of DC Dashboard?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    await screen.findByLabelText("Username");
    await userEvent.click(screen.getByRole("link", { name: "visit billing" }));
    await screen.findByLabelText("Username");
    expect(sessionStorage.getItem(RETURN_KEY)).toBe("/billing");

    await signInAgain();
    expect(await screen.findByText("billing page")).toBeInTheDocument();
  });
});
