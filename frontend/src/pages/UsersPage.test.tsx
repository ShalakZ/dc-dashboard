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

describe("UsersPage", () => {
  it("disables deactivate and role on own row", async () => {
    mockFetch(routes());
    renderWithProviders(<UsersPage />, { route: "/users", path: "/users" });
    const ownRow = (await screen.findByText("admin", { selector: "td" })).closest("tr")!;
    expect(within(ownRow).getByRole("combobox")).toBeDisabled();
    expect(within(ownRow).getByRole("button", { name: "Deactivate" })).toBeDisabled();
    const opsRow = screen.getByText("ops", { selector: "td" }).closest("tr")!;
    expect(within(opsRow).getByRole("button", { name: "Deactivate" })).toBeEnabled();
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
    await userEvent.click(within(opsRow).getByRole("button", { name: "Deactivate" }));
    expect(await within(opsRow).findByRole("button", { name: "Activate" })).toBeInTheDocument();
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

  it("marks a blocked account next to its status and offers Unblock only there", async () => {
    open();
    await screen.findByText("ops", { selector: "td" });
    expect(within(rowOf("locked")).getByText("blocked")).toBeInTheDocument();
    expect(within(rowOf("locked")).getByRole("button", { name: "Unblock locked" })).toBeEnabled();
    expect(within(rowOf("ops")).queryByText("blocked")).not.toBeInTheDocument();
    expect(within(rowOf("ops")).queryByRole("button", { name: /^Unblock/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Unblock/ })).toHaveLength(1);
  });

  it("Unblock calls the route, then the mark and the button go away", async () => {
    const { calls } = open();
    await screen.findByText("locked", { selector: "td" });
    await userEvent.click(within(rowOf("locked")).getByRole("button", { name: "Unblock locked" }));
    await waitFor(() => expect(within(rowOf("locked")).queryByText("blocked")).not.toBeInTheDocument());
    expect(within(rowOf("locked")).queryByRole("button", { name: "Unblock locked" })).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/api/users/3/unblock"]);
  });

  it("shows the API's text when Unblock fails", async () => {
    open({ "POST /api/users/3/unblock": { status: 404, body: { detail: "user not found" } } });
    await screen.findByText("locked", { selector: "td" });
    await userEvent.click(within(rowOf("locked")).getByRole("button", { name: "Unblock locked" }));
    expect(await within(rowOf("locked")).findByRole("alert")).toHaveTextContent("user not found");
  });
});
