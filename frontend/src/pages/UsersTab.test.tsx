import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePatchRole } from "../api/queries";
import { mockFetch } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { accountKnown, SignedIn } from "../test/signedIn";
import { userFor } from "../test/users";
import type { PermissionId } from "../lib/permissions";
import { UsersTab } from "./UsersTab";

type Row = { id: number; username: string; role: string; active: boolean; blocked?: boolean };

const routes = () => {
  const users: Row[] = [
    { id: 1, username: "admin", role: "admin", active: true },
    { id: 2, username: "ops", role: "operator", active: true },
  ];
  return {
    "GET /api/setup": { body: { needed: false } },
    "GET /api/me": { body: userFor("admin", { username: "admin" }) },
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

describe("UsersTab", () => {
  it("disables deactivate and role on own row", async () => {
    mockFetch(routes());
    renderWithProviders(<UsersTab onDeleted={() => {}} />, { route: "/users", path: "/users" });
    const ownRow = (await screen.findByText("admin", { selector: "td" })).closest("tr")!;
    expect(within(ownRow).getByRole("combobox")).toBeDisabled();
    expect(within(await openMenu(ownRow, "admin")).getByRole("menuitem", { name: "Deactivate" })).toBeDisabled();
    const opsRow = screen.getByText("ops", { selector: "td" }).closest("tr")!;
    expect(within(await openMenu(opsRow, "ops")).getByRole("menuitem", { name: "Deactivate" })).toBeEnabled();
  });

  it("creates a user, changes a role and deactivates", async () => {
    const calls = mockFetch(routes());
    renderWithProviders(<UsersTab onDeleted={() => {}} />, { route: "/users", path: "/users" });
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
    renderWithProviders(<UsersTab onDeleted={() => {}} />, { route: "/users", path: "/users" });
    await screen.findByText("ops", { selector: "td" });
    await userEvent.type(screen.getByLabelText("Username"), "ops");
    await userEvent.type(screen.getByLabelText("Password"), "longenough");
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(await screen.findByText("Username already exists.")).toBeInTheDocument();
  });
});

describe("UsersTab delete and unblock", () => {
  type Calls = ReturnType<typeof mockFetch>;
  const rows = (): Row[] => [
    { id: 1, username: "admin", role: "admin", active: true, blocked: false },
    { id: 2, username: "ops", role: "operator", active: true, blocked: false },
    { id: 3, username: "locked", role: "viewer", active: true, blocked: true },
  ];
  /** The users route holds a mutable list; `extra` adds or overrides routes. */
  function open(extra: Parameters<typeof mockFetch>[0] = {}, onDeleted: () => void = () => {}): { users: Row[]; calls: Calls } {
    const users = rows();
    const calls = mockFetch({
      "GET /api/setup": { body: { needed: false } },
      "GET /api/me": { body: userFor("admin", { username: "admin" }) },
      "GET /api/users": () => ({ body: users }),
      "DELETE /api/users/2": () => { users.splice(1, 1); return { status: 204 }; },
      "POST /api/users/3/unblock": () => { users[2].blocked = false; return { body: { cleared: 1 } }; },
      ...extra,
    });
    renderWithProviders(<UsersTab onDeleted={onDeleted} />, { route: "/users", path: "/users" });
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

  it("tells the page once a row is deleted, so it can take the keyboard focus (the row and its button are gone), and not when the delete is refused", async () => {
    const onDeleted = vi.fn();
    open({ "DELETE /api/users/3": { status: 409, body: { detail: "cannot remove the last active admin" } } }, onDeleted);
    await screen.findByText("ops", { selector: "td" });
    await userEvent.click(within(rowOf("locked")).getByRole("button", { name: "Delete locked" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete user" }));
    await within(screen.getByRole("dialog")).findByRole("alert");
    expect(onDeleted).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await userEvent.click(within(rowOf("ops")).getByRole("button", { name: "Delete ops" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete user" }));
    await waitFor(() => expect(screen.queryByText("ops", { selector: "td" })).not.toBeInTheDocument());
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open and shows the API's refusal (last admin) as an alert", async () => {
    const { calls } = open({ "DELETE /api/users/2": { status: 409, body: { detail: "cannot remove the last active admin" } } });
    await screen.findByText("ops", { selector: "td" });
    await userEvent.click(within(rowOf("ops")).getByRole("button", { name: "Delete ops" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete user" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Cannot remove the last active admin.");
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
    expect(await within(rowOf("locked")).findByRole("alert")).toHaveTextContent("User not found.");
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

describe("UsersTab reset password", () => {
  const rows = (): Row[] => [
    { id: 1, username: "admin", role: "admin", active: true },
    { id: 2, username: "ops", role: "operator", active: true },
  ];
  function open(extra: Parameters<typeof mockFetch>[0] = {}) {
    const calls = mockFetch({
      "GET /api/setup": { body: { needed: false } },
      "GET /api/me": { body: userFor("admin", { username: "admin" }) },
      "GET /api/users": { body: rows() },
      "PATCH /api/users/2": { body: { id: 2, username: "ops", role: "operator", active: true } },
      ...extra,
    });
    renderWithProviders(<UsersTab onDeleted={() => {}} />, { route: "/users", path: "/users" });
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
    expect(await within(opsRow()).findByRole("alert")).toHaveTextContent("Password too weak.");
    expect(within(opsRow()).getByLabelText("New password for ops")).toBeInTheDocument();
  });
});

describe("UsersTab while the list loads (W7f)", () => {
  const LABEL = "Loading users";
  const mount = () => renderWithProviders(<UsersTab onDeleted={() => {}} />, { route: "/users", path: "/users" });
  const heldUsers = () => holdFetch((_method, path) => path === "/api/users");

  it("shows a table skeleton in a status region while the list is held, then the list in its place (the header around it is the page's)", async () => {
    mockFetch(routes());
    const held = heldUsers();
    mount();
    const region = screen.getByText(LABEL).parentElement!;
    expect(region).toHaveAttribute("role", "status");
    await waitFor(() => expect(region.querySelectorAll(".sk-table thead th")).toHaveLength(4)); // (the permissions arrive with /api/me, a moment after the first render; in the app the page mounts after them)
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument(); // the placeholder is not a table to assistive technology
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument(); // the title is UsersPage's
    held.release();
    expect(await screen.findByText("ops", { selector: "td" })).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
  });

  it("ends with the error alone, as a sentence, when the list fails, never a region", async () => {
    mockFetch({ ...routes(), "GET /api/users": { status: 500, body: { detail: "users are down" } } });
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Users are down.");
    expect(document.querySelector(".sk-region")).toBeNull();
  });
});

describe("UsersTab controls follow the permissions of the role (a custom role)", () => {
  const rows = (): Row[] => [
    { id: 1, username: "admin", role: "admin", active: true },
    { id: 2, username: "ops", role: "operator", active: true },
    { id: 3, username: "night", role: "night-shift", active: true, blocked: true },
  ];
  /** A role called "custom" that holds users.view and `permissions`, signed in as user 9; the list and the account are there when this returns. */
  const show = async (permissions: PermissionId[]) => {
    const calls = mockFetch({
      "GET /api/setup": { body: { needed: false } },
      "GET /api/me": { body: userFor("custom", { id: 9, username: "boss", permissions: ["users.view", ...permissions] }) },
      "GET /api/users": { body: rows() },
    });
    renderWithProviders(<><UsersTab onDeleted={() => {}} /><SignedIn /></>, { route: "/users", path: "/users" });
    await screen.findByText("ops", { selector: "td" });
    await accountKnown();
    return calls;
  };

  it("users.view alone: the list with each role as text, and no form, no menu, no trash, no role select", async () => {
    await show([]);
    expect(screen.getByText("admin", { selector: "td.cell-user" })).toBeInTheDocument();
    const night = screen.getByText("night", { selector: "td.cell-user" }).closest("tr")!;
    expect(within(night).getByText("night-shift")).toBeInTheDocument();
    expect(within(night).getByText("blocked")).toBeInTheDocument(); // the state is still shown
    const ops = screen.getByText("ops", { selector: "td.cell-user" }).closest("tr")!;
    expect(within(ops).getAllByRole("cell")[1].textContent).toBe("Operator"); // a built-in role is written as the Roles tab writes it
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Create user" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create user" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete / })).not.toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Username", "Role", "Status"]);
  });

  it("users.edit: the role select, the menu with Unblock on a blocked account, the trash and the Create user form", async () => {
    await show(["users.edit"]);
    expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Create user" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete ops" })).toBeInTheDocument();
    const night = screen.getByText("night", { selector: "td.cell-user" }).closest("tr")!;
    expect(within(await openMenu(night, "night")).getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Deactivate", "Reset password", "Unblock"]);
  });

  it("an account whose role is not one of the built-in names keeps its role in the select, and does not show the first option instead", async () => {
    await show(["users.edit"]);
    const night = screen.getByText("night", { selector: "td.cell-user" }).closest("tr")!;
    const select = within(night).getByRole("combobox", { name: "Role for night" }) as HTMLSelectElement;
    expect(select.value).toBe("night-shift");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Viewer", "Operator", "Administrator", "night-shift"]);
  });

  it("the skeleton has three columns for users.view alone, and four for users.edit", async () => {
    for (const [permissions, columns] of [[["users.view"], 3], [["users.view", "users.edit"], 4]] as const) {
      mockFetch({
        "GET /api/setup": { body: { needed: false } },
        "GET /api/me": { body: userFor("custom", { permissions: [...permissions] }) },
        "GET /api/users": { body: rows() },
      });
      const held = holdFetch((_method, path) => path === "/api/users");
      const view = renderWithProviders(<UsersTab onDeleted={() => {}} />, { route: "/users", path: "/users" });
      await waitFor(() => expect(document.querySelectorAll(".sk-table thead th")).toHaveLength(columns));
      held.release();
      await screen.findByText("ops", { selector: "td" });
      view.unmount();
    }
  });

  it("the Create user form still offers the built-in roles", async () => {
    await show(["users.edit"]);
    const role = screen.getByLabelText("Role", { selector: "select:not([aria-label])" });
    expect(within(role).getAllByRole("option").map((o) => o.textContent)).toEqual(["Viewer", "Operator", "Administrator"]);
  });

  it("writes the built-in roles the way the Roles tab does, but the options keep the role names as their values", async () => {
    await show(["users.edit"]);
    const form = screen.getByLabelText("Role", { selector: "select:not([aria-label])" });
    const ops = within(screen.getByText("ops", { selector: "td.cell-user" }).closest("tr")!).getByRole("combobox", { name: "Role for ops" });
    for (const select of [form, ops]) {
      expect(within(select).getAllByRole("option").slice(0, 3).map((o) => (o as HTMLOptionElement).value)).toEqual(["viewer", "operator", "admin"]);
    }
    expect(ops).toHaveValue("operator");
    expect(ops).toHaveDisplayValue("Operator");
  });
});

describe("UsersTab offers the roles the server says this person may hand out (GET /api/roles)", () => {
  /** What GET /api/roles answers: `names` are the roles the caller may hand out; the others are listed but not assignable. */
  const role = (id: number, name: string, assignable: boolean, builtin = false) =>
    ({ id, name, description: "", builtin, user_count: 0, assignable, permissions: null });
  const rows = (): Row[] => [
    { id: 1, username: "admin", role: "admin", active: true },
    { id: 2, username: "ops", role: "operator", active: true },
    { id: 9, username: "pm", role: "People manager", active: true },
    { id: 10, username: "nobody", role: "Nothing", active: true },
    { id: 11, username: "auditor", role: "Auditor", active: true, blocked: true },
  ];
  /** The list the server answers in id order: the built-ins first, then custom roles in the order they were made (not alphabetical). */
  const roles = (assignable: (name: string) => boolean) =>
    ["viewer", "operator", "admin"].map((n, i) => role(i + 1, n, assignable(n), true))
      .concat(["Nothing", "People manager", "Auditor"].map((n, i) => role(4 + i, n, assignable(n))));
  const rowOf = (name: string) => screen.getByText(name, { selector: "td.cell-user" }).closest("tr")!;
  const optionsOf = (select: HTMLElement) => within(select).getAllByRole("option").map((o) => o.textContent);

  /** Signed in as user 9 ("People manager": users.view, users.edit, assets.view) or as the built-in admin; the list and the roles are there when this returns. */
  async function show(who: "people-manager" | "admin", answer: { status?: number; body?: unknown } = {}) {
    const people = who === "people-manager";
    const calls = mockFetch({
      "GET /api/setup": { body: { needed: false } },
      "GET /api/me": {
        body: people
          ? userFor("People manager", { id: 9, username: "pm", permissions: ["users.view", "users.edit", "assets.view"] })
          : userFor("admin", { id: 1, username: "admin" }),
      },
      "GET /api/users": { body: rows() },
      "GET /api/roles": answer.status || answer.body ? answer : { body: roles((n) => (people ? ["Nothing", "People manager"].includes(n) : true)) },
      "POST /api/users": ({ body }) => ({ status: 201, body: { id: 12, active: true, ...(body as object) } }),
    });
    renderWithProviders(<><UsersTab onDeleted={() => {}} /><SignedIn /></>, { route: "/users", path: "/users" });
    await screen.findByText("ops", { selector: "td" });
    await accountKnown();
    await waitFor(() => expect(calls.some((c) => c.path === "/api/roles")).toBe(true));
    return calls;
  }

  it("a People manager sees the Admin, Operator and Auditor rows read-only: the role as text, no select, no menu, no trash can", async () => {
    await show("people-manager");
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Role for admin" })).not.toBeInTheDocument());
    for (const [name, text] of [["admin", "Administrator"], ["ops", "Operator"], ["auditor", "Auditor"]]) {
      const row = rowOf(name);
      expect(within(row).getAllByRole("cell")[1].textContent).toBe(text); // the role cell: plain text
      expect(within(row).queryByRole("combobox")).not.toBeInTheDocument();
      expect(within(row).queryByRole("button", { name: `Actions for ${name}` })).not.toBeInTheDocument();
      expect(within(row).queryByRole("button", { name: `Delete ${name}` })).not.toBeInTheDocument();
    }
    expect(within(rowOf("auditor")).getByText("blocked")).toBeInTheDocument(); // the state is still shown
    expect(within(rowOf("admin")).getAllByRole("cell")[1]).toHaveAttribute("title", "This account has a role with more access than yours, so you cannot change it.");
    expect(within(rowOf("nobody")).getAllByRole("cell")[1]).not.toHaveAttribute("title");
  });

  it("the rows whose role may be handed out keep their controls, and the role select lists only those roles", async () => {
    await show("people-manager");
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Role for admin" })).not.toBeInTheDocument());
    const nobody = rowOf("nobody");
    const select = within(nobody).getByRole("combobox", { name: "Role for nobody" });
    expect(select).toBeEnabled();
    expect(optionsOf(select)).toEqual(["Nothing", "People manager"]);
    expect(within(nobody).getByRole("button", { name: "Actions for nobody" })).toBeInTheDocument();
    expect(within(nobody).getByRole("button", { name: "Delete nobody" })).toBeEnabled();
    // Your own row: People manager is assignable, so the select is there; it is disabled because it is your own.
    const own = within(rowOf("pm")).getByRole("combobox", { name: "Role for pm" });
    expect(own).toBeDisabled();
    expect(own).toHaveValue("People manager");
    expect(within(rowOf("pm")).getByRole("button", { name: "Delete pm" })).toBeDisabled();
  });

  it("the Create user form lists only the roles that may be handed out, and sends the first one when none was picked", async () => {
    const calls = await show("people-manager");
    const role = screen.getByLabelText("Role", { selector: "select:not([aria-label])" });
    await waitFor(() => expect(optionsOf(role)).toEqual(["Nothing", "People manager"]));
    await userEvent.type(screen.getByLabelText("Username"), "fresh");
    await userEvent.type(screen.getByLabelText("Password"), "longenough");
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ username: "fresh", password: "longenough", role: "Nothing" });
  });

  it("an Admin is offered every role: the built-ins in their order, then the others by name, and every row is editable", async () => {
    await show("admin");
    const role = screen.getByLabelText("Role", { selector: "select:not([aria-label])" });
    await waitFor(() => expect(optionsOf(role)).toEqual(["Viewer", "Operator", "Administrator", "Auditor", "Nothing", "People manager"]));
    expect(optionsOf(within(rowOf("ops")).getByRole("combobox"))).toEqual(["Viewer", "Operator", "Administrator", "Auditor", "Nothing", "People manager"]);
    for (const name of ["ops", "pm", "nobody", "auditor"]) {
      expect(within(rowOf(name)).getByRole("combobox")).toBeEnabled();
      expect(within(rowOf(name)).getByRole("button", { name: `Delete ${name}` })).toBeEnabled();
    }
    // Nothing changes for the built-in roles: the form still starts on viewer.
    expect(role).toHaveValue("viewer");
  });

  it("while the roles are not known (still loading, or the answer failed) the page is what it was: the three built-in names and every row editable", async () => {
    // The roles answer is a 500 here; the same fallback covers the time before it arrives.
    mockFetch({
      "GET /api/setup": { body: { needed: false } },
      "GET /api/me": { body: userFor("admin", { id: 1, username: "admin" }) },
      "GET /api/users": { body: rows() },
      "GET /api/roles": { status: 500, body: { detail: "roles are down" } },
    });
    renderWithProviders(<UsersTab onDeleted={() => {}} />, { route: "/users", path: "/users" });
    await screen.findByText("ops", { selector: "td" });
    const role = screen.getByLabelText("Role", { selector: "select:not([aria-label])" });
    expect(optionsOf(role)).toEqual(["Viewer", "Operator", "Administrator"]);
    expect(optionsOf(within(rowOf("ops")).getByRole("combobox"))).toEqual(["Viewer", "Operator", "Administrator"]);
    expect(within(rowOf("auditor")).getByRole("combobox")).toBeEnabled();
    expect(screen.queryByText("roles are down")).not.toBeInTheDocument();
  });
});

describe("UsersTab shows what a role is for, and speaks in sentences (W9b)", () => {
  type RoleFixture = { id: number; name: string; description: string; builtin: boolean; user_count: number; assignable: boolean; permissions: null };
  const role = (id: number, name: string, description: string, builtin = false): RoleFixture =>
    ({ id, name, description, builtin, user_count: 0, assignable: true, permissions: null });
  const rolesFixture = (): RoleFixture[] => [
    role(1, "viewer", "Can look, not change.", true),
    role(2, "operator", "", true), // no description: nothing is shown for it
    role(3, "admin", "Everything, including roles.", true),
    role(4, "Night shift", "Runs the floor at night."),
  ];
  const rowOf = (name: string) => screen.getByText(name, { selector: "td.cell-user" }).closest("tr")!;
  const createRole = () => screen.getByLabelText("Role", { selector: "select:not([aria-label])" });

  /** Signed in as the built-in admin. `list` and `users` are mutable so a test can change what the server answers next. */
  function show(extra: Parameters<typeof mockFetch>[0] = {}, list = rolesFixture()) {
    const users: Row[] = [
      { id: 1, username: "admin", role: "admin", active: true },
      { id: 2, username: "ops", role: "operator", active: true },
      { id: 3, username: "night", role: "Night shift", active: true },
    ];
    const calls = mockFetch({
      "GET /api/setup": { body: { needed: false } },
      "GET /api/me": { body: userFor("admin", { id: 1, username: "admin" }) },
      "GET /api/users": () => ({ body: users }),
      "GET /api/roles": () => ({ body: list }),
      ...extra,
    });
    return { calls, users, list };
  }

  it("the Create user form shows the chosen role's description under the select, and the select points at it", async () => {
    show();
    renderWithProviders(<UsersTab onDeleted={() => {}} />, { route: "/users", path: "/users" });
    await screen.findByText("ops", { selector: "td" });
    await waitFor(() => expect(createRole()).toHaveAttribute("aria-describedby"));
    // The form starts on viewer.
    const note = screen.getByText("Can look, not change.");
    expect(createRole()).toHaveAttribute("aria-describedby", note.id);
    expect(note).toHaveClass("muted");
    expect(createRole()).toHaveAccessibleDescription("Can look, not change.");
    // The note is beside the label, not in it: the select keeps the name "Role".
    expect(screen.getByLabelText("Role", { selector: "select:not([aria-label])" })).toBe(createRole());
    expect(note).toHaveClass("role-note");
    expect(note.closest("label")).toBeNull();

    await userEvent.selectOptions(createRole(), "Night shift");
    expect(screen.getByText("Runs the floor at night.")).toBeInTheDocument();
    expect(screen.queryByText("Can look, not change.")).not.toBeInTheDocument();

    await userEvent.selectOptions(createRole(), "operator"); // a role without a description: no line and no pointer
    expect(screen.queryByText("Runs the floor at night.")).not.toBeInTheDocument();
    expect(createRole()).not.toHaveAttribute("aria-describedby");
    expect(document.querySelector(".role-note")).toBeNull();
  });

  it("a row's role cell carries the role's description as its title (none for a role without one)", async () => {
    show();
    renderWithProviders(<UsersTab onDeleted={() => {}} />, { route: "/users", path: "/users" });
    await screen.findByText("ops", { selector: "td" });
    await waitFor(() => expect(within(rowOf("night")).getAllByRole("cell")[1]).toHaveAttribute("title", "Runs the floor at night."));
    expect(within(rowOf("admin")).getAllByRole("cell")[1]).toHaveAttribute("title", "Everything, including roles.");
    expect(within(rowOf("ops")).getAllByRole("cell")[1]).not.toHaveAttribute("title");
  });

  it("a read-only row keeps its own explanation as the title, not the description", async () => {
    const list = rolesFixture().map((r) => (r.name === "Night shift" ? { ...r, assignable: false } : r));
    show({}, list);
    renderWithProviders(<UsersTab onDeleted={() => {}} />, { route: "/users", path: "/users" });
    await screen.findByText("ops", { selector: "td" });
    await waitFor(() => expect(within(rowOf("night")).getAllByRole("cell")[1]).toHaveAttribute("title", "This account has a role with more access than yours, so you cannot change it."));
  });

  it("a refused role change (the last administrator) reads as a sentence on the row", async () => {
    show({ "PATCH /api/users/2": { status: 409, body: { detail: "cannot remove the last active administrator" } } });
    renderWithProviders(<UsersTab onDeleted={() => {}} />, { route: "/users", path: "/users" });
    await screen.findByText("ops", { selector: "td" });
    await userEvent.selectOptions(within(rowOf("ops")).getByRole("combobox"), "viewer");
    expect(await within(rowOf("ops")).findByRole("alert")).toHaveTextContent("Cannot remove the last active administrator.");
  });

  it("a role the server will not let this person hand out reads as a sentence, in the Create form too", async () => {
    show({ "POST /api/users": { status: 403, body: { detail: "cannot give a role with more access than yours" } } });
    renderWithProviders(<UsersTab onDeleted={() => {}} />, { route: "/users", path: "/users" });
    await screen.findByText("ops", { selector: "td" });
    await userEvent.type(screen.getByLabelText("Username"), "fresh");
    await userEvent.type(screen.getByLabelText("Password"), "longenough");
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot give a role with more access than yours.");
  });

  it("a message that is already a sentence is left alone (no second full stop)", async () => {
    show({ "PATCH /api/users/2": { status: 422, body: { detail: "Password is too short." } } });
    renderWithProviders(<UsersTab onDeleted={() => {}} />, { route: "/users", path: "/users" });
    await screen.findByText("ops", { selector: "td" });
    await userEvent.click(within(await openMenu(rowOf("ops"), "ops")).getByRole("menuitem", { name: "Deactivate" }));
    expect((await within(rowOf("ops")).findByRole("alert")).textContent?.trim()).toBe("Password is too short.");
  });

  it("renaming a role moves the new name into the rows and the selects (the roles and the users are read again)", async () => {
    const { users, list } = show({
      "PATCH /api/roles/4": ({ body }) => {
        const name = (body as { name: string }).name;
        list[3].name = name;
        users[2].role = name; // the server renames the role the account holds along with it
        return { body: list[3] };
      },
    });
    function Rename() {
      const patch = usePatchRole();
      return <button type="button" onClick={() => patch.mutate({ id: 4, body: { name: "Late shift" } })}>Rename role</button>;
    }
    renderWithProviders(<><Rename /><UsersTab onDeleted={() => {}} /></>, { route: "/users", path: "/users" });
    await screen.findByText("ops", { selector: "td" });
    await waitFor(() => expect(within(rowOf("night")).getByRole("combobox")).toHaveValue("Night shift"));
    expect(within(createRole()).getAllByRole("option").map((o) => o.textContent)).toContain("Night shift");

    await userEvent.click(screen.getByRole("button", { name: "Rename role" }));

    await waitFor(() => expect(within(rowOf("night")).getByRole("combobox")).toHaveValue("Late shift"));
    expect(within(createRole()).getAllByRole("option").map((o) => o.textContent)).toContain("Late shift");
    expect(within(createRole()).getAllByRole("option").map((o) => o.textContent)).not.toContain("Night shift");
    expect(within(within(rowOf("night")).getByRole("combobox")).getAllByRole("option").map((o) => o.textContent)).toContain("Late shift");
  });
});
