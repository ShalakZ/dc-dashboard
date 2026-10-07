import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { UsersPage } from "./UsersPage";

type Row = { id: number; username: string; role: string; active: boolean };

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
