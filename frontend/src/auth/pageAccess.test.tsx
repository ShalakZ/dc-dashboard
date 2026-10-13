import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { GROUPS, PAGE_NEED } from "../components/navItems";
import type { PermissionId } from "../lib/permissions";
import { mockFetch, shellRoutes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { userFor } from "../test/users";
import { meets, type Need } from "./need";

/**
 * Pages, sidebar, quick find and landing for a role an administrator made: what it can open follows its permissions and nothing else.
 * (builtinAccess.test.tsx holds the same for the three built-in roles.) The pages are stubs: only the guards and the shell are under test.
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

const ROLE = "Night shift";

const routes = (permissions: PermissionId[], defaultDashboard: number | null = null) => ({
  ...shellRoutes,
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor(ROLE, { permissions }) },
  "GET /api/dashboards/default": { body: { dashboard_id: defaultDashboard } },
  "GET /api/tls/status": { body: { enabled: false, state: null, not_after: null, days_left: null, subject: null, checked_at: null, error: null } },
});

/** Opens `route` as a person whose role holds exactly `permissions`; returns the first level-1 heading that shows and the requests made. */
async function opening(permissions: PermissionId[], route: string, defaultDashboard: number | null = null) {
  const calls = mockFetch(routes(permissions, defaultDashboard));
  const { unmount } = renderWithProviders(<App />, { route, path: "*" });
  await screen.findByRole("button", { name: new RegExp(`^u ${ROLE}$`) }); // the user has loaded, so every guard is decided
  const heading = await screen.findByRole("heading", { level: 1 });
  return { heading: heading.textContent, calls, unmount };
}
const nav = () => within(screen.getByRole("navigation", { name: "Main" }));
const needIds = (need: Need): PermissionId[] => (typeof need === "string" ? [need] : [...need]);

/** Every address behind sign-in that is guarded, with what it needs and the page that opens. */
const ROUTES: [string, Need, string][] = [
  ["/assets", PAGE_NEED.assets, "the assets page"],
  ["/assets/5", PAGE_NEED.assets, "the assets page"],
  ["/dashboards", PAGE_NEED.dashboards, "the dashboards page"],
  ["/dashboards/3", PAGE_NEED.dashboards, "the dashboard page"],
  ["/billing", PAGE_NEED.billing, "the billing page"],
  ["/sources", PAGE_NEED.sources, "the sources page"],
  ["/sources/4/points", PAGE_NEED.sourcePoints, "the points page"],
  ["/scans", PAGE_NEED.scans, "the scans page"],
  ["/discovery", PAGE_NEED.discovery, "the discovery page"],
  ["/users", PAGE_NEED.users, "the users page"],
  ["/settings", PAGE_NEED.settings, "the settings page"],
  ["/tariffs", PAGE_NEED.tariffs, "the tariffs page"],
  ["/storage", PAGE_NEED.storage, "the storage page"],
  ["/audit", PAGE_NEED.audit, "the audit page"],
  ["/audit/7", PAGE_NEED.audit, "the audit entry page"],
  ["/diagnostics", PAGE_NEED.diagnostics, "the diagnostics page"],
];

describe("a page opens for exactly the permissions it needs", () => {
  it.each(ROUTES)("%s opens for %j and for no less", async (route, need, page) => {
    const wanted = needIds(need);
    const { heading } = await opening(wanted, route);
    expect(heading).toBe(page);
  });

  const missingOne = ROUTES.flatMap(([route, need]) => needIds(need).map((missing) => [route, missing, needIds(need).filter((id) => id !== missing)] as const));
  it.each(missingOne)("%s without %s shows No access (holding %j)", async (route, _missing, held) => {
    const { heading } = await opening(held, route);
    expect(heading).toBe("No access");
    expect(screen.getByText("Your role does not include this page.")).toBeInTheDocument();
  });

  it("a role with no permissions at all gets No access on every page", async () => {
    const { heading } = await opening([], "/billing");
    expect(heading).toBe("No access");
  });

  it("a page nobody guards (the password page) opens for a role with no permissions", async () => {
    const { heading } = await opening([], "/password");
    expect(heading).toBe("the password page");
  });

  it("holding other pages' permissions does not open this one", async () => {
    const everythingElse = (["users.view", "settings.edit", "storage.view", "audit.view", "sources.edit", "billing.view"] as PermissionId[]);
    expect((await opening(everythingElse, "/tariffs")).heading).toBe("No access");
  });
});

describe("the sidebar follows the permissions", () => {
  it("shows a link only for a page the role may open, under a heading only when a link is left under it", async () => {
    await opening(["sources.view", "billing.view"], "/password");
    const groups = nav().getAllByRole("group").map((group) => [
      group.querySelector(".nav-heading")?.textContent,
      within(group).getAllByRole("link").map((link) => link.textContent),
    ]);
    expect(groups).toEqual([["Monitor", ["Billing"]], ["Operate", ["Sources"]]]);
  });

  it("shows no group and no link to a role with no permissions, and still the profile button", async () => {
    await opening([], "/password");
    expect(nav().queryAllByRole("group")).toHaveLength(0);
    expect(nav().queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByRole("button", { name: `u ${ROLE}` })).toBeInTheDocument();
  });

  it.each(GROUPS.flatMap((group) => group.items))("$label is in the sidebar for exactly the permissions its page needs", async (item) => {
    const wanted = needIds(item.need);
    (await opening(wanted, "/password")).unmount();
    for (const missing of wanted) {
      const view = await opening(wanted.filter((id) => id !== missing), "/password");
      expect(nav().queryByRole("link", { name: item.label })).not.toBeInTheDocument();
      view.unmount();
    }
    await opening(wanted, "/password");
    expect(nav().getByRole("link", { name: item.label })).toBeInTheDocument();
  });

  it("every sidebar link has a route with the same need", async () => {
    // The route table above lists the page each link leads to; a link whose need differs from its route's would show a link that opens No access.
    for (const item of GROUPS.flatMap((group) => group.items)) {
      const route = ROUTES.find(([path]) => path === item.to);
      expect(route, item.to).toBeDefined();
      expect(needIds(route![1]).sort()).toEqual(needIds(item.need).sort());
    }
  });

  it("the certificate warning is asked for by a role that may see Settings, and by no other", async () => {
    const some = await opening(["settings.view"], "/password");
    await waitFor(() => expect(some.calls.some((c) => c.path === "/api/tls/status")).toBe(true));
    some.unmount();
    const other = await opening(["settings.edit", "audit.view"], "/password");
    await waitFor(() => expect(other.calls.some((c) => c.path === "/api/status")).toBe(true)); // the shell has made its requests
    expect(other.calls.some((c) => c.path === "/api/tls/status")).toBe(false);
  });
});

describe("the shell asks only for what the role may read", () => {
  it("a role without dashboards.view never asks for the default dashboard; one without assets.view never asks for the asset list", async () => {
    const { calls } = await opening(["billing.view"], "/password");
    await screen.findByRole("combobox"); // the quick find is mounted
    expect(calls.some((c) => c.path === "/api/dashboards/default")).toBe(false);
    expect(calls.some((c) => c.path === "/api/assets")).toBe(false);
  });

  it("a role with both asks for both", async () => {
    const { calls } = await opening(["assets.view", "dashboards.view"], "/password");
    await waitFor(() => expect(calls.some((c) => c.path === "/api/dashboards/default")).toBe(true));
    expect(calls.some((c) => c.path === "/api/assets")).toBe(true);
  });
});

describe("the quick find lists the pages the role may open", () => {
  it("finds Users for users.view and not Settings", async () => {
    await opening(["users.view"], "/password");
    const field = screen.getByRole("combobox");
    await userEvent.type(field, "Users");
    expect(await screen.findByRole("option", { name: "Users" })).toBeInTheDocument();
    await userEvent.clear(field);
    await userEvent.type(field, "Settings");
    expect(await screen.findByText("No match")).toBeInTheDocument();
  });
});

describe("where a role lands", () => {
  it("on the default dashboard, when it may see dashboards and one is set", async () => {
    expect((await opening(["dashboards.view", "assets.view"], "/", 3)).heading).toBe("the dashboard page");
  });

  it("on the Assets Tree when it may see assets and no default is set", async () => {
    expect((await opening(["dashboards.view", "assets.view"], "/")).heading).toBe("the assets page");
  });

  it("on the Assets Tree, and never asking for the default, when it may see assets but not dashboards", async () => {
    const { heading, calls } = await opening(["assets.view"], "/", 3);
    expect(heading).toBe("the assets page");
    expect(calls.some((c) => c.path === "/api/dashboards/default")).toBe(false);
  });

  it("on the dashboard list when dashboards are all it may see and no default is set", async () => {
    expect((await opening(["dashboards.view"], "/")).heading).toBe("the dashboards page");
  });

  it("on the dashboard when dashboards are all it may see and one is set", async () => {
    expect((await opening(["dashboards.view"], "/", 3)).heading).toBe("the dashboard page");
  });

  it("on the first page of the sidebar it may open when it may see neither dashboards nor assets", async () => {
    const first = await opening(["sources.view", "users.view"], "/");
    expect(first.heading).toBe("the sources page");
    first.unmount();
    const second = await opening(["users.view", "audit.view"], "/");
    expect(second.heading).toBe("the users page");
    second.unmount();
    expect((await opening(["billing.view", "sources.view"], "/")).heading).toBe("the billing page");
  });

  it("on a plain screen when no page is open to it, and it asks for nothing and does not loop", async () => {
    const { heading, calls } = await opening([], "/");
    expect(heading).toBe("Your role has no pages yet.");
    expect(screen.getByText("Ask an administrator to give your role access.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/dashboards/default" || c.path === "/api/assets")).toBe(false);
  });

  it("on that screen too when it holds permissions that open no page (an export or a change without the view)", async () => {
    expect((await opening(["billing.export", "assets.edit", "tariffs.edit"], "/")).heading).toBe("Your role has no pages yet.");
  });

  it("a list of permissions is met only by holding all of it", () => {
    expect(meets(PAGE_NEED.tariffs, (id) => id === "tariffs.edit")).toBe(false);
    expect(meets(PAGE_NEED.tariffs, (id) => id === "tariffs.edit" || id === "assets.view")).toBe(true);
    expect(meets(undefined, () => false)).toBe(true);
  });
});

describe("the page map", () => {
  // The W9a plan's ruling and Amendments I9 and I10, typed out: a page asks for the permission of its heaviest call. The tests above read the
  // map, so this is the one place that pins its values.
  it("is the one the plan fixed", () => {
    expect(PAGE_NEED).toEqual({
      assets: "assets.view",
      dashboards: "dashboards.view",
      billing: "billing.view",
      sources: "sources.view",
      sourcePoints: "sources.edit",
      scans: "discovery.view",
      discovery: "discovery.view",
      users: "users.view",
      settings: "settings.view",
      tariffs: ["tariffs.edit", "assets.view"],
      storage: "storage.view",
      audit: "audit.view",
      diagnostics: ["diagnostics.view", "sources.view"],
    });
  });
});
