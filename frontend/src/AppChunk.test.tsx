import { screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { progress } from "./lib/progress";
import { dashboard } from "./test/dashboardFixtures";
import { mockFetch, shellRoutes } from "./test/fetchMock";
import { holdFetch } from "./test/holdFetch";
import { renderWithProviders } from "./test/render";
import { userFor } from "./test/users";

// The three lazy pages' chunks, held: a factory runs when the route first imports its module, and the module arrives when its gate opens.
const chunks = vi.hoisted(() => {
  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => { open = resolve; });
    return { promise, open };
  };
  return { list: gate(), one: gate(), discovery: gate(), discoveryAsked: 0 };
});
vi.mock("./pages/DashboardsPage", async () => {
  await chunks.list.promise;
  return { DashboardsPage: () => <h1>the dashboards page</h1> };
});
vi.mock("./pages/DashboardPage", async () => {
  await chunks.one.promise;
  return { DashboardPage: () => <h1>the dashboard page</h1> };
});

vi.mock("./pages/DiscoveryPage", async () => {
  chunks.discoveryAsked += 1;
  await chunks.discovery.promise;
  return { DiscoveryPage: () => <h1>the discovery page</h1> };
});

const routes = {
  ...shellRoutes,
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor("viewer") },
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

describe("the discovery route (its graph library loads with the page, not with the app)", () => {
  // First in the file to ask for the module: the count stays 0 only while nothing has imported it yet.
  it("a viewer gets No access, with no skeleton, and the chunk is never asked for", async () => {
    mockFetch(routes);
    renderWithProviders(<App />, { route: "/discovery", path: "*" });
    expect(await screen.findByRole("heading", { name: "No access" })).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(chunks.discoveryAsked).toBe(0);
  });

  it("/discovery shows the page skeleton as one status region and the loading bar counts it; then the page", async () => {
    mockFetch({ ...routes, "GET /api/me": { body: userFor("operator") } });
    renderWithProviders(<App />, { route: "/discovery", path: "*" });
    await screen.findByText(LABEL);
    expect(region()).toHaveAttribute("role", "status");
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    await waitFor(() => expect(progress.getCount("pending")).toBe(1));
    expect(chunks.discoveryAsked).toBe(1);
    chunks.discovery.open();
    expect(await screen.findByRole("heading", { name: "the discovery page" })).toBeInTheDocument();
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
