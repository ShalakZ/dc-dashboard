import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithDataRouter } from "../test/render";
import { SetupPage } from "./SetupPage";

/** What the fake server answers to the first sign-in check; changed between events. */
const server = { setup: "network" as "network" | "needed" | "not-needed", me: "session" as "session" | 401 };

const routes = () => ({
  "GET /api/setup": () => {
    if (server.setup === "network") throw new TypeError("Failed to fetch");
    return { body: { needed: server.setup === "needed" } };
  },
  "GET /api/me": () => (server.me === 401 ? { status: 401, body: { detail: "not authenticated" } } : { body: { id: 1, username: "u", role: "admin" } }),
});

const mount = () => renderWithDataRouter(<SetupPage />, { route: "/setup", path: "/setup" });

describe("SetupPage", () => {
  beforeEach(() => {
    Object.assign(server, { setup: "network", me: "session" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays on /setup while the server cannot be reached, and says so, instead of sending the visitor to a sign-in form", async () => {
    mockFetch(routes());
    const { router } = mount();
    expect(await screen.findByRole("heading", { level: 1, name: "Can't reach the server" })).toBeInTheDocument();
    expect(screen.queryByText("login page")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "First-run setup" })).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/setup");
  });

  it("shows the setup form once the server answers that a first user is needed", async () => {
    mockFetch(routes());
    const { router } = mount();
    await screen.findByRole("heading", { name: "Can't reach the server" });
    server.setup = "needed";
    await userEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(await screen.findByRole("heading", { level: 1, name: "First-run setup" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Can't reach the server" })).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/setup");
  });

  it("leaves for the sign-in page when the server comes back and no first user is needed", async () => {
    mockFetch(routes());
    const { router } = mount();
    await screen.findByRole("heading", { name: "Can't reach the server" });
    server.setup = "not-needed";
    server.me = 401;
    await userEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("leaves for the app when the server comes back and somebody is already signed in", async () => {
    mockFetch(routes());
    const { router } = mount();
    await screen.findByRole("heading", { name: "Can't reach the server" });
    server.setup = "not-needed";
    await userEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(await screen.findByText("assets page")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/assets");
  });

  it("as before: with no first user needed it leaves at once, and with one needed it shows the form", async () => {
    server.setup = "not-needed";
    server.me = 401;
    mockFetch(routes());
    const first = mount();
    await waitFor(() => expect(first.router.state.location.pathname).toBe("/login"));
    first.unmount();

    server.setup = "needed";
    mockFetch(routes());
    mount();
    expect(await screen.findByRole("heading", { name: "First-run setup" })).toBeInTheDocument();
  });
});
