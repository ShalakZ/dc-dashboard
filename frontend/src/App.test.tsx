import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { config, dashboard, widget, widgetDataRoute } from "./test/dashboardFixtures";
import { FakeEventSource } from "./test/fakeEventSource";
import { mockFetch, shellRoutes } from "./test/fetchMock";
import { builtinRoles, catalogue } from "./test/permissionFixtures";
import { renderWithProviders } from "./test/render";
import { userFor } from "./test/users";

// Answers for whatever the Phase 3 pages (placeholders now, real pages later) ask on load.
const routes = (role: string) => ({
  ...shellRoutes, // the top bar's chip and clock, and the asset list: asked on every page
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor(role) },
  "GET /api/site": { body: { timezone: "Asia/Qatar", currency: "QAR" } },
  "GET /api/tariffs": { body: [] },
  "GET /api/settings/billing": { body: { currency: "QAR" } },
  "GET /api/assets": { body: [] },
  "GET /api/fleet/summary": { body: { power: { kw: null, counted: 0, of: 0 }, energy_today: null, cost_today: null, currency: "QAR", attention: { total: 0, items: [] } } },
  "GET /api/sources": { body: [] },
  "GET /api/users": { body: [{ id: 1, username: "u", role: "admin", active: true }] },
  "GET /api/roles": { body: builtinRoles() },
  "GET /api/permissions": { body: catalogue() },
  "GET /api/diagnostics/report": { body: { format: "DCDASH-REPORT v1", build_id: "t", detail: "summary", mask: false, checksum: "c", parts: [], legend: [] } },
  "GET /api/sources/4/points": { body: [] },
  "GET /api/billing/costs": { body: { month: "2026-10", timezone: "Asia/Qatar", currency: "QAR", days: [], assets: [], closed: null } },
  "GET /api/dashboards": { body: [] },
  "GET /api/dashboards/3": { body: dashboard({ widgets: [widget(5, "table", { title: "Assets", config: config({ assets: [5, 6] }) })] }) },
  "POST /api/widget-data": widgetDataRoute,
});
const visit = (role: string, route: string) => {
  const calls = mockFetch(routes(role));
  renderWithProviders(<App />, { route, path: "*" });
  return calls;
};

