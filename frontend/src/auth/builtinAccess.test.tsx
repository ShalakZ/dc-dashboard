import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { Layout } from "../components/Layout";
import { mockFetch, shellRoutes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";

/**
 * What Viewer, Operator and Admin see and may open. The tables below are literals, written from the sidebar and the route guards as
 * they were before permissions replaced the three-step role (W9a), and they are NOT to be edited to make a change pass: the built-in
 * roles behave exactly as they always did. The only line that changes when the way a user is built changes is `me`.
 * The pages are stubs: this file tests the guards, the sidebar, the quick find and the landing, not the pages.
 */

vi.mock("../pages/AssetsPage", () => ({ AssetsPage: () => <h1>the assets page</h1> }));
vi.mock("../pages/AssetsSummary", () => ({ AssetsSummary: () => <h1>the assets summary</h1> }));
vi.mock("../pages/AssetPage", () => ({ AssetPage: () => <h1>the asset page</h1> }));
vi.mock("../pages/DashboardsPage", () => ({ DashboardsPage: () => <h1>the dashboards page</h1> }));
vi.mock("../pages/DashboardPage", () => ({ DashboardPage: () => <h1>the dashboard page</h1> }));
vi.mock("../pages/BillingPage", () => ({ BillingPage: () => <h1>the billing page</h1> }));
vi.mock("../pages/SourcesPage", () => ({ SourcesPage: () => <h1>the sources page</h1> }));
vi.mock("../pages/SourcePointsPage", () => ({ SourcePointsPage: () => <h1>the points page</h1> }));
vi.mock("../pages/ScansPage", () => ({ ScansPage: () => <h1>the scans page</h1> }));
vi.mock("../pages/DiscoveryPage", () => ({ DiscoveryPage: () => <h1>the discovery page</h1> }));
vi.mock("../pages/UsersPage", () => ({ UsersPage: () => <h1>the users page</h1> }));
vi.mock("../pages/SettingsPage", () => ({ SettingsPage: () => <h1>the settings page</h1> }));
vi.mock("../pages/TariffsPage", () => ({ TariffsPage: () => <h1>the tariffs page</h1> }));
vi.mock("../pages/StoragePage", () => ({ StoragePage: () => <h1>the storage page</h1> }));
vi.mock("../pages/AuditPage", () => ({ AuditPage: () => <h1>the audit page</h1> }));
vi.mock("../pages/AuditEntryPage", () => ({ AuditEntryPage: () => <h1>the audit entry page</h1> }));
vi.mock("../pages/DiagnosticsPage", () => ({ DiagnosticsPage: () => <h1>the diagnostics page</h1> }));
vi.mock("../pages/PasswordPage", () => ({ PasswordPage: () => <h1>the password page</h1> }));

type Role = "viewer" | "operator" | "admin";
const ROLES: Role[] = ["viewer", "operator", "admin"];

/** The user the server answers for `role`. */
const me = (role: Role) => ({ id: 1, username: "u", role });

const routes = (role: Role, defaultDashboard: number | null = null) => ({
  ...shellRoutes,
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: me(role) },
  "GET /api/dashboards/default": { body: { dashboard_id: defaultDashboard } },
  "GET /api/tls/status": { body: { enabled: false, state: null, not_after: null, days_left: null, subject: null, checked_at: null, error: null } },
});

const ROLE_WORD: Record<Role, string> = { viewer: "Viewer", operator: "Operator", admin: "Administrator" };

/** The sidebar: group headings and the links under them (label and address), in order. */
const MONITOR = [["Assets Tree", "/assets"], ["Dashboards", "/dashboards"], ["Billing", "/billing"]];
const OPERATE = [["Sources", "/sources"], ["Scans", "/scans"], ["Discovery", "/discovery"]];
const ADMINISTER = [
  ["Users", "/users"], ["Settings", "/settings"], ["Tariffs", "/tariffs"], ["Storage", "/storage"], ["Audit", "/audit"], ["Diagnostics", "/diagnostics"],
];
const SIDEBAR: Record<Role, [string, string[][]][]> = {
  viewer: [["Monitor", MONITOR]],
  operator: [["Monitor", MONITOR], ["Operate", OPERATE]],
  admin: [["Monitor", MONITOR], ["Operate", OPERATE], ["Administer", ADMINISTER]],
};

