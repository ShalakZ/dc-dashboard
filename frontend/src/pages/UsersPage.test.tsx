import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import type { PermissionId } from "../lib/permissions";
import { mockFetch, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { builtinRoles, catalogue } from "../test/permissionFixtures";
import { renderWithProviders } from "../test/render";
import { userFor } from "../test/users";
import { UsersPage } from "./UsersPage";

type Row = { id: number; username: string; role: string; active: boolean };

/** What a role holds, by name: the page decides from the permissions of the signed-in account. */
const ADMIN: PermissionId[] = ["users.view", "users.edit", "roles.manage"];

const routes = (permissions: PermissionId[], extra: Routes = {}): Routes => {
  const users: Row[] = [
    { id: 1, username: "admin", role: "admin", active: true },
    { id: 2, username: "ops", role: "operator", active: true },
  ];
  return {
    "GET /api/setup": { body: { needed: false } },
    "GET /api/me": { body: userFor("Staff", { id: 1, username: "admin", permissions }) },
    "GET /api/users": () => ({ body: users }),
    "DELETE /api/users/2": () => { users.splice(1, 1); return { status: 204 }; },
    "GET /api/roles": { body: builtinRoles() },
    "GET /api/permissions": { body: catalogue() },
    ...extra,
  };
};

/** The app mounts a page once the account is known (RequireAuth); the tests do the same, or the page would decide on no permissions at all. */
function WhenKnown({ children }: { children: ReactNode }) {
  return useAuth().user ? <>{children}</> : null;
}
/** Shows where the router is and how it got there, and has a Back button (the memory router has no browser chrome). */
function Where() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="address">{location.pathname}</output>
      <output aria-label="how">{useNavigationType()}</output>
      <button type="button" onClick={() => navigate(-1)}>Go back</button>
    </>
  );
}

const open = (permissions: PermissionId[], route = "/users", extra: Routes = {}) => {
  const calls = mockFetch(routes(permissions, extra));
  renderWithProviders(<WhenKnown><UsersPage /><Where /></WhenKnown>, { route, path: "/users/:tab?" });
  return calls;
};
const address = () => screen.getByLabelText("address").textContent;
const tab = (name: string) => screen.getByRole("tab", { name });
const crumbs = () => within(screen.getByRole("navigation", { name: "Breadcrumb" }));