describe("App routes", () => {
  it("keeps Tariffs away from a viewer", async () => {
    const calls = visit("viewer", "/tariffs");
    expect(await screen.findByRole("heading", { name: "No access" })).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/tariffs")).toBe(false);
  });

  it("opens Tariffs read-only for an operator (tariffs.view, assets.view, not tariffs.edit): the rates and the currency are read, nothing can be added", async () => {
    const calls = visit("operator", "/tariffs");
    expect(await screen.findByRole("heading", { level: 1, name: "Tariffs" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No access" })).not.toBeInTheDocument();
    expect(await screen.findByText("Your role can see this page but not change it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add rate" })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/tariffs")).toBe(true);
    expect(calls.some((c) => c.path === "/api/settings/billing")).toBe(true);
  });

  // The trail above the title has a link of the same name, so the sidebar's is looked up inside the Main navigation.
  const sidebarLink = () => within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Users & Roles" });

  it("opens Users & Roles on the Users tab at /users and on the Roles tab at /users/roles, for an admin, under the page's own tab title", async () => {
    visit("admin", "/users");
    expect(await screen.findByRole("heading", { level: 1, name: "Users & Roles" })).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: "Users", selected: true })).toBeInTheDocument();
    expect(document.title).toBe("Users & Roles \u00b7 DC Dashboard");
    expect(sidebarLink()).toHaveAttribute("aria-current", "page"); // the sidebar item
    await userEvent.click(screen.getByRole("tab", { name: "Roles" }));
    expect(await screen.findByRole("table", { name: "Roles" })).toBeInTheDocument();
    expect(sidebarLink()).toHaveAttribute("aria-current", "page"); // /users/roles is the same page
    expect(document.title).toBe("Users & Roles \u00b7 DC Dashboard");
  });

  it("opens the Roles tab straight from /users/roles after a reload", async () => {
    visit("admin", "/users/roles");
    expect(await screen.findByRole("table", { name: "Roles" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Roles", selected: true })).toBeInTheDocument();
  });

  it.each(["/users", "/users/roles"])("keeps %s away from a viewer and an operator, and asks for neither accounts nor roles", async (route) => {
    for (const role of ["viewer", "operator"]) {
      const calls = visit(role, route);
      expect(await screen.findByRole("heading", { name: "No access" })).toBeInTheDocument();
      expect(calls.some((c) => c.path === "/api/users" || c.path === "/api/roles" || c.path === "/api/permissions")).toBe(false);
      cleanup();
    }
  });

  it.each(["viewer", "operator"])("keeps Diagnostics away from a %s, and asks the report route nothing", async (role) => {
    const calls = visit(role, "/diagnostics");
    expect(await screen.findByRole("heading", { name: "No access" })).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/diagnostics/report")).toBe(false);
  });

  it("opens Diagnostics for an admin, without building a report on its own", async () => {
    const calls = visit("admin", "/diagnostics");
    expect(await screen.findByRole("heading", { level: 1, name: "Diagnostics" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Build report" })).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/diagnostics/report")).toBe(false);
  });

  it.each([["viewer", "/events"], ["operator", "/events"], ["viewer", "/events/7"], ["operator", "/events/7"]])("keeps System events away from a %s at %s, and asks the events routes nothing", async (role, route) => {
    const calls = visit(role, route);
    expect(await screen.findByRole("heading", { name: "No access" })).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith("/api/events"))).toBe(false);
  });

  it.each(["/events", "/events/7"])("opens System events at %s for an admin (the list and one event in its drawer are one page), under its tab title, with the sidebar link current", async (route) => {
    visit("admin", route);
    expect(await screen.findByRole("heading", { level: 1, name: "System events" })).toBeInTheDocument();
    expect(document.title).toBe("System events · DC Dashboard");
    expect(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Events" })).toHaveAttribute("aria-current", "page");
  });

  it("opens Tariffs for an admin", async () => {
    visit("admin", "/tariffs");
    expect(await screen.findByRole("heading", { name: "Tariffs" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No access" })).not.toBeInTheDocument();
  });

  it("opens Billing and Dashboards for a viewer", async () => {
    visit("viewer", "/billing");
    expect(await screen.findByRole("heading", { name: "Billing" })).toBeInTheDocument();
  });

  it("opens the lazily loaded Dashboards page for a viewer", async () => {
    visit("viewer", "/dashboards");
    expect(await screen.findByRole("heading", { name: "Dashboards" })).toBeInTheDocument();
  });

  it("opens a dashboard, with its widgets, for a viewer", async () => {
    const calls = visit("viewer", "/dashboards/3");
    expect(await screen.findByRole("heading", { name: "Hall A" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Assets" })).toBeInTheDocument();
    expect(await screen.findByText("LV Panel 2")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("keeps Sources away from a viewer", async () => {
    const calls = visit("viewer", "/sources");
    expect(await screen.findByRole("heading", { name: "No access" })).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/sources")).toBe(false);
  });

  it("opens Sources for an operator", async () => {
    visit("operator", "/sources");
    expect(await screen.findByRole("heading", { name: "Sources" })).toBeInTheDocument();
  });

  it.each(["viewer", "operator"])("keeps the source points page away from a %s", async (role) => {
    const calls = visit(role, "/sources/4/points");
    expect(await screen.findByRole("heading", { name: "No access" })).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/sources/4/points")).toBe(false);
  });

  it("opens the source points page for an admin", async () => {
    visit("admin", "/sources/4/points");
    expect(await screen.findByRole("heading", { name: "Points" })).toBeInTheDocument();
  });

  it.each(["viewer", "operator", "admin"])("answers an unknown address with a page, inside the layout, for a %s", async (role) => {
    visit(role, "/nope");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Assets Tree" })).toBeInTheDocument(); // the nav is still there
  });

  it("offers a way back from an unknown address: the link Back to Assets Tree, to /assets", async () => {
    visit("viewer", "/nope");
    expect(await screen.findByRole("link", { name: "Back to Assets Tree" })).toHaveAttribute("href", "/assets");
  });
});

describe("the home route", () => {
  const home = (role: string, over: Record<string, unknown> = {}) => {
    const calls = mockFetch({ ...routes(role), ...over } as ReturnType<typeof routes>);
    renderWithProviders(<App />, { route: "/", path: "*" });
    return calls;
  };

  it("opens the default dashboard, and never flashes /assets first", async () => {
    const calls = home("viewer", { "GET /api/dashboards/default": { body: { dashboard_id: 3 } } });
    expect(await screen.findByRole("heading", { name: "Hall A" })).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/fleet/summary")).toBe(false); // the Assets page was never rendered
  });

  it("opens Assets when there is no default", async () => {
    home("viewer");
    expect(await screen.findByRole("heading", { name: "Assets Tree", level: 1 })).toBeInTheDocument();
  });

  it("opens Assets when the default cannot be read", async () => {
    home("viewer", { "GET /api/dashboards/default": { status: 500, body: { detail: "boom" } } });
    expect(await screen.findByRole("heading", { name: "Assets Tree", level: 1 })).toBeInTheDocument();
  });

  it("lists the dashboards on /dashboards even when a default is set", async () => {
    mockFetch({ ...routes("viewer"), "GET /api/dashboards/default": { body: { dashboard_id: 3 } } });
    renderWithProviders(<App />, { route: "/dashboards", path: "*" });
    expect(await screen.findByRole("heading", { name: "Dashboards", level: 1 })).toBeInTheDocument();
  });

  it("asks a signed-out visitor for the sign-in page without calling the default endpoint", async () => {
    const calls = mockFetch({ ...routes("viewer"), "GET /api/me": { status: 401, body: { detail: "x" } } });
    renderWithProviders(<App />, { route: "/", path: "*" });
    expect(await screen.findByText("login page")).toBeInTheDocument(); // the harness's stub for /login
    expect(calls.some((c) => c.path === "/api/dashboards/default")).toBe(false);
  });
});

describe("the Assets workspace", () => {
  const site = { id: 1, parent_id: null, name: "Site", kind: "site", sort_order: 0 };
  beforeEach(() => {
    FakeEventSource.reset();
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  const visitAssets = (route: string) => {
    mockFetch({
      ...routes("viewer"),
      "GET /api/assets": { body: [site] },
      "GET /api/asset-kinds": { body: [{ id: 1, name: "Site", icon: "site", asset_count: 1 }, { id: 2, name: "Rack", icon: "rack", asset_count: 0 }] },
      "GET /api/assets/1/summary": { body: { asset: site, metrics: [], energy_today: null, cost_today: null, currency: "QAR" } },
      "GET /api/assets/1/series": { body: { metric: "active_power_kw", unit: "kW", points: [] } },
    });
    renderWithProviders(<App />, { route, path: "*" });
  };

  it("/assets shows the asset tree beside the index page", async () => {
    visitAssets("/assets");
    expect(await screen.findByRole("region", { name: "Asset tree" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Assets Tree", level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "By kind", level: 2 })).toBeInTheDocument(); // the fleet summary
  });

  it("/assets/1 shows the same tree beside the asset's page, with the asset selected", async () => {
    visitAssets("/assets/1");
    const tree = await screen.findByRole("region", { name: "Asset tree" });
    expect(await screen.findByRole("heading", { name: "Site", level: 1 })).toBeInTheDocument();
    expect(within(tree).getByRole("link", { name: "Site" })).toHaveAttribute("aria-current", "true");
  });

  it("/assets/kinds shows the Asset kinds page beside the tree, and no asset is selected there", async () => {
    visitAssets("/assets/kinds");
    const tree = await screen.findByRole("region", { name: "Asset tree" });
    expect(await screen.findByRole("heading", { name: "Asset kinds", level: 1 })).toBeInTheDocument();
    expect(await screen.findByText("Rack", { selector: "td *" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "By kind" })).not.toBeInTheDocument(); // not the fleet summary
    expect(await within(tree).findByRole("link", { name: "Site" })).not.toHaveAttribute("aria-current"); // "kinds" is not an asset id
    expect(within(tree).getByRole("link", { name: "Asset kinds" })).toHaveAttribute("aria-current", "page");
  });

  it("a static /assets/kinds beats /assets/:id, which still opens an asset", async () => {
    visitAssets("/assets/1");
    expect(await screen.findByRole("heading", { name: "Site", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Asset kinds" })).not.toBeInTheDocument();
  });

  it("the link in the tree header opens the Asset kinds page, and a click on a node goes back to an asset", async () => {
    visitAssets("/assets");
    const tree = await screen.findByRole("region", { name: "Asset tree" });
    await userEvent.click(within(tree).getByRole("link", { name: "Asset kinds" }));
    expect(await screen.findByRole("heading", { name: "Asset kinds", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Asset tree" })).toBe(tree);
    await userEvent.click(await within(tree).findByRole("link", { name: "Site" }));
    expect(await screen.findByRole("heading", { name: "Site", level: 1 })).toBeInTheDocument();
  });

  it("clicking a node in the tree opens the asset and leaves the tree mounted", async () => {
    visitAssets("/assets");
    const tree = await screen.findByRole("region", { name: "Asset tree" });
    await userEvent.click(await within(tree).findByRole("link", { name: "Site" })); // the tree is there at once, its rows when the list arrives
    expect(await screen.findByRole("heading", { name: "Site", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Asset tree" })).toBe(tree);
  });
});
