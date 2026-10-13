import { useQueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { keys } from "../api/queries";
import { RequirePermission } from "../auth/RequireAuth";
import { noteReach, resetServerReach } from "../lib/serverReach";
import { mockFetch, shellRoutes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { userFor } from "../test/users";
import { Layout } from "./Layout";

const ROLE_WORD = { admin: "Administrator", operator: "Operator", viewer: "Viewer" } as const;

/** jsdom has no matchMedia; a test that wants a window of a given kind installs one, and the afterEach below removes it. */
function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", { value: () => ({ matches }), configurable: true, writable: true });
}
afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

const routes = (role: string) => ({
  ...shellRoutes,
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor(role) },
});

/**
 * The signed-in user's button in the top bar. Its name is the user and then the role word, so it doubles as the signal that the
 * user has loaded (a text lookup would find the name twice: the panel under the button is always mounted).
 */
const profileButton = () => screen.findByRole("button", { name: /^u (Administrator|Operator|Viewer)$/ });
/** Presses the user's button and returns the panel it opens. */
const openProfile = async () => {
  await userEvent.click(await profileButton());
  return document.getElementById("profile-panel") as HTMLElement;
};

describe("Layout nav", () => {
  it("shows admin links only to admins, Password link to everyone", async () => {
    mockFetch(routes("admin"));
    const { unmount } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("link", { name: "Users & Roles" })).toHaveAttribute("href", "/users");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(within(await openProfile()).getByRole("link", { name: "Password" })).toHaveAttribute("href", "/password");
    unmount();
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(within(await openProfile()).getByRole("link", { name: "Password" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Users & Roles" })).not.toBeInTheDocument(); // (Testing Library names are exact: the old "Users" would pass for any reason)
    expect(screen.queryByRole("link", { name: "Sources" })).not.toBeInTheDocument();
  });
});

describe("Layout tab title", () => {
  afterEach(() => { document.title = "DC Dashboard"; });

  it("names the page in the tab, and goes back to the application's name when the layout goes away", async () => {
    mockFetch(routes("admin"));
    const view = renderWithProviders(<Layout />, { route: "/audit/7", path: "/audit/:id" });
    await profileButton();
    expect(document.title).toBe("Audit log \u00b7 DC Dashboard");
    view.unmount();
    expect(document.title).toBe("DC Dashboard");
  });

  it("follows the address: another page, another title", async () => {
    mockFetch(routes("admin"));
    renderWithProviders(<Layout />, { route: "/billing" }); // the route is "*", so the layout stays mounted when the address changes
    await profileButton();
    expect(document.title).toBe("Billing \u00b7 DC Dashboard");
    await userEvent.click(screen.getByRole("link", { name: "Users & Roles" }));
    expect(document.title).toBe("Users & Roles \u00b7 DC Dashboard");
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
    await profileButton();
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
    await profileButton();
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
    await profileButton();
    expect(screen.queryByRole("link", { name: "Audit" })).not.toBeInTheDocument();
  });
});

describe("RequirePermission", () => {
  it("shows a viewer visiting /users the No access page instead of the API error", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(
      <RequirePermission need="users.view"><p>users page</p></RequirePermission>,
      { route: "/users", path: "/users" },
    );
    expect(await screen.findByRole("heading", { name: "No access" })).toBeInTheDocument();
    expect(screen.getByText("Your role does not include this page.")).toBeInTheDocument();
    expect(screen.queryByText("users page")).not.toBeInTheDocument();
  });

  it("keeps the same page from a viewer and lets an operator in", async () => {
    mockFetch(routes("viewer"));
    const viewer = renderWithProviders(
      <RequirePermission need="discovery.view"><p>scans page</p></RequirePermission>,
      { route: "/scans", path: "/scans" },
    );
    expect(await screen.findByRole("heading", { name: "No access" })).toBeInTheDocument();
    expect(screen.queryByText("scans page")).not.toBeInTheDocument();
    viewer.unmount();
    mockFetch(routes("operator"));
    renderWithProviders(
      <RequirePermission need="discovery.view"><p>scans page</p></RequirePermission>,
      { route: "/scans", path: "/scans" },
    );
    expect(await screen.findByText("scans page")).toBeInTheDocument();
  });

  it("renders the page for an admin", async () => {
    mockFetch(routes("admin"));
    renderWithProviders(
      <RequirePermission need="users.view"><p>users page</p></RequirePermission>,
      { route: "/users", path: "/users" },
    );
    expect(await screen.findByText("users page")).toBeInTheDocument();
  });

  it("an array means all of them: one missing keeps the page away", async () => {
    mockFetch(routes("operator")); // holds tariffs.view and assets.view, not tariffs.edit
    renderWithProviders(
      <RequirePermission need={["assets.view", "tariffs.edit"]}><p>tariffs page</p></RequirePermission>,
      { route: "/tariffs", path: "/tariffs" },
    );
    expect(await screen.findByRole("heading", { name: "No access" })).toBeInTheDocument();
    expect(screen.queryByText("tariffs page")).not.toBeInTheDocument();
  });
});

describe("Layout phase 3 links", () => {
  it.each(["viewer", "operator", "admin"] as const)("%s sees Dashboards and Billing, and Tariffs unless a viewer", async (role) => {
    mockFetch(routes(role));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await profileButton()).toHaveAccessibleName(`u ${ROLE_WORD[role]}`); // the user has loaded, so role-gated links are decided; the role is written out
    expect(screen.getByRole("link", { name: "Dashboards" })).toHaveAttribute("href", "/dashboards");
    expect(screen.getByRole("link", { name: "Billing" })).toHaveAttribute("href", "/billing");
    // The Operator holds tariffs.view and assets.view, so since W9b it has the (read-only) Tariffs page too.
    if (role === "viewer") expect(screen.queryByRole("link", { name: "Tariffs" })).not.toBeInTheDocument();
    else expect(screen.getByRole("link", { name: "Tariffs" })).toHaveAttribute("href", "/tariffs");
  });
});