describe("UsersPage: the shell of Users & Roles", () => {
  it("opens on the Users tab at /users, under the page title, its sub line and the trail Users & Roles / Users", async () => {
    open(ADMIN);
    expect(await screen.findByRole("heading", { level: 1, name: "Users & Roles" })).toBeInTheDocument();
    expect(screen.getByText("Who can sign in, and what each role lets them do.")).toBeInTheDocument();
    expect(tab("Users")).toHaveAttribute("aria-selected", "true");
    expect(tab("Roles")).toHaveAttribute("aria-selected", "false");
    expect(await screen.findByText("ops", { selector: "td" })).toBeInTheDocument(); // the Users tab's table
    expect(screen.getByRole("tabpanel", { name: "Users" })).toBeInTheDocument();
    expect(crumbs().getByRole("link", { name: "Users & Roles" })).toHaveAttribute("href", "/users");
    expect(crumbs().getByText("Users")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("table", { name: "Roles" })).not.toBeInTheDocument();
  });

  it("/users/roles opens the Roles tab, with its list, and the trail ends in Roles", async () => {
    open(ADMIN, "/users/roles");
    expect(await screen.findByRole("table", { name: "Roles" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New role" })).toBeInTheDocument();
    expect(tab("Roles")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Roles" })).toBeInTheDocument();
    expect(crumbs().getByText("Roles")).toHaveAttribute("aria-current", "page");
    expect(crumbs().getByRole("link", { name: "Users & Roles" })).toHaveAttribute("href", "/users");
    expect(screen.queryByText("ops", { selector: "td" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1); // the panel's heading is an h2
  });

  it("the arrow keys switch the tab and the address; Back returns to the tab before; the trail follows", async () => {
    open(ADMIN);
    await screen.findByText("ops", { selector: "td" });
    tab("Users").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(address()).toBe("/users/roles");
    expect(screen.getByLabelText("how")).toHaveTextContent("PUSH"); // a push, so Back works
    expect(tab("Roles")).toHaveFocus();
    expect(await screen.findByRole("table", { name: "Roles" })).toBeInTheDocument();
    expect(crumbs().getByText("Roles")).toHaveAttribute("aria-current", "page");

    await userEvent.keyboard("{ArrowLeft}");
    expect(address()).toBe("/users");
    expect(await screen.findByText("ops", { selector: "td" })).toBeInTheDocument();

    await userEvent.keyboard("{End}");
    expect(address()).toBe("/users/roles");
    await userEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(address()).toBe("/users");
    expect(tab("Users")).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("ops", { selector: "td" })).toBeInTheDocument();
  });

  it("a click on a tab switches it, and the page title crumb leads back to /users", async () => {
    open(ADMIN, "/users/roles");
    await screen.findByRole("table", { name: "Roles" });
    await userEvent.click(tab("Users"));
    expect(address()).toBe("/users");
    expect(await screen.findByText("ops", { selector: "td" })).toBeInTheDocument();
    await userEvent.click(tab("Roles"));
    await userEvent.click(crumbs().getByRole("link", { name: "Users & Roles" }));
    expect(address()).toBe("/users");
    expect(tab("Users")).toHaveAttribute("aria-selected", "true");
  });

  it("a fresh render at /users/roles keeps the tab (a reload does the same)", async () => {
    open(ADMIN, "/users/roles");
    expect(await screen.findByRole("table", { name: "Roles" })).toBeInTheDocument();
    expect(tab("Roles")).toHaveAttribute("aria-selected", "true");
    expect(address()).toBe("/users/roles");
  });

  it("users.view alone: no tab strip, no Roles tab, the Users tab straight under the title", async () => {
    open(["users.view"]);
    expect(await screen.findByText("ops", { selector: "td" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New role" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Users & Roles" })).toBeInTheDocument();
  });

  it("a person who may see the users but not manage roles gets No access at /users/roles, never a blank page, and no roles are asked for by the Roles tab", async () => {
    const calls = open(["users.view", "users.edit"], "/users/roles");
    expect(await screen.findByRole("heading", { level: 1, name: "No access" })).toBeInTheDocument();
    expect(screen.getByText("Your role does not include this page.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Roles" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/permissions")).toBe(false); // the catalogue is for roles.manage
  });

  it("roles.manage without users.view has only the Roles tab, and /users sends them there (a replace, so Back is not trapped)", async () => {
    const calls = open(["roles.manage"], "/users");
    expect(await screen.findByRole("table", { name: "Roles" })).toBeInTheDocument();
    expect(address()).toBe("/users/roles");
    expect(screen.getByLabelText("how")).toHaveTextContent("REPLACE");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument(); // one tab: no strip
    expect(screen.getByRole("heading", { level: 1, name: "Users & Roles" })).toBeInTheDocument();
    expect(crumbs().getByText("Roles")).toHaveAttribute("aria-current", "page");
    expect(calls.some((c) => c.path === "/api/users")).toBe(false); // no Users tab, no account list
  });

  it("a person with neither permission gets No access on both tabs", async () => {
    open(["audit.view"]);
    expect(await screen.findByRole("heading", { level: 1, name: "No access" })).toBeInTheDocument();
  });

  it("/users/nonsense shows the Not found page (the browser tab title stays Users & Roles, because the address starts with /users: accepted)", async () => {
    open(ADMIN, "/users/nonsense");
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Users & Roles" })).not.toBeInTheDocument();
  });

  it("only the Users tab asks for the accounts, and only the Roles tab for the catalogue", async () => {
    const calls = open(ADMIN);
    await screen.findByText("ops", { selector: "td" });
    expect(calls.some((c) => c.path === "/api/permissions")).toBe(false);
    await userEvent.click(tab("Roles"));
    await screen.findByRole("table", { name: "Roles" });
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/permissions")).toHaveLength(1));
  });

  it("the page header is there while the Users tab loads, and it is the same h1 element once the list lands", async () => {
    mockFetch(routes(ADMIN));
    const held = holdFetch((_method, path) => path === "/api/users");
    renderWithProviders(<WhenKnown><UsersPage /></WhenKnown>, { route: "/users", path: "/users/:tab?" });
    const heading = await screen.findByRole("heading", { level: 1, name: "Users & Roles" });
    expect(await screen.findByText("Loading users")).toBeInTheDocument();
    held.release();
    await screen.findByText("ops", { selector: "td" });
    expect(screen.getByRole("heading", { level: 1, name: "Users & Roles" })).toBe(heading);
  });

  it("after a user is deleted the h1 takes the focus (the row and its Delete button are gone)", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    open(ADMIN);
    const row = (await screen.findByText("ops", { selector: "td" })).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Delete ops" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete user" }));
    await waitFor(() => expect(screen.queryByText("ops", { selector: "td" })).not.toBeInTheDocument());
    const heading = screen.getByRole("heading", { level: 1, name: "Users & Roles" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading).toHaveAttribute("tabindex", "-1");
    // Focusing the h1 must not scroll the page back to the top (the Asset kinds page jumped after each delete).
    const onHeading = focus.mock.calls.filter((_, i) => focus.mock.contexts[i] === heading);
    expect(onHeading).toEqual([[{ preventScroll: true }]]);
  });

  it("is one route for both tabs: the address /users/:tab? keeps one page instance, so switching tabs keeps the h1 element", async () => {
    open(ADMIN);
    const heading = await screen.findByRole("heading", { level: 1, name: "Users & Roles" });
    await userEvent.click(tab("Roles"));
    await screen.findByRole("table", { name: "Roles" });
    expect(screen.getByRole("heading", { level: 1, name: "Users & Roles" })).toBe(heading);
  });
});