/** Every address the app serves behind sign-in, and the page that opens there. */
const PAGE: Record<string, string> = {
  "/assets": "the assets page",
  "/dashboards": "the dashboards page",
  "/dashboards/3": "the dashboard page",
  "/billing": "the billing page",
  "/password": "the password page",
  "/sources": "the sources page",
  "/scans": "the scans page",
  "/discovery": "the discovery page",
  "/sources/4/points": "the points page",
  "/users": "the users page",
  "/settings": "the settings page",
  "/tariffs": "the tariffs page",
  "/storage": "the storage page",
  "/audit": "the audit page",
  "/audit/7": "the audit entry page",
  "/diagnostics": "the diagnostics page",
};
const EVERYONE = ["/assets", "/dashboards", "/dashboards/3", "/billing", "/password"];
const OPERATORS_ADD = ["/sources", "/scans", "/discovery"];
const ADMINS_ADD = ["/sources/4/points", "/users", "/settings", "/tariffs", "/storage", "/audit", "/audit/7", "/diagnostics"];
const MAY_OPEN: Record<Role, string[]> = {
  viewer: EVERYONE,
  operator: [...EVERYONE, ...OPERATORS_ADD],
  admin: [...EVERYONE, ...OPERATORS_ADD, ...ADMINS_ADD],
};

/** The user's button in the top bar: once it shows, the user has loaded and every guard has been decided. */
const profileButton = () => screen.findByRole("button", { name: /^u (Administrator|Operator|Viewer)$/ });

/** Opens `route` as `role` and returns the first level-1 heading that appears: the page's own, or the notice that keeps the person out. */
async function opening(role: Role, route: string, defaultDashboard: number | null = null) {
  const calls = mockFetch(routes(role, defaultDashboard));
  renderWithProviders(<App />, { route, path: "*" });
  await profileButton();
  const heading = await screen.findByRole("heading", { level: 1 });
  return { heading: heading.textContent, calls };
}
const isAPage = (heading: string | null) => /^the .+ page$|^the assets summary$/.test(heading ?? "");

describe("the sidebar of each built-in role", () => {
  it.each(ROLES)("%s sees exactly its groups and links", async (role) => {
    mockFetch(routes(role));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await profileButton()).toHaveAccessibleName(`u ${ROLE_WORD[role]}`);
    const nav = screen.getByRole("navigation", { name: "Main" });
    const groups = within(nav).getAllByRole("group").map((group) => [
      group.querySelector(".nav-heading")?.textContent,
      within(group).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")]),
    ]);
    expect(groups).toEqual(SIDEBAR[role]);
  });

  it.each(ROLES)("%s: the Dashboards link opens the default dashboard when there is one", async (role) => {
    mockFetch(routes(role, 3));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await profileButton();
    await waitFor(() => expect(screen.getByRole("link", { name: "Dashboards" })).toHaveAttribute("href", "/dashboards/3"));
  });
});

describe("the pages each built-in role may open", () => {
  const cases = ROLES.flatMap((role) => Object.keys(PAGE).map((route) => [role, route] as const));
  it.each(cases)("%s opening %s", async (role, route) => {
    const { heading } = await opening(role, route);
    if (MAY_OPEN[role].includes(route)) expect(heading).toBe(PAGE[route]);
    else expect(isAPage(heading)).toBe(false); // the notice that keeps the person out, whatever its wording
  });

  it.each(ROLES)("%s: an address nobody serves shows the not-found page inside the layout", async (role) => {
    const { heading } = await opening(role, "/nope");
    expect(heading).toBe("Page not found");
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
  });
});

describe("where each built-in role lands", () => {
  it.each(ROLES)("%s lands on the Assets Tree when no default dashboard is set", async (role) => {
    expect((await opening(role, "/")).heading).toBe("the assets page");
  });

  it.each(ROLES)("%s lands on the default dashboard when one is set", async (role) => {
    expect((await opening(role, "/", 3)).heading).toBe("the dashboard page");
  });
});

describe("the quick find of each built-in role lists the pages it may open", () => {
  const LABELS = [...MONITOR, ...OPERATE, ...ADMINISTER].map(([label]) => label);
  it.each(ROLES)("%s", async (role) => {
    mockFetch(routes(role));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await profileButton();
    const field = screen.getByRole("combobox");
    const offered = SIDEBAR[role].flatMap(([, links]) => links.map(([label]) => label));
    for (const label of LABELS) {
      await userEvent.clear(field);
      await userEvent.type(field, label);
      if (offered.includes(label)) expect(await screen.findByRole("option", { name: label })).toBeInTheDocument();
      else expect(await screen.findByText("No match")).toBeInTheDocument();
    }
  });
});

describe("what the shell asks the server for, per built-in role", () => {
  it.each(ROLES)("%s: the default dashboard and the asset list, and the certificate status only as admin", async (role) => {
    const calls = mockFetch(routes(role));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await profileButton();
    await waitFor(() => expect(calls.some((c) => c.path === "/api/dashboards/default")).toBe(true));
    expect(calls.some((c) => c.path === "/api/assets")).toBe(true);
    if (role === "admin") await waitFor(() => expect(calls.some((c) => c.path === "/api/tls/status")).toBe(true));
    else expect(calls.some((c) => c.path === "/api/tls/status")).toBe(false);
  });
});
