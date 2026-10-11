import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RequireRole } from "../auth/RequireAuth";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
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
    await screen.findByText("u"); // the user has loaded, so role-gated links are decided
    expect(screen.getByText(ROLE_WORD[role])).toBeInTheDocument(); // the role is written out under the name
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
    await screen.findByText("u");
    await waitFor(() => expect(calls.some((c) => c.path === "/api/me")).toBe(true));
    expect(calls.some((c) => c.path === "/api/tls/status")).toBe(false);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("Layout user block", () => {
  it.each(["viewer", "operator", "admin"] as const)("shows the name with the %s role word below it", async (role) => {
    mockFetch(routes(role));
    const { container } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByText("u")).toHaveClass("who-name");
    expect(screen.getByText(ROLE_WORD[role])).toHaveClass("who-role");
    expect(container.querySelector(".who .avatar")).toHaveTextContent("U");
    expect(screen.queryByText(`u (${role})`)).not.toBeInTheDocument(); // the old single text run is gone
  });

  it("renders before the user has loaded without an avatar letter or a role word", () => {
    mockFetch(routes("admin"));
    const { container } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(container.querySelector(".who .avatar")).toBeEmptyDOMElement();
    expect(container.querySelector(".who-role")).toBeEmptyDOMElement();
  });
});

describe("Layout sidebar landmarks and groups", () => {
  it("has exactly one navigation landmark and no complementary one", async () => {
    mockFetch(routes("admin"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await screen.findByText("u");
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.getByRole("navigation")).toHaveAccessibleName("Main");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it.each([
    ["viewer", ["Monitor"], ["Operate", "Administer"]],
    ["operator", ["Monitor", "Operate"], ["Administer"]],
    ["admin", ["Monitor", "Operate", "Administer"], []],
  ] as const)("%s sees the groups %j and not %j", async (role, shown, absent) => {
    mockFetch(routes(role));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await screen.findByText("u"); // the user has loaded, so a missing group is really gated away
    for (const name of shown) expect(screen.getByRole("group", { name })).toBeInTheDocument();
    for (const name of absent) expect(screen.queryByRole("group", { name })).not.toBeInTheDocument();
  });

  it("puts each link in its group, in the order of the old bar", async () => {
    mockFetch(routes("admin"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await screen.findByText("u");
    const linksOf = (group: string) => within(screen.getByRole("group", { name: group })).getAllByRole("link").map((a) => a.textContent);
    expect(linksOf("Monitor")).toEqual(["Assets", "Dashboards", "Billing"]);
    expect(linksOf("Operate")).toEqual(["Sources", "Scans", "Discovery"]);
    expect(linksOf("Administer")).toEqual(["Users", "Settings", "Tariffs", "Storage", "Audit"]);
  });

  it("marks the current page and no other link", async () => {
    mockFetch(routes("admin"));
    renderWithProviders(<Layout />, { route: "/billing", path: "/billing" });
    await screen.findByText("u");
    expect(screen.getByRole("link", { name: "Billing" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Assets" })).not.toHaveAttribute("aria-current");
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

  it("minimized, every link is still there by name, and so are Password and Sign out", async () => {
    mockFetch(routes("admin"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await screen.findByText("u");
    await userEvent.click(screen.getByRole("button", { name: "Minimize sidebar" }));
    for (const name of ["Assets", "Dashboards", "Billing", "Sources", "Scans", "Discovery", "Users", "Settings", "Tariffs", "Storage", "Audit", "Password"]) {
      expect(screen.getByRole("link", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
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

  it("puts the toggle, Password and Sign out in the foot, after the links and before main", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await screen.findByText("u");
    const links = screen.getAllByRole("link").map((a) => a.textContent);
    expect(links[0]).toBe("Skip to content");
    expect(links.indexOf("Assets")).toBeLessThan(links.indexOf("Password"));
    const tail = screen.getAllByRole("button").map((b) => b.textContent);
    expect(tail.slice(-2)).toEqual(["Sign out", "Minimize sidebar"]);
  });
});

describe("Layout minimized tooltip", () => {
  const tip = () => screen.getByRole("tooltip", { hidden: true });
  const minimize = async () => {
    await screen.findByText("u");
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
    act(() => screen.getByRole("link", { name: "Assets" }).focus());
    expect(tip()).toHaveTextContent("Assets");
    act(() => screen.getByRole("link", { name: "Billing" }).focus());
    expect(tip()).toHaveTextContent("Billing");
    act(() => screen.getByRole("button", { name: "Sign out" }).focus());
    expect(tip()).toHaveTextContent("Sign out");
    act(() => screen.getByRole("button", { name: "Sign out" }).blur());
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

  it("shows the name and the role word for the user block", async () => {
    mockFetch(routes("operator"));
    const { container } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await minimize();
    await userEvent.hover(container.querySelector(".who") as HTMLElement);
    expect(tip().querySelector(".side-tip-text")).toHaveTextContent("u");
    expect(tip().querySelector(".side-tip-sub")).toHaveTextContent("Operator");
  });

  it("shows the toggle's current name", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await minimize();
    act(() => screen.getByRole("link", { name: "Assets" }).focus()); // the click left the focus on the toggle: move away and back
    act(() => screen.getByRole("button", { name: "Expand sidebar" }).focus());
    expect(tip()).toHaveTextContent("Expand sidebar");
  });

  it("does not show while the sidebar is expanded, and goes when the sidebar is expanded again", async () => {
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await screen.findByText("u");
    act(() => screen.getByRole("link", { name: "Assets" }).focus());
    expect(tip()).toHaveAttribute("hidden");
    await userEvent.click(screen.getByRole("button", { name: "Minimize sidebar" }));
    act(() => screen.getByRole("link", { name: "Assets" }).focus());
    expect(tip()).not.toHaveAttribute("hidden");
    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(tip()).toHaveAttribute("hidden");
  });
});
