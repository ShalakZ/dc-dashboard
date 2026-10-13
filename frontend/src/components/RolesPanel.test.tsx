import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RoleRow } from "../api/types";
import { mockFetch, type Routes } from "../test/fetchMock";
import { builtinRoles, catalogue, roleRow } from "../test/permissionFixtures";
import { RolesPanel } from "./RolesPanel";

// jsdom 26 has no PointerEvent; the row menu and the tips need a pointerType to tell a mouse from a touch.
const RealPointerEvent = (globalThis as { PointerEvent?: unknown }).PointerEvent;
beforeAll(() => {
  (globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerType = init.pointerType ?? ""; }
  };
});
afterAll(() => { (globalThis as { PointerEvent?: unknown }).PointerEvent = RealPointerEvent; });

const EXECUTIVE = roleRow({ id: 7, name: "Executive", description: "The board", user_count: 0, permissions: ["assets.view", "dashboards.view", "billing.view", "billing.export"] });
const HELD = roleRow({ id: 8, name: "Night shift", description: "", user_count: 2, permissions: ["assets.view"] });

function show(routes: Routes = {}, list: () => RoleRow[] = () => [...builtinRoles(), EXECUTIVE, HELD]) {
  const calls = mockFetch({
    "GET /api/roles": () => ({ body: list() }),
    "GET /api/permissions": { body: catalogue() },
    "GET /api/users": { body: [] },
    "GET /api/audit/options": { body: {} },
    ...routes,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><RolesPanel /></QueryClientProvider>);
  return calls;
}

const table = () => screen.findByRole("table", { name: "Roles" });
const rowOf = async (name: string) => within(await table()).getByRole("row", { name: new RegExp(name) });
const gets = (calls: { method: string; path: string }[], path: string) => calls.filter((c) => c.method === "GET" && c.path === path).length;
async function chooseFromMenu(rowName: string, item: string) {
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${rowName}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}
const dialog = (name: string) => screen.findByRole("dialog", { name });

describe("RolesPanel: the list", () => {
  it("is a card titled Roles with its purpose, a New role button and a table of roles", async () => {
    show();
    expect(screen.getByRole("heading", { name: "Roles" })).toBeInTheDocument();
    expect(screen.getByText("A role is a set of permissions. Built-in roles are locked: duplicate one to make your own.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New role" })).toBeInTheDocument();
    const grid = await table();
    expect(within(grid).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Description", "Users", "Actions"]);
  });

  it("shows a skeleton while the first answer is on its way", async () => {
    show();
    expect(screen.getByRole("status")).toHaveTextContent("Loading roles");
    await table();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("lists the built-in roles by their written names with a Built in badge, then the custom ones without one, each with its users", async () => {
    show();
    const rows = within(await table()).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(5);
    const cells = (row: HTMLElement) => within(row).getAllByRole("cell").map((c) => c.textContent);
    expect(cells(rows[0]).slice(0, 3)).toEqual(["ViewerBuilt in", "Reads the pages.", "2"]);
    expect(cells(rows[1]).slice(0, 3)).toEqual(["OperatorBuilt in", "Runs the plant.", "1"]);
    expect(cells(rows[2]).slice(0, 3)).toEqual(["AdministratorBuilt in", "Everything.", "1"]);
    expect(cells(rows[3]).slice(0, 3)).toEqual(["Executive", "The board", "0"]);
    expect(cells(rows[4]).slice(0, 3)).toEqual(["Night shift", "", "2"]);
    expect(screen.getAllByText("Built in")).toHaveLength(3);
  });

  it("asks for the permission list once, however often the editor is opened", async () => {
    const calls = show();
    await table();
    await userEvent.click(screen.getByRole("button", { name: "New role" }));
    await userEvent.keyboard("{Escape}");
    await chooseFromMenu("Executive", "Edit");
    await userEvent.keyboard("{Escape}");
    expect(gets(calls, "/api/permissions")).toBe(1);
  });

  it("says why the list did not load, as a sentence", async () => {
    show({ "GET /api/roles": { status: 403, body: { detail: "insufficient permission" } } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow this.");
    expect(screen.queryByRole("table", { name: "Roles" })).toBeNull();
  });
});

describe("RolesPanel: the editor", () => {
  it("opens an empty New role editor", async () => {
    show();
    await table();
    await userEvent.click(screen.getByRole("button", { name: "New role" }));
    expect(await dialog("New role")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.getAllByRole("checkbox").filter((c) => (c as HTMLInputElement).checked)).toEqual([]);
  });

  it("creates a role and the list shows it", async () => {
    let list = [...builtinRoles()];
    const calls = show(
      { "POST /api/roles": ({ body }) => { const made = roleRow({ id: 9, ...(body as object) }); list = [...list, made]; return { status: 201, body: made }; } },
      () => list,
    );
    await table();
    await userEvent.click(screen.getByRole("button", { name: "New role" }));
    await userEvent.type(await screen.findByLabelText("Name"), "Auditor");
    await userEvent.click(screen.getByRole("checkbox", { name: "See the audit log" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await rowOf("Auditor")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Auditor", description: "", permissions: ["audit.view"] });
  });

  it("Edit opens the editor on that role, with its ticks", async () => {
    show();
    await table();
    await chooseFromMenu("Executive", "Edit");
    expect(await dialog("Edit role Executive")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Executive");
    expect(screen.getAllByRole("checkbox").filter((c) => (c as HTMLInputElement).checked)).toHaveLength(4);
  });

  it("renames a role and the list shows the new name", async () => {
    let list = [...builtinRoles(), EXECUTIVE];
    show({ "PATCH /api/roles/7": ({ body }) => { const changed = { ...EXECUTIVE, ...(body as object) }; list = list.map((r) => (r.id === 7 ? changed : r)); return { body: changed }; } }, () => list);
    await table();
    await chooseFromMenu("Executive", "Edit");
    const name = await screen.findByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Board");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await rowOf("Board")).toBeInTheDocument();
    expect(within(await table()).queryByRole("row", { name: /Executive/ })).toBeNull();
  });

  it("View opens a built-in role read-only", async () => {
    show();
    await table();
    await chooseFromMenu("Operator", "View");
    expect(await dialog("Role Operator")).toBeInTheDocument();
    for (const each of screen.getAllByRole("checkbox")) expect(each).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("offers View, not Edit, on a built-in row, and both Edit and Duplicate on a custom one", async () => {
    show();
    await table();
    await userEvent.click(screen.getByRole("button", { name: "Actions for Operator" }));
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["View", "Duplicate"]);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Actions for Executive" }));
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["Edit", "Duplicate"]);
  });

  it("shows each role's own ticks and editability when the editor is opened on one role after another", async () => {
    show();
    await table();
    await chooseFromMenu("Executive", "Edit");
    await dialog("Edit role Executive");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await chooseFromMenu("Night shift", "Edit");
    await dialog("Edit role Night shift");
    expect(screen.getByLabelText("Name")).toHaveValue("Night shift");
    expect(screen.getAllByRole("checkbox").filter((c) => (c as HTMLInputElement).checked).map((c) => c.closest("label")?.textContent)).toEqual(["See the Assets Tree"]);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await chooseFromMenu("Viewer", "View");
    await dialog("Role Viewer");
    expect(screen.getByLabelText("Name")).toHaveAttribute("readonly");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await chooseFromMenu("Executive", "Edit");
    await dialog("Edit role Executive");
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("readonly");
    expect(screen.getByRole("checkbox", { name: "See billing" })).toBeEnabled();
  });
});

describe("RolesPanel: Duplicate", () => {
  const copy = roleRow({ id: 10, name: "Copy of operator", description: "Runs the plant.", permissions: builtinRoles()[1].permissions });

  it("calls the duplicate route and opens the copy in the editor, with the line that the copy already exists", async () => {
    let list = [...builtinRoles()];
    const calls = show({ "POST /api/roles/2/duplicate": () => { list = [...list, copy]; return { status: 201, body: copy }; } }, () => list);
    await table();
    await chooseFromMenu("Operator", "Duplicate");
    expect(await dialog("Edit role Copy of operator")).toBeInTheDocument();
    expect(screen.getByText(/This copy already exists/)).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox").filter((c) => (c as HTMLInputElement).checked)).toHaveLength(10);
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({});
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await rowOf("Copy of operator")).toBeInTheDocument(); // Cancel keeps the copy
  });

  it("View Operator, then Duplicate in the editor: the editor is editable and titled with the copy's name", async () => {
    let list = [...builtinRoles()];
    show({ "POST /api/roles/2/duplicate": () => { list = [...list, copy]; return { status: 201, body: copy }; } }, () => list);
    await table();
    await chooseFromMenu("Operator", "View");
    await dialog("Role Operator");
    await userEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(await dialog("Edit role Copy of operator")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Role Operator" })).toBeNull();
    expect(screen.getByLabelText("Name")).toHaveValue("Copy of operator");
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Change dashboards" })).toBeEnabled();
  });

  it("shows why a Duplicate from the list was refused", async () => {
    show({ "POST /api/roles/3/duplicate": { status: 403, body: { detail: "cannot save a role with more access than yours" } } });
    await table();
    await chooseFromMenu("Administrator", "Duplicate");
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot save a role with more access than yours.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("RolesPanel: Delete", () => {
  it("has a bin only on custom roles, disabled with the reason while an account holds the role", async () => {
    show();
    await table();
    expect(screen.queryByRole("button", { name: /Delete (Viewer|Operator|Administrator|viewer|operator|admin)/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete Executive" })).toBeEnabled();
    const held = screen.getByRole("button", { name: "Delete Night shift" });
    expect(held).toBeDisabled();
    expect(held).toHaveAttribute("title", "In use by 2 account(s). Give them another role first.");
    expect(document.getElementById(held.getAttribute("aria-describedby")!)).toHaveTextContent("In use by 2 account(s). Give them another role first.");
    expect(within(await rowOf("Night shift")).getAllByRole("cell")[2]).toHaveTextContent("2"); // the Users column shows the count
  });

  it("gives a built-in row an invisible bin-sized gap so its menu button lines up with the custom rows' (hidden from the keyboard and screen readers)", async () => {
    show();
    await table();
    const gap = (row: HTMLElement) => row.querySelector<HTMLElement>(".icon-btn-spacer");
    for (const name of ["Viewer", "Operator", "Administrator"]) {
      const spacer = gap(await rowOf(name));
      expect(spacer, name).not.toBeNull();
      expect(spacer).toHaveAttribute("aria-hidden", "true");
      expect(spacer!.tagName).toBe("SPAN"); // not a button: nothing to focus
      expect(spacer).toBeEmptyDOMElement();
    }
    expect(gap(await rowOf("Executive"))).toBeNull(); // a custom row has the real bin
  });

  it("asks first, deletes on confirmation, closes, and puts the focus on New role", async () => {
    let list = [...builtinRoles(), EXECUTIVE];
    const calls = show({ "DELETE /api/roles/7": () => { list = list.filter((r) => r.id !== 7); return { status: 204 }; } }, () => list);
    await table();
    await userEvent.click(screen.getByRole("button", { name: "Delete Executive" }));
    const confirm = await dialog("Delete role Executive?");
    expect(confirm).toHaveTextContent("Accounts can no longer be given this role. This cannot be undone. The change is recorded in the Audit log.");
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete role" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/api/roles/7"]);
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Roles" })).queryByRole("row", { name: /Executive/ })).toBeNull());
    expect(screen.getByRole("button", { name: "New role" })).toHaveFocus();
  });

  it("Cancel deletes nothing", async () => {
    const calls = show();
    await table();
    await userEvent.click(screen.getByRole("button", { name: "Delete Executive" }));
    await userEvent.click(within(await dialog("Delete role Executive?")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("when the role was given to an account meanwhile: shows the server's sentence, keeps the row, and refreshes the list", async () => {
    let list = [...builtinRoles(), EXECUTIVE];
    const calls = show({
      "DELETE /api/roles/7": () => {
        list = list.map((r) => (r.id === 7 ? { ...r, user_count: 1 } : r)); // somebody gave it to an account after the page loaded
        return { status: 409, body: { detail: "role is in use by 1 account(s)" } };
      },
    }, () => list);
    await table();
    await userEvent.click(screen.getByRole("button", { name: "Delete Executive" }));
    const confirm = await dialog("Delete role Executive?");
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete role" }));
    expect(await within(confirm).findByRole("alert")).toHaveTextContent("Role is in use by 1 account(s).");
    expect(screen.getByRole("dialog", { name: "Delete role Executive?" })).toBeInTheDocument();
    await waitFor(() => expect(gets(calls, "/api/roles")).toBe(2));
    await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(await rowOf("Executive")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete Executive" })).toBeDisabled());
  });
});
