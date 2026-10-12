import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { UsersPage } from "./UsersPage";

type Row = { id: number; username: string; role: string; active: boolean; blocked?: boolean };

const routes = () => {
  const users: Row[] = [
    { id: 1, username: "admin", role: "admin", active: true },
    { id: 2, username: "ops", role: "operator", active: true },
  ];
  return {
    "GET /api/setup": { body: { needed: false } },
    "GET /api/me": { body: { id: 1, username: "admin", role: "admin" } },
    "GET /api/users": () => ({ body: users }),
    "POST /api/users": ({ body }: { body: unknown }) => {
      users.push({ id: 3, active: true, ...(body as { username: string; role: string }) });
      return { status: 201, body: users[2] };
    },
    "PATCH /api/users/2": ({ body }: { body: unknown }) => {
      Object.assign(users[1], body as object);
      return { body: users[1] };
    },
  };
};

/** Opens a row's three-dot menu. The panel is a portal on document.body, so its items are found on `screen`, not inside the row. */
async function openMenu(row: HTMLElement, name: string) {
  await userEvent.click(within(row).getByRole("button", { name: `Actions for ${name}` }));
  return screen.getByRole("menu", { name: `Actions for ${name}` });
}

describe("UsersPage", () => {
  it("disables deactivate and role on own row", async () => {
    mockFetch(routes());
    renderWithProviders(<UsersPage />, { route: "/users", path: "/users" });
    const ownRow = (await screen.findByText("admin", { selector: "td" })).closest("tr")!;
    expect(within(ownRow).getByRole("combobox")).toBeDisabled();
    expect(within(await openMenu(ownRow, "admin")).getByRole("menuitem", { name: "Deactivate" })).toBeDisabled();
    const opsRow = screen.getByText("ops", { selector: "td" }).closest("tr")!;
    expect(within(await openMenu(opsRow, "ops")).getByRole("menuitem", { name: "Deactivate" })).toBeEnabled();
  });

  it("creates a user, changes a role and deactivates", async () => {
    const calls = mockFetch(routes());
    renderWithProviders(<UsersPage />, { route: "/users", path: "/users" });
    await screen.findByText("ops", { selector: "td" });
    await userEvent.type(screen.getByLabelText("Username"), "view");
    await userEvent.type(screen.getByLabelText("Password"), "longenough");
    await userEvent.selectOptions(screen.getByLabelText("Role"), "viewer");
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(await screen.findByText("view", { selector: "td" })).toBeInTheDocument();
    const opsRow = screen.getByText("ops", { selector: "td" }).closest("tr")!;
    await userEvent.selectOptions(within(opsRow).getByRole("combobox"), "viewer");
    await userEvent.click(within(await openMenu(opsRow, "ops")).getByRole("menuitem", { name: "Deactivate" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(await within(opsRow).findByText("inactive")).toBeInTheDocument();
    expect(within(await openMenu(opsRow, "ops")).getByRole("menuitem", { name: "Activate" })).toBeInTheDocument();
    const patches = calls.filter((c) => c.method === "PATCH").map((c) => c.body);
    expect(patches).toEqual([{ role: "viewer" }, { active: false }]);
  });

  it("shows the API error on a duplicate username", async () => {
    mockFetch({ ...routes(), "POST /api/users": { status: 409, body: { detail: "username already exists" } } });
    renderWithProviders(<UsersPage />, { route: "/users", path: "/users" });
    await screen.findByText("ops", { selector: "td" });
    await userEvent.type(screen.getByLabelText("Username"), "ops");
    await userEvent.type(screen.getByLabelText("Password"), "longenough");
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(await screen.findByText("username already exists")).toBeInTheDocument();
  });
});

describe("UsersPage delete and unblock", () => {
  type Calls = ReturnType<typeof mockFetch>;
  const rows = (): Row[] => [
    { id: 1, username: "admin", role: "admin", active: true, blocked: false },
    { id: 2, username: "ops", role: "operator", active: true, blocked: false },
    { id: 3, username: "locked", role: "viewer", active: true, blocked: true },
  ];
  /** The users route holds a mutable list; `extra` adds or overrides routes. */
  function open(extra: Parameters<typeof mockFetch>[0] = {}): { users: Row[]; calls: Calls } {
    const users = rows();
    const calls = mockFetch({
      "GET /api/setup": { body: { needed: false } },
      "GET /api/me": { body: { id: 1, username: "admin", role: "admin" } },
      "GET /api/users": () => ({ body: users }),
      "DELETE /api/users/2": () => { users.splice(1, 1); return { status: 204 }; },
      "POST /api/users/3/unblock": () => { users[2].blocked = false; return { body: { cleared: 1 } }; },
      ...extra,
    });
    renderWithProviders(<UsersPage />, { route: "/users", path: "/users" });
    return { users, calls };
  }
  const rowOf = (name: string) => screen.getByText(name, { selector: "td" }).closest("tr")!;
  const deletes = (calls: Calls) => calls.filter((c) => c.method === "DELETE");

  it("has a Delete button per row that names the account, disabled on your own", async () => {
    open();
    await screen.findByText("ops", { selector: "td" });
    expect(within(rowOf("admin")).getByRole("button", { name: "Delete admin" })).toBeDisabled();
    expect(within(rowOf("ops")).getByRole("button", { name: "Delete ops" })).toBeEnabled();
    expect(within(rowOf("locked")).getByRole("button", { name: "Delete locked" })).toBeEnabled();
  });

  it("asks before deleting and says what it does", async () => {
    const { calls } = open();
    await screen.findByText("ops", { selector: "td" });
    await userEvent.click(within(rowOf("ops")).getByRole("button", { name: "Delete ops" }));
    const dialog = screen.getByRole("dialog", { name: "Delete user ops?" });
    expect(dialog).toHaveTextContent(
      "ops will no longer be able to sign in. This cannot be undone. Their name stays in the audit log. "
      + "To keep the account but stop it signing in, deactivate it instead.",
    );
    expect(within(dialog).getByRole("button", { name: "Delete user" })).toBeInTheDocument();
    expect(deletes(calls)).toHaveLength(0);
  });

  it("deletes on confirm, closes the dialog and the row goes away after the refetch", async () => {
    const { calls } = open();
    await screen.findByText("ops", { selector: "td" });
    await userEvent.click(within(rowOf("ops")).getByRole("button", { name: "Delete ops" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete user" }));
    await waitFor(() => expect(screen.queryByText("ops", { selector: "td" })).not.toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deletes(calls).map((c) => c.path)).toEqual(["/api/users/2"]);
    expect(screen.getByText("locked", { selector: "td" })).toBeInTheDocument();
  });

  it("moves keyboard focus to the page heading after a delete (the row and its button are gone)", async () => {
    open();
    await screen.findByText("ops", { selector: "td" });
    await userEvent.click(within(rowOf("ops")).getByRole("button", { name: "Delete ops" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete user" }));
    await waitFor(() => expect(screen.queryByText("ops", { selector: "td" })).not.toBeInTheDocument());
    const heading = screen.getByRole("heading", { level: 1, name: "Users" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading).toHaveAttribute("tabindex", "-1");
  });

  it("keeps the dialog open and shows the API's refusal (last admin) as an alert", async () => {
    const { calls } = open({ "DELETE /api/users/2": { status: 409, body: { detail: "cannot remove the last active admin" } } });
    await screen.findByText("ops", { selector: "td" });
    await userEvent.click(within(rowOf("ops")).getByRole("button", { name: "Delete ops" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete user" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("cannot remove the last active admin");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("ops", { selector: "td" })).toBeInTheDocument();
    expect(deletes(calls)).toHaveLength(1);
  });

  it("Cancel and Escape close the dialog without a request", async () => {
    const { calls } = open();
    await screen.findByText("ops", { selector: "td" });
    await userEvent.click(within(rowOf("ops")).getByRole("button", { name: "Delete ops" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(within(rowOf("ops")).getByRole("button", { name: "Delete ops" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deletes(calls)).toHaveLength(0);
    expect(screen.getByText("ops", { selector: "td" })).toBeInTheDocument();
  });

  it("marks a blocked account next to its status and offers Unblock in its menu only", async () => {
    open();
    await screen.findByText("ops", { selector: "td" });
    expect(within(rowOf("locked")).getByText("blocked")).toBeInTheDocument();
    expect(within(await openMenu(rowOf("locked"), "locked")).getByRole("menuitem", { name: "Unblock" })).toBeEnabled();
    expect(within(rowOf("ops")).queryByText("blocked")).not.toBeInTheDocument();
    // The items are not in the page while a menu is closed, so look inside an open one.
    expect(within(await openMenu(rowOf("ops"), "ops")).queryByRole("menuitem", { name: "Unblock" })).not.toBeInTheDocument();
  });

  it("Unblock calls the route, then the mark and the menu item go away", async () => {
    const { calls } = open();
    await screen.findByText("locked", { selector: "td" });
    await userEvent.click(within(await openMenu(rowOf("locked"), "locked")).getByRole("menuitem", { name: "Unblock" }));
    await waitFor(() => expect(within(rowOf("locked")).queryByText("blocked")).not.toBeInTheDocument());
    expect(within(await openMenu(rowOf("locked"), "locked")).queryByRole("menuitem", { name: "Unblock" })).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/api/users/3/unblock"]);
  });

  it("shows the API's text when Unblock fails", async () => {
    open({ "POST /api/users/3/unblock": { status: 404, body: { detail: "user not found" } } });
    await screen.findByText("locked", { selector: "td" });
    await userEvent.click(within(await openMenu(rowOf("locked"), "locked")).getByRole("menuitem", { name: "Unblock" }));
    expect(await within(rowOf("locked")).findByRole("alert")).toHaveTextContent("user not found");
  });

  it("cannot delete yourself: the trash on your own row is disabled for the mouse and for the keyboard", async () => {
    const { calls } = open();
    await screen.findByText("ops", { selector: "td" });
    const trash = within(rowOf("admin")).getByRole("button", { name: "Delete admin" });
    expect(trash).toHaveClass("trash-btn");
    await userEvent.click(trash);
    trash.focus();
    expect(trash).not.toHaveFocus(); // a disabled button takes no focus, so Enter and Space have nowhere to land
    await userEvent.keyboard("{Enter}{ }");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deletes(calls)).toHaveLength(0);
  });

  it("cannot deactivate yourself: the menu item is disabled, skipped by the arrow keys, and does nothing when clicked", async () => {
    const { calls } = open();
    await screen.findByText("ops", { selector: "td" });
    within(rowOf("admin")).getByRole("button", { name: "Actions for admin" }).focus();
    await userEvent.keyboard("{Enter}");
    const menu = screen.getByRole("menu", { name: "Actions for admin" });
    const reset = within(menu).getByRole("menuitem", { name: "Reset password" });
    expect(reset).toHaveFocus(); // the first ENABLED item
    await userEvent.keyboard("{ArrowDown}");
    expect(reset).toHaveFocus(); // the only enabled one: it wraps to itself, never onto Deactivate
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Deactivate" }));
    expect(screen.getByRole("menu", { name: "Actions for admin" })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });
});

describe("UsersPage reset password", () => {
  const rows = (): Row[] => [
    { id: 1, username: "admin", role: "admin", active: true },
    { id: 2, username: "ops", role: "operator", active: true },
  ];
  function open(extra: Parameters<typeof mockFetch>[0] = {}) {
    const calls = mockFetch({
      "GET /api/setup": { body: { needed: false } },
      "GET /api/me": { body: { id: 1, username: "admin", role: "admin" } },
      "GET /api/users": { body: rows() },
      "PATCH /api/users/2": { body: { id: 2, username: "ops", role: "operator", active: true } },
      ...extra,
    });
    renderWithProviders(<UsersPage />, { route: "/users", path: "/users" });
    return calls;
  }
  const opsRow = () => screen.getByText("ops", { selector: "td" }).closest("tr")!;
  const trigger = () => within(opsRow()).getByRole("button", { name: "Actions for ops" });
  const reset = async () => {
    await screen.findByText("ops", { selector: "td" });
    await userEvent.click(within(await openMenu(opsRow(), "ops")).getByRole("menuitem", { name: "Reset password" }));
  };

  it("the menu item opens the form in the cell, beside the menu and the trash, and the password box has the focus", async () => {
    open();
    await reset();
    const input = within(opsRow()).getByLabelText("New password for ops");
    expect(input).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger()).toBeInTheDocument();
    expect(within(opsRow()).getByRole("button", { name: "Delete ops" })).toBeInTheDocument();
    expect(within(opsRow()).getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("Save sends the password, closes the form and gives the focus back to the menu button", async () => {
    const calls = open();
    await reset();
    await userEvent.type(within(opsRow()).getByLabelText("New password for ops"), "longenough{Enter}");
    await waitFor(() => expect(within(opsRow()).queryByLabelText("New password for ops")).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ password: "longenough" }]);
    expect(trigger()).toHaveFocus();
  });

  it("Cancel closes the form without a request and gives the focus back to the menu button", async () => {
    const calls = open();
    await reset();
    await userEvent.click(within(opsRow()).getByRole("button", { name: "Cancel" }));
    expect(within(opsRow()).queryByLabelText("New password for ops")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    expect(trigger()).toHaveFocus();
  });

  it("Escape does what Cancel does: closes the form without a request and gives the focus back to the menu button", async () => {
    const calls = open();
    await reset();
    const input = within(opsRow()).getByLabelText("New password for ops");
    await userEvent.type(input, "half");
    await userEvent.keyboard("{Escape}");
    expect(within(opsRow()).queryByLabelText("New password for ops")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    expect(trigger()).toHaveFocus();
  });

  it("Escape on the form's own buttons closes it too", async () => {
    open();
    await reset();
    within(opsRow()).getByRole("button", { name: "Save" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(within(opsRow()).queryByLabelText("New password for ops")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it("shows the API's text when the new password is refused, and keeps the form", async () => {
    open({ "PATCH /api/users/2": { status: 422, body: { detail: "password too weak" } } });
    await reset();
    await userEvent.type(within(opsRow()).getByLabelText("New password for ops"), "longenough{Enter}");
    expect(await within(opsRow()).findByRole("alert")).toHaveTextContent("password too weak");
    expect(within(opsRow()).getByLabelText("New password for ops")).toBeInTheDocument();
  });
});
