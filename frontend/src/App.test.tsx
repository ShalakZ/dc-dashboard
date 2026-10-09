import { screen } from "@testing-library/react";
import { App } from "./App";
import { config, dashboard, widget, widgetDataRoute } from "./test/dashboardFixtures";
import { mockFetch } from "./test/fetchMock";
import { renderWithProviders } from "./test/render";

// Answers for whatever the Phase 3 pages (placeholders now, real pages later) ask on load.
const routes = (role: string) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role } },
  "GET /api/site": { body: { timezone: "Asia/Qatar", currency: "QAR" } },
  "GET /api/tariffs": { body: [] },
  "GET /api/settings/billing": { body: { currency: "QAR" } },
  "GET /api/assets": { body: [] },
  "GET /api/sources": { body: [] },
  "GET /api/sources/4/points": { body: [] },
  "GET /api/billing/costs": { body: { month: "2026-10", timezone: "Asia/Qatar", currency: "QAR", days: [], assets: [] } },
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
  it.each(["viewer", "operator"])("keeps Tariffs away from a %s", async (role) => {
    const calls = visit(role, "/tariffs");
    expect(await screen.findByText("Admins only")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/tariffs")).toBe(false);
  });

  it("opens Tariffs for an admin", async () => {
    visit("admin", "/tariffs");
    expect(await screen.findByRole("heading", { name: "Tariffs" })).toBeInTheDocument();
    expect(screen.queryByText("Admins only")).not.toBeInTheDocument();
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
    expect(await screen.findByText("Operators only")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/sources")).toBe(false);
  });

  it("opens Sources for an operator", async () => {
    visit("operator", "/sources");
    expect(await screen.findByRole("heading", { name: "Sources" })).toBeInTheDocument();
  });

  it.each(["viewer", "operator"])("keeps the source points page away from a %s", async (role) => {
    const calls = visit(role, "/sources/4/points");
    expect(await screen.findByText("Admins only")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/sources/4/points")).toBe(false);
  });

  it("opens the source points page for an admin", async () => {
    visit("admin", "/sources/4/points");
    expect(await screen.findByRole("heading", { name: "Points" })).toBeInTheDocument();
  });

  it.each(["viewer", "operator", "admin"])("answers an unknown address with a page, inside the layout, for a %s", async (role) => {
    visit(role, "/nope");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Assets" })).toBeInTheDocument(); // the nav is still there
  });
});