describe("Layout Dashboards entry and the default dashboard", () => {
  const dashboardsLink = () => screen.getByRole("link", { name: "Dashboards" });

  it("opens the default dashboard when one is set, and the list when none is", async () => {
    mockFetch({ ...routes("viewer"), "GET /api/dashboards/default": { body: { dashboard_id: 7 } } });
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await profileButton();
    await waitFor(() => expect(dashboardsLink()).toHaveAttribute("href", "/dashboards/7"));
  });

  it("follows a default that changes while it stays mounted: when asked again, and by itself every minute", async () => {
    let defaultId: number | null = 7;
    mockFetch({ ...routes("viewer"), "GET /api/dashboards/default": () => ({ body: { dashboard_id: defaultId } }) });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); // before the render, so the query's interval is the fake one
    try {
      const Ask = () => {
        const client = useQueryClient();
        return <button onClick={() => void client.invalidateQueries({ queryKey: keys.defaultDashboard })}>ask again</button>;
      };
      renderWithProviders(<><Layout /><Ask /></>, { route: "/assets", path: "/assets" });
      await profileButton();
      await waitFor(() => expect(dashboardsLink()).toHaveAttribute("href", "/dashboards/7"));

      defaultId = 9; // another admin picked a new default
      await userEvent.click(screen.getByRole("button", { name: "ask again" }));
      await waitFor(() => expect(dashboardsLink()).toHaveAttribute("href", "/dashboards/9"));

      defaultId = null; // and then deleted it
      act(() => { vi.advanceTimersByTime(60_000); });
      await waitFor(() => expect(dashboardsLink()).toHaveAttribute("href", "/dashboards"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the list as its target while the default is unknown or cannot be read", async () => {
    mockFetch({ ...routes("viewer"), "GET /api/dashboards/default": { status: 500, body: { detail: "boom" } } });
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await profileButton();
    expect(dashboardsLink()).toHaveAttribute("href", "/dashboards"); // still pending
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dashboardsLink()).toHaveAttribute("href", "/dashboards"); // failed
  });

  it.each([["/dashboards"], ["/dashboards/3"], ["/dashboards/9"]])("is the current page on %s whatever the default is", async (route) => {
    mockFetch({ ...routes("viewer"), "GET /api/dashboards/default": { body: { dashboard_id: 7 } } });
    renderWithProviders(<Layout />, { route, path: "*" });
    await profileButton();
    await waitFor(() => expect(dashboardsLink()).toHaveAttribute("href", "/dashboards/7"));
    expect(dashboardsLink()).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Assets Tree" })).not.toHaveAttribute("aria-current");
  });

  it("matches whole path segments: /dashboardsX is not the Dashboards page", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/dashboardsX", path: "*" });
    await profileButton();
    expect(dashboardsLink()).not.toHaveAttribute("aria-current");
  });

  it("still names the minimized strip's tooltip Dashboards", async () => {
    mockFetch({ ...routes("viewer"), "GET /api/dashboards/default": { body: { dashboard_id: 7 } } });
    localStorage.setItem("dcdash.sidebar", "minimized");
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await profileButton();
    await waitFor(() => expect(dashboardsLink()).toHaveAttribute("href", "/dashboards/7"));
    act(() => dashboardsLink().focus());
    expect(document.getElementById("side-tip")).toHaveTextContent("Dashboards");
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

  it.each(["/billing", "/dashboards/3", "/dashboards", "/assets", "/sources/4/points"])(
    "gives %s no width class: every page uses the whole window",
    async (route) => {
      mockFetch(routes("viewer"));
      renderWithProviders(<Layout />, { route, path: "*" });
      const main = await screen.findByRole("main");
      expect(main).not.toHaveClass("wide");
    },
  );
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
    // in main: the top bar's data chip is a status too
    expect(await within(await screen.findByRole("main")).findByRole("status")).toHaveTextContent("The HTTPS certificate expires on 2026-11-09 11:03:11 (12 days left)");
  });

  it.each(["operator", "viewer"])("does not even ask for the status as %s", async (role) => {
    const calls = mockFetch(withTls(role));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await profileButton();
    await waitFor(() => expect(calls.some((c) => c.path === "/api/me")).toBe(true));
    expect(calls.some((c) => c.path === "/api/tls/status")).toBe(false);
    expect(within(screen.getByRole("main")).queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("Layout top bar", () => {
  it.each(["viewer", "operator", "admin"] as const)("puts the %s user in the banner: the name with the role word after it", async (role) => {
    mockFetch(routes(role));
    const { container } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    const trigger = await profileButton();
    expect(trigger).toHaveAccessibleName(`u ${ROLE_WORD[role]}`);
    expect(screen.getByRole("banner")).toContainElement(trigger);
    expect(trigger.querySelector(".who-name")).toHaveTextContent("u");
    expect(trigger.querySelector(".who-role")).toHaveTextContent(ROLE_WORD[role]);
    expect(container.querySelector(".who .avatar")).toHaveTextContent("U");
  });

  it("holds the brand, the data chip, the site time and the profile, above the sidebar and main", async () => {
    mockFetch(routes("admin"));
    const { container } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    const banner = screen.getByRole("banner");
    expect(banner).toHaveClass("navbar");
    expect(within(banner).getByText("DC Dashboard")).toBeInTheDocument();
    expect(await within(banner).findByRole("status")).toHaveTextContent("Live"); // the data chip, from /api/status
    expect(banner.querySelector(".live")).toHaveAttribute("data-state", "live");
    await waitFor(() => expect(banner.querySelector(".site-time time")).toHaveTextContent(/^\d\d:\d\d$/)); // from /api/site
    expect(within(banner).getByRole("button", { name: "u Administrator" })).toBeInTheDocument();
    // the bar is the first thing in the shell, then one frame holds the sidebar and main
    const shell = container.querySelector(".shell") as HTMLElement;
    expect(Array.from(shell.children).map((el) => el.tagName + (el.className ? `.${el.className.split(" ")[0]}` : ""))).toEqual(["HEADER.navbar", "DIV.frame"]);
    const frame = shell.querySelector(".frame") as HTMLElement;
    expect(Array.from(frame.children).map((el) => el.tagName)).toEqual(["DIV", "MAIN"]);
    expect(frame.children[0]).toHaveAttribute("id", "sidebar");
    expect(within(frame.children[0] as HTMLElement).queryByText("DC Dashboard")).not.toBeInTheDocument(); // the brand moved out of the rail
  });

  it("renders no loading bar of its own (RequireAuth owns the one bar above it)", async () => {
    mockFetch(routes("viewer"));
    const { container } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await profileButton();
    expect(container.querySelector(".top-progress")).not.toBeInTheDocument();
  });

  it("puts the quick find first in the bar's content, ahead of the chip, the time and the profile", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    const bar = screen.getByRole("banner").querySelector(".bar-in") as HTMLElement;
    const first = bar.firstElementChild as HTMLElement;
    expect(first).toHaveAttribute("role", "search");
    expect(within(first).getByRole("combobox", { name: "Quick find" })).toBeInTheDocument();
    expect(first.nextElementSibling).toHaveClass("grow");
    expect(screen.getAllByRole("search")).toHaveLength(1);
    await profileButton();
  });

  it("keeps the brand's label for a screen reader when the sidebar is minimized", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await userEvent.click(await screen.findByRole("button", { name: "Minimize sidebar" }));
    expect(within(screen.getByRole("banner")).getByText("DC Dashboard")).toBeInTheDocument();
  });

  it("says nothing about the data while /api/status cannot be read, and shows no alert for it", async () => {
    mockFetch({ ...routes("viewer"), "GET /api/status": { status: 500, body: { detail: "down" } } });
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await profileButton();
    await waitFor(() => expect(screen.getByRole("banner").querySelector(".site-time time")).not.toBeNull());
    expect(within(screen.getByRole("banner")).queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("opens a panel under the user's button with Password and Sign out, which the sidebar no longer holds", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    const panel = await openProfile();
    expect(panel).not.toHaveAttribute("hidden");
    expect(screen.getByRole("banner")).toContainElement(panel);
    expect(within(panel).getByRole("link", { name: "Password" })).toHaveAttribute("href", "/password");
    expect(within(panel).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    const rail = screen.getByRole("navigation", { name: "Main" });
    expect(within(rail).queryByRole("link", { name: "Password" })).not.toBeInTheDocument();
    expect(within(rail).queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("renders before the user has loaded without an avatar letter or a role word", () => {
    mockFetch(routes("admin"));
    const { container } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(container.querySelector(".who .avatar")).toBeEmptyDOMElement();
    expect(container.querySelector(".who-role")).toBeEmptyDOMElement();
  });
});

describe("Layout sidebar landmarks and groups", () => {
  it("has exactly one navigation landmark, named Main, one banner and no complementary one", async () => {
    mockFetch(routes("admin"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await profileButton();
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.getByRole("navigation")).toHaveAccessibleName("Main");
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it.each([
    ["viewer", ["Monitor"], ["Operate", "Administer"]],
    ["operator", ["Monitor", "Operate", "Administer"], []], // Administer holds Tariffs alone (W9b)
    ["admin", ["Monitor", "Operate", "Administer"], []],
  ] as const)("%s sees the groups %j and not %j", async (role, shown, absent) => {
    mockFetch(routes(role));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await profileButton(); // the user has loaded, so a missing group is really gated away
    for (const name of shown) expect(screen.getByRole("group", { name })).toBeInTheDocument();
    for (const name of absent) expect(screen.queryByRole("group", { name })).not.toBeInTheDocument();
  });

  it("the Operator's Administer group holds the Tariffs link and nothing else", async () => {
    mockFetch(routes("operator"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await profileButton();
    expect(within(screen.getByRole("group", { name: "Administer" })).getAllByRole("link").map((a) => a.textContent)).toEqual(["Tariffs"]);
  });

  it("a role that opens no page has no sidebar column (no navigation, no toggle), and keeps the top bar and the main area", async () => {
    mockFetch({ ...routes("Nothing"), "GET /api/me": { body: userFor("Nothing", { permissions: [] }) } });
    const { container } = renderWithProviders(<Layout />, { route: "/", path: "/" });
    await screen.findByRole("button", { name: /^u Nothing$/ }); // the user has loaded, so the missing column is really gated away
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sidebar$/ })).not.toBeInTheDocument();
    expect(container.querySelector("#sidebar")).toBeNull();
    expect(screen.getByRole("banner")).toHaveClass("navbar");
    const frame = container.querySelector(".frame") as HTMLElement;
    expect(Array.from(frame.children).map((el) => el.tagName)).toEqual(["MAIN"]);
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("a role with one page keeps the sidebar, with only that page's group", async () => {
    mockFetch({ ...routes("Reader"), "GET /api/me": { body: userFor("Reader", { permissions: ["assets.view"] }) } });
    const { container } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await screen.findByRole("button", { name: /^u Reader$/ });
    expect(container.querySelector("#sidebar")).not.toBeNull();
    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-labelledby"))).toEqual(["nav-monitor"]);
    expect(screen.getByRole("button", { name: "Minimize sidebar" })).toBeInTheDocument();
  });

  it("puts each link in its group, in the order of the old bar", async () => {
    mockFetch(routes("admin"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await profileButton();
    const linksOf = (group: string) => within(screen.getByRole("group", { name: group })).getAllByRole("link").map((a) => a.textContent);
    expect(linksOf("Monitor")).toEqual(["Assets Tree", "Dashboards", "Billing"]);
    expect(linksOf("Operate")).toEqual(["Sources", "Scans", "Discovery"]);
    expect(linksOf("Administer")).toEqual(["Users & Roles", "Settings", "Tariffs", "Storage", "Audit", "Diagnostics"]);
  });

  it("marks the current page and no other link", async () => {
    mockFetch(routes("admin"));
    renderWithProviders(<Layout />, { route: "/billing", path: "/billing" });
    await profileButton();
    expect(screen.getByRole("link", { name: "Billing" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Assets Tree" })).not.toHaveAttribute("aria-current");
  });
});

describe("Layout sidebar toggle", () => {
  const shell = (container: HTMLElement) => container.querySelector(".shell") as HTMLElement;

  it("starts expanded and flips its name and data-sidebar, with no aria-expanded and focus kept", async () => {
    mockFetch(routes("viewer"));
    const { container } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    const toggle = await screen.findByRole("button", { name: "Minimize sidebar" });
    expect(shell(container)).toHaveAttribute("data-sidebar", "expanded");
    expect(toggle).not.toHaveAttribute("aria-expanded");
    await userEvent.click(toggle);
    expect(shell(container)).toHaveAttribute("data-sidebar", "minimized");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBe(toggle); // the same element, so focus did not move
    expect(toggle).toHaveFocus();
    expect(toggle).not.toHaveAttribute("aria-expanded");
    await userEvent.click(toggle);
    expect(shell(container)).toHaveAttribute("data-sidebar", "expanded");
    expect(screen.getByRole("button", { name: "Minimize sidebar" })).toBe(toggle);
    expect(toggle).toHaveFocus();
  });

  it("remembers the choice the user made", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await userEvent.click(await screen.findByRole("button", { name: "Minimize sidebar" }));
    expect(localStorage.getItem("dcdash.sidebar")).toBe("minimized");
    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(localStorage.getItem("dcdash.sidebar")).toBe("expanded");
  });

  it("minimized, every link is still there by name", async () => {
    mockFetch(routes("admin"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await profileButton();
    await userEvent.click(screen.getByRole("button", { name: "Minimize sidebar" }));
    for (const name of ["Assets Tree", "Dashboards", "Billing", "Sources", "Scans", "Discovery", "Users & Roles", "Settings", "Tariffs", "Storage", "Audit", "Diagnostics"]) {
      expect(screen.getByRole("link", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("group", { name: "Monitor" })).toBeInTheDocument(); // the headings stay in the DOM too
  });

  it("applies a stored minimized on mount", async () => {
    localStorage.setItem("dcdash.sidebar", "minimized");
    mockFetch(routes("viewer"));
    const { container } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(shell(container)).toHaveAttribute("data-sidebar", "minimized");
  });

  it("starts minimized in a narrow window without storing that as the user's choice", async () => {
    stubMatchMedia(true);
    mockFetch(routes("viewer"));
    const { container } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(shell(container)).toHaveAttribute("data-sidebar", "minimized");
    expect(localStorage.getItem("dcdash.sidebar")).toBeNull();
  });

  it("still renders expanded, and still toggles, when storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    mockFetch(routes("viewer"));
    const { container } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    const toggle = await screen.findByRole("button", { name: "Minimize sidebar" });
    expect(shell(container)).toHaveAttribute("data-sidebar", "expanded");
    await userEvent.click(toggle);
    expect(shell(container)).toHaveAttribute("data-sidebar", "minimized");
  });

  it("keeps only the toggle in the foot, after the links and before main", async () => {
    mockFetch(routes("viewer"));
    const { container } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await profileButton();
    expect(screen.getAllByRole("link")[0]).toHaveAccessibleName("Skip to content");
    const foot = container.querySelector(".side-foot") as HTMLElement;
    expect(foot.children).toHaveLength(1);
    expect(within(foot).getByRole("button")).toHaveAccessibleName("Minimize sidebar");
    expect(within(foot).queryAllByRole("link")).toHaveLength(0);
    const groups = container.querySelector(".nav-groups") as HTMLElement;
    expect(groups.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(foot.compareDocumentPosition(screen.getByRole("main")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("Layout minimized tooltip", () => {
  const tip = () => screen.getByRole("tooltip", { hidden: true });
  const minimize = async () => {
    await profileButton();
    await userEvent.click(screen.getByRole("button", { name: "Minimize sidebar" }));
  };

  it("is aria-hidden and hidden until a minimized row is focused", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await minimize();
    expect(tip()).toHaveAttribute("aria-hidden", "true");
    expect(tip()).toHaveAttribute("hidden");
    expect(tip()).toHaveTextContent(""); // no stray copy of a label for a text lookup to find
  });

  it("shows the focused link's label and Escape hides it", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await minimize();
    act(() => screen.getByRole("link", { name: "Dashboards" }).focus());
    expect(tip()).not.toHaveAttribute("hidden");
    expect(tip()).toHaveTextContent("Dashboards");
    await userEvent.keyboard("{Escape}");
    expect(tip()).toHaveAttribute("hidden");
    expect(tip()).toHaveTextContent("");
    expect(screen.getByRole("link", { name: "Dashboards" })).toHaveFocus(); // Escape dismisses without moving focus
  });

  it("follows the focus from row to row and hides on blur", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await minimize();
    act(() => screen.getByRole("link", { name: "Assets Tree" }).focus());
    expect(tip()).toHaveTextContent("Assets Tree");
    act(() => screen.getByRole("link", { name: "Billing" }).focus());
    expect(tip()).toHaveTextContent("Billing");
    act(() => screen.getByRole("button", { name: "Expand sidebar" }).focus());
    expect(tip()).toHaveTextContent("Expand sidebar");
    act(() => screen.getByRole("button", { name: "Expand sidebar" }).blur());
    expect(tip()).toHaveAttribute("hidden");
  });

  it("shows on hover, stays while the pointer is on the tip, and goes when it leaves", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await minimize();
    const link = screen.getByRole("link", { name: "Billing" });
    await userEvent.hover(link);
    expect(tip()).toHaveTextContent("Billing");
    expect(tip()).not.toHaveAttribute("hidden");
    await userEvent.unhover(link);
    await userEvent.hover(tip()); // the gap between row and tip is crossed inside the hide delay: hoverable
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(tip()).not.toHaveAttribute("hidden");
    await userEvent.unhover(tip());
    await waitFor(() => expect(tip()).toHaveAttribute("hidden"));
  });

  it("hides when the rail scrolls under a hovering pointer, but a focused row keeps its tip", async () => {
    mockFetch(routes("admin"));
    const { container } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await minimize();
    const rail = container.querySelector(".nav-groups") as HTMLElement;
    await userEvent.hover(screen.getByRole("link", { name: "Billing" }));
    expect(tip()).not.toHaveAttribute("hidden");
    fireEvent.scroll(rail);
    expect(tip()).toHaveAttribute("hidden");
    // the browser scrolls a focused row into view: that scroll must not take its tip away
    act(() => screen.getByRole("link", { name: "Audit" }).focus());
    expect(tip()).toHaveTextContent("Audit");
    fireEvent.scroll(rail);
    expect(tip()).not.toHaveAttribute("hidden");
    expect(tip()).toHaveTextContent("Audit");
  });

  it("is for the rows and the toggle only: the user's button in the bar gets none", async () => {
    mockFetch(routes("operator"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await minimize();
    await userEvent.hover(await profileButton());
    act(() => screen.getByRole("button", { name: /^u Operator$/ }).focus());
    expect(tip()).toHaveAttribute("hidden");
    expect(tip()).toHaveTextContent("");
  });

  it("shows the toggle's current name", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await minimize();
    act(() => screen.getByRole("link", { name: "Assets Tree" }).focus()); // the click left the focus on the toggle: move away and back
    act(() => screen.getByRole("button", { name: "Expand sidebar" }).focus());
    expect(tip()).toHaveTextContent("Expand sidebar");
  });

  it("does not show while the sidebar is expanded, and goes when the sidebar is expanded again", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await profileButton();
    act(() => screen.getByRole("link", { name: "Assets Tree" }).focus());
    expect(tip()).toHaveAttribute("hidden");
    await userEvent.click(screen.getByRole("button", { name: "Minimize sidebar" }));
    act(() => screen.getByRole("link", { name: "Assets Tree" }).focus());
    expect(tip()).not.toHaveAttribute("hidden");
    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(tip()).toHaveAttribute("hidden");
  });
});

describe("Layout server notice", () => {
  afterEach(() => {
    act(() => resetServerReach());
  });

  it("shows the can't-reach-the-server notice among the shell notices while two requests in a row got no answer, and removes it after one that did", async () => {
    mockFetch(routes("viewer"));
    const { container } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await profileButton();
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20))); // the shell's first answers are in
    expect(screen.queryByText(/Can't reach the server/)).not.toBeInTheDocument();
    act(() => { noteReach(false); noteReach(false); });
    const notice = screen.getByText(/Can't reach the server/).closest("[role=status]");
    expect(notice).toHaveClass("banner-warn");
    expect(container.querySelector(".shell-notices")).toContainElement(notice as HTMLElement);
    act(() => noteReach(true));
    expect(screen.queryByText(/Can't reach the server/)).not.toBeInTheDocument();
  });
});
