import { screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { progress } from "./lib/progress";
import { dashboard } from "./test/dashboardFixtures";
import { mockFetch, shellRoutes } from "./test/fetchMock";
import { holdFetch } from "./test/holdFetch";
import { renderWithProviders } from "./test/render";

// The two lazy pages' chunks, held: a factory runs when the route first imports its module, and the module arrives when its gate opens.
const chunks = vi.hoisted(() => {
  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => { open = resolve; });
    return { promise, open };
  };
  return { list: gate(), one: gate() };
});
vi.mock("./pages/DashboardsPage", async () => {
  await chunks.list.promise;
  return { DashboardsPage: () => <h1>the dashboards page</h1> };
});
vi.mock("./pages/DashboardPage", async () => {
  await chunks.one.promise;
  return { DashboardPage: () => <h1>the dashboard page</h1> };
});

const routes = {
  ...shellRoutes,
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role: "viewer" } },
  "GET /api/dashboards/3": { body: dashboard({ widgets: [] }) },
};
const LABEL = "Loading the page";
const region = () => screen.getByText(LABEL).parentElement!;

describe("the lazy routes while their chunk loads", () => {
  it("/dashboards shows the page skeleton as one status region and the loading bar counts it; then the page", async () => {
    mockFetch(routes);
    renderWithProviders(<App />, { route: "/dashboards", path: "*" });
    await screen.findByText(LABEL);
    expect(region()).toHaveAttribute("role", "status");
    expect(region()).toHaveClass("sk-region");
    expect(region().querySelector("header.page-head")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    await waitFor(() => expect(progress.getCount("pending")).toBe(1)); // Pending is mounted next to the skeleton in the fallback
    chunks.list.open();
    expect(await screen.findByRole("heading", { name: "the dashboards page" })).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    await waitFor(() => expect(progress.getCount("pending")).toBe(0));
  });

  it("/dashboards/3 does the same for the dashboard's chunk", async () => {
    mockFetch(routes);
    renderWithProviders(<App />, { route: "/dashboards/3", path: "*" });
    await screen.findByText(LABEL);
    expect(region()).toHaveAttribute("role", "status");
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    await waitFor(() => expect(progress.getCount("pending")).toBe(1));
    chunks.one.open();
    expect(await screen.findByRole("heading", { name: "the dashboard page" })).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    await waitFor(() => expect(progress.getCount("pending")).toBe(0));
  });
});

describe("the home route while the default dashboard is asked", () => {
  it("shows the page skeleton as one status region, counted by the bar, and never Assets first; then it redirects", async () => {
    chunks.one.open();
    const calls = mockFetch({ ...routes, "GET /api/dashboards/default": { body: { dashboard_id: 3 } } });
    const held = holdFetch((_method, path) => path === "/api/dashboards/default");
    renderWithProviders(<App />, { route: "/", path: "*" });
    await screen.findByText(LABEL);
    expect(region()).toHaveAttribute("role", "status");
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    await waitFor(() => expect(progress.getCount("pending")).toBe(1));
    expect(calls.some((c) => c.path === "/api/fleet/summary")).toBe(false);
    held.release();
    expect(await screen.findByRole("heading", { name: "the dashboard page" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(LABEL)).not.toBeInTheDocument());
    await waitFor(() => expect(progress.getCount("pending")).toBe(0));
  });
});
