import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RequireRole } from "../auth/RequireAuth";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { Layout } from "./Layout";

const routes = (role: string) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role } },
});

describe("Layout nav", () => {
  it("shows admin links only to admins, Password link to everyone", async () => {
    mockFetch(routes("admin"));
    const { unmount } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("link", { name: "Users" })).toHaveAttribute("href", "/users");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("link", { name: "Password" })).toHaveAttribute("href", "/password");
    unmount();
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("link", { name: "Password" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sources" })).not.toBeInTheDocument();
  });
});

describe("Layout scans link", () => {
  it("shows Scans to operators and admins but not viewers", async () => {
    mockFetch(routes("operator"));
    const operator = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("link", { name: "Scans" })).toHaveAttribute("href", "/scans");
    operator.unmount();
    mockFetch(routes("admin"));
    const admin = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("link", { name: "Scans" })).toHaveAttribute("href", "/scans");
    admin.unmount();
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("link", { name: "Password" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Scans" })).not.toBeInTheDocument();
  });
});

describe("Layout discovery link", () => {
  it("shows Discovery to operators and admins but not viewers", async () => {
    mockFetch(routes("operator"));
    const operator = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("link", { name: "Discovery" })).toHaveAttribute("href", "/discovery");
    operator.unmount();
    mockFetch(routes("admin"));
    const admin = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("link", { name: "Discovery" })).toHaveAttribute("href", "/discovery");
    admin.unmount();
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("link", { name: "Password" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Discovery" })).not.toBeInTheDocument();
  });
});

describe("Layout audit link", () => {
  it("shows Audit to admins only", async () => {
    mockFetch(routes("admin"));
    const admin = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("link", { name: "Audit" })).toHaveAttribute("href", "/audit");
    admin.unmount();
    mockFetch(routes("operator"));
    const operator = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("link", { name: "Discovery" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Audit" })).not.toBeInTheDocument();
    operator.unmount();
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("link", { name: "Password" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Audit" })).not.toBeInTheDocument();
  });
});

describe("RequireRole", () => {
  it("shows a viewer visiting /users an Admins only page instead of the API error", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(
      <RequireRole min="admin"><p>users page</p></RequireRole>,
      { route: "/users", path: "/users" },
    );
    expect(await screen.findByText("Admins only")).toBeInTheDocument();
    expect(screen.queryByText("users page")).not.toBeInTheDocument();
  });

  it("tells a viewer an operator-level page is for operators, and lets an operator in", async () => {
    mockFetch(routes("viewer"));
    const viewer = renderWithProviders(
      <RequireRole min="operator"><p>scans page</p></RequireRole>,
      { route: "/scans", path: "/scans" },
    );
    expect(await screen.findByText("Operators only")).toBeInTheDocument();
    expect(screen.queryByText("scans page")).not.toBeInTheDocument();
    viewer.unmount();
    mockFetch(routes("operator"));
    renderWithProviders(
      <RequireRole min="operator"><p>scans page</p></RequireRole>,
      { route: "/scans", path: "/scans" },
    );
    expect(await screen.findByText("scans page")).toBeInTheDocument();
  });

  it("renders the page for an admin", async () => {
    mockFetch(routes("admin"));
    renderWithProviders(
      <RequireRole min="admin"><p>users page</p></RequireRole>,
      { route: "/users", path: "/users" },
    );
    expect(await screen.findByText("users page")).toBeInTheDocument();
  });
});

describe("Layout phase 3 links", () => {
  it.each(["viewer", "operator", "admin"] as const)("%s sees Dashboards and Billing, and Tariffs only as admin", async (role) => {
    mockFetch(routes(role));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await screen.findByText(`u (${role})`); // the user has loaded, so role-gated links are decided
    expect(screen.getByRole("link", { name: "Dashboards" })).toHaveAttribute("href", "/dashboards");
    expect(screen.getByRole("link", { name: "Billing" })).toHaveAttribute("href", "/billing");
    if (role === "admin") expect(screen.getByRole("link", { name: "Tariffs" })).toHaveAttribute("href", "/tariffs");
    else expect(screen.queryByRole("link", { name: "Tariffs" })).not.toBeInTheDocument();
  });
});

describe("Layout skip link and page width", () => {
  it("starts with a skip link that moves focus to the main area", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    const first = (await screen.findAllByRole("link"))[0];
    expect(first).toHaveAccessibleName("Skip to content");
    await userEvent.click(first);
    expect(screen.getByRole("main")).toHaveFocus();
  });

  it.each([
    ["/billing", true],
    ["/dashboards/3", true],
    ["/dashboards", false],
    ["/assets", false],
    ["/sources/4/points", false],
  ])("gives %s the whole window: %s", async (route, wide) => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route, path: "*" });
    const main = await screen.findByRole("main");
    expect(main.classList.contains("wide")).toBe(wide);
  });
});

describe("Layout certificate notice", () => {
  const expiring = {
    enabled: true, state: "expiring", not_after: "2026-11-09T11:03:11+00:00", days_left: 12, subject: "CN=dcdash.example",
    checked_at: "2026-10-10T12:00:00+00:00", error: null,
  };
  const withTls = (role: string) => ({
    ...routes(role),
    "GET /api/site": { body: { timezone: "UTC", currency: null } },
    "GET /api/tls/status": { body: expiring },
  });

  it("shows an admin the notice in the app shell", async () => {
    mockFetch(withTls("admin"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("status")).toHaveTextContent("The HTTPS certificate expires on 2026-11-09 11:03:11 (12 days left)");
  });

  it.each(["operator", "viewer"])("does not even ask for the status as %s", async (role) => {
    const calls = mockFetch(withTls(role));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await screen.findByText(`u (${role})`);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/me")).toBe(true));
    expect(calls.some((c) => c.path === "/api/tls/status")).toBe(false);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
