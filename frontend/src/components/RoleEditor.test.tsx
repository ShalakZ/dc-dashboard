import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ApiError } from "../api/client";
import { useRoles } from "../api/queries";
import type { PermissionRow, RoleRow } from "../api/types";
import { mockFetch, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { builtinRoles, catalogue, roleRow } from "../test/permissionFixtures";
import { spyToasts } from "../test/toasts";
import { RoleEditor, type EditorMode } from "./RoleEditor";

// jsdom 26 has no PointerEvent; the tip needs a pointerType to tell a mouse from a touch.
const RealPointerEvent = (globalThis as { PointerEvent?: unknown }).PointerEvent;
beforeAll(() => {
  (globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerType = init.pointerType ?? ""; }
  };
});
afterAll(() => { (globalThis as { PointerEvent?: unknown }).PointerEvent = RealPointerEvent; });

/** Stands in for the Roles list: it makes the editor's mutations have a query to refresh. */
function RolesProbe() {
  useRoles();
  return null;
}

const NEW: EditorMode = { kind: "new" };
const editing = (role: RoleRow, justCopied = false): EditorMode => ({ kind: "edit", role, justCopied });

let toasts = spyToasts();
beforeEach(() => { toasts = spyToasts(); });

function open(mode: EditorMode, { routes = {}, permissions = catalogue() }: { routes?: Routes; permissions?: PermissionRow[] } = {}) {
  const calls = mockFetch({ "GET /api/roles": { body: [] }, "GET /api/users": { body: [] }, "GET /api/audit/options": { body: {} }, ...routes });
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const onDuplicate = vi.fn(async (_role: RoleRow) => undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <RolesProbe />
      {toasts.wrap(<RoleEditor mode={mode} roles={[...builtinRoles(), roleRow()]} permissions={permissions} onClose={onClose} onSaved={onSaved} onDuplicate={onDuplicate} />)}
    </QueryClientProvider>,
  );
  return { calls, onClose, onSaved, onDuplicate, ...view };
}

const tick = (label: string) => userEvent.click(screen.getByRole("checkbox", { name: label }));
const box = (label: string) => screen.getByRole("checkbox", { name: label });
const checked = () => screen.getAllByRole("checkbox").filter((c) => (c as HTMLInputElement).checked).map((c) => c.getAttribute("aria-label") ?? c.closest("label")?.textContent ?? "");
const gets = (calls: { method: string; path: string }[], path: string) => calls.filter((c) => c.method === "GET" && c.path === path).length;
const summary = () => screen.getByRole("region", { name: "What this role can do" });
const save = () => screen.getByRole("button", { name: "Save" });
const sentBody = (calls: { method: string; body: unknown }[], method: string) => calls.find((c) => c.method === method)?.body as Record<string, unknown>;
const sorted = (value: unknown) => [...(value as string[])].sort();

describe("RoleEditor: the grid", () => {
  it("is a dialog titled New role with a Name, a Description and the permission grid by area", () => {
    open(NEW);
    expect(screen.getByRole("dialog", { name: "New role" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveAttribute("maxlength", "64");
    expect(screen.getByLabelText("Description")).toHaveAttribute("maxlength", "200");
    const grid = screen.getByRole("table", { name: "Permissions" });
    expect(within(grid).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Area", "See", "Change"]);
    expect(within(grid).getAllByRole("rowheader").map((h) => h.textContent)).toEqual([
      "Assets Tree", "Dashboards", "Billing and tariffs", "Sources and discovery", "Storage and settings", "Audit log", "Users", "Diagnostics",
    ]);
    expect(within(grid).getAllByRole("checkbox")).toHaveLength(21);
    const sensitive = screen.getByRole("group", { name: "Sensitive actions" });
    expect(within(sensitive).getAllByRole("checkbox").map((c) => c.closest("label")?.textContent)).toEqual([
      "Delete assets", "Manage asset kinds", "Choose the default dashboard", "Export billing as CSV", "Run network scans", "Accept scan results", "Change sign-in protection", "Export the audit log",
    ]);
  });

  it("puts each permission in the See or the Change cell of its area, and gives each a tip that is not inside its label", async () => {
    open(NEW);
    const billing = screen.getByRole("row", { name: /Billing and tariffs/ });
    const [see, change] = within(billing).getAllByRole("cell");
    expect(within(see).getAllByRole("checkbox").map((c) => c.closest("label")?.textContent)).toEqual(["See billing", "See tariffs"]);
    expect(within(change).getAllByRole("checkbox").map((c) => c.closest("label")?.textContent)).toEqual(["Change tariffs"]);
    const label = box("Change tariffs").closest("label")!;
    expect(label.querySelector("button")).toBeNull();
    const tip = within(label.parentElement!).getByRole("button", { name: "What does this mean?" });
    await userEvent.click(tip);
    expect(screen.getByRole("note")).toHaveTextContent("About tariffs.edit.");
  });

  it("shows the locked roles.manage line with no checkbox, and no Roles row", () => {
    open(NEW);
    expect(screen.getByText("Managing roles is held by the Administrator role only.")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Manage roles" })).toBeNull();
    expect(screen.queryByRole("rowheader", { name: "Roles" })).toBeNull();
  });

  it("starts empty: nothing ticked, and the summary says so", () => {
    open(NEW);
    expect(checked()).toEqual([]);
    expect(summary()).toHaveTextContent("Opens: no pages.");
    expect(summary()).toHaveTextContent("Can change: nothing.");
    expect(summary()).toHaveTextContent("Sensitive: nothing.");
    expect(save()).toBeDisabled(); // no name yet
  });
});

describe("RoleEditor: saving a new role", () => {
  it("posts the name, the description and exactly the ticked ids (the Executive), then reports and closes", async () => {
    const { calls, onSaved, onClose } = open(NEW, { routes: { "POST /api/roles": { status: 201, body: roleRow({ id: 9, name: "Executive" }) } } });
    await userEvent.type(screen.getByLabelText("Name"), "Executive");
    await userEvent.type(screen.getByLabelText("Description"), "The board");
    for (const label of ["See the Assets Tree", "See dashboards", "See billing", "Export billing as CSV"]) await tick(label);
    expect(within(summary()).getByText("Opens: Assets Tree, Dashboards, Billing.")).toBeInTheDocument();
    expect(within(summary()).getByText("Can change: nothing.")).toBeInTheDocument();
    expect(within(summary()).getByText("Sensitive: Export billing as CSV.")).toBeInTheDocument();
    await userEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const body = sentBody(calls, "POST");
    expect(body.name).toBe("Executive");
    expect(body.description).toBe("The board");
    expect(sorted(body.permissions)).toEqual(["assets.view", "billing.export", "billing.view", "dashboards.view"]);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }));
    expect(toasts.calls).toEqual([{ kind: "success", text: "Role created" }]);
  });

  it("saves a role with no permissions at all: the summary says no pages", async () => {
    const { calls, onClose } = open(NEW, { routes: { "POST /api/roles": { status: 201, body: roleRow({ id: 9, name: "Nobody", permissions: [] }) } } });
    await userEvent.type(screen.getByLabelText("Name"), "Nobody");
    expect(summary()).toHaveTextContent("Opens: no pages.");
    await userEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sentBody(calls, "POST")).toEqual({ name: "Nobody", description: "", permissions: [] });
  });

  it("does not offer Save for a name that is only spaces, and sends the name without the spaces round it", async () => {
    const { calls, onClose } = open(NEW, { routes: { "POST /api/roles": { status: 201, body: roleRow({ id: 9 }) } } });
    await userEvent.type(screen.getByLabelText("Name"), "   ");
    expect(save()).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Name"), "Board  ");
    expect(save()).toBeEnabled();
    await userEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sentBody(calls, "POST").name).toBe("Board");
  });

  it("Start from replaces the ticks with the built-in role's set, and says so; it is only there for a new role", async () => {
    open(NEW);
    expect(screen.getByText("Choosing one replaces the ticks below.")).toBeInTheDocument();
    const select = screen.getByLabelText("Start from");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Nothing", "Viewer", "Operator"]);
    await tick("Delete assets");
    await userEvent.selectOptions(select, "Operator");
    expect(checked()).toHaveLength(10);
    expect(box("Change dashboards")).toBeChecked();
    expect(box("Delete assets")).not.toBeChecked();
    await userEvent.selectOptions(select, "Viewer");
    expect(checked()).toHaveLength(4);
    await userEvent.selectOptions(select, "Nothing");
    expect(checked()).toEqual([]);
  });

  it("starts from Operator and saves with one more box ticked", async () => {
    const { calls, onClose } = open(NEW, { routes: { "POST /api/roles": { status: 201, body: roleRow({ id: 9 }) } } });
    await userEvent.type(screen.getByLabelText("Name"), "Lead");
    await userEvent.selectOptions(screen.getByLabelText("Start from"), "Operator");
    await tick("See the audit log");
    await userEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sorted(sentBody(calls, "POST").permissions)).toEqual(
      ["assets.view", "audit.view", "billing.export", "billing.view", "dashboards.edit", "dashboards.view", "diagnostics.run", "discovery.view", "sources.test", "sources.view", "tariffs.view"],
    );
  });

  it("sends one request when Save is pressed twice before the screen has caught up", async () => {
    const { calls, onClose } = open(NEW, { routes: { "POST /api/roles": { status: 201, body: roleRow({ id: 9 }) } } });
    await userEvent.type(screen.getByLabelText("Name"), "Once");
    const form = save().closest("form")!;
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("disables Save and ignores Escape while the request is in flight", async () => {
    const { onClose } = open(NEW, { routes: { "POST /api/roles": { status: 201, body: roleRow({ id: 9 }) } } });
    const gate = holdFetch((method) => method === "POST");
    await userEvent.type(screen.getByLabelText("Name"), "Slow");
    await userEvent.click(save());
    expect(save()).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { gate.release(); });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe("RoleEditor: what the server refuses", () => {
  it("keeps the dialog, the typed name and the ticks on a 409, and says it as a sentence", async () => {
    const { onClose, onSaved } = open(NEW, { routes: { "POST /api/roles": { status: 409, body: { detail: "a role with that name already exists" } } } });
    await userEvent.type(screen.getByLabelText("Name"), "Executive");
    await userEvent.type(screen.getByLabelText("Description"), "Board");
    await tick("See billing");
    await userEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("A role with that name already exists.");
    expect(screen.getByRole("dialog", { name: "New role" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Executive");
    expect(screen.getByLabelText("Description")).toHaveValue("Board");
    expect(box("See billing")).toBeChecked();
    expect(save()).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(toasts.calls).toEqual([]);
  });

  it("shows a built-in role's name being refused, and a 422 validation text, the same way", async () => {
    let reply = { status: 409, body: { detail: "that name belongs to a built-in role" } };
    open(NEW, { routes: { "POST /api/roles": () => reply } });
    await userEvent.type(screen.getByLabelText("Name"), "Viewer");
    await userEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("That name belongs to a built-in role.");
    reply = { status: 422, body: { detail: "a role name has at most 64 characters" } };
    await userEvent.click(save());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("A role name has at most 64 characters."));
    expect(screen.getByLabelText("Name")).toHaveValue("Viewer");
  });

  it("says Role not found. when the role was deleted in another tab, and refreshes the list", async () => {
    const { calls, onClose } = open(editing(roleRow({ id: 7, name: "Gone" })), { routes: { "PATCH /api/roles/7": { status: 404, body: { detail: "Role not found." } } } });
    await waitFor(() => expect(gets(calls, "/api/roles")).toBe(1));
    await tick("See billing");
    await userEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("Role not found.");
    expect(screen.getByRole("dialog", { name: "Edit role Gone" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(gets(calls, "/api/roles")).toBe(2));
  });

  it("shows the server's sentence for a role above the caller's own access (403)", async () => {
    open(NEW, { routes: { "POST /api/roles": { status: 403, body: { detail: "cannot save a role with more access than yours" } } } });
    await userEvent.type(screen.getByLabelText("Name"), "Big");
    await userEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot save a role with more access than yours.");
  });
});

describe("RoleEditor: editing a custom role", () => {
  const executive = roleRow({ id: 7, name: "Executive", description: "The board", permissions: ["assets.view", "dashboards.view"] });

  it("is titled Edit role <name>, starts from the role's own ticks and has no Start from", () => {
    open(editing(executive));
    expect(screen.getByRole("dialog", { name: "Edit role Executive" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Executive");
    expect(screen.getByLabelText("Description")).toHaveValue("The board");
    expect(checked().sort()).toEqual(["See dashboards", "See the Assets Tree"]);
    expect(screen.queryByLabelText("Start from")).toBeNull();
    expect(summary()).toHaveTextContent("Opens: Assets Tree, Dashboards.");
  });

  it("sends only what changed: a new description alone", async () => {
    const { calls, onClose } = open(editing(executive), { routes: { "PATCH /api/roles/7": { body: executive } } });
    const description = screen.getByLabelText("Description");
    await userEvent.clear(description);
    await userEvent.type(description, "Everyone upstairs");
    await userEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sentBody(calls, "PATCH")).toEqual({ description: "Everyone upstairs" });
  });

  it("sends only the permissions when only a box changed", async () => {
    const { calls, onClose } = open(editing(executive), { routes: { "PATCH /api/roles/7": { body: executive } } });
    await tick("See billing");
    await userEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const body = sentBody(calls, "PATCH");
    expect(Object.keys(body)).toEqual(["permissions"]);
    expect(sorted(body.permissions)).toEqual(["assets.view", "billing.view", "dashboards.view"]);
  });

  it("closes without a request when nothing changed", async () => {
    const { calls, onClose } = open(editing(executive));
    await userEvent.click(save());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
  });

  it("renames, and keeps the role's other ticks", async () => {
    const { calls, onClose } = open(editing(executive), { routes: { "PATCH /api/roles/7": { body: executive } } });
    const name = screen.getByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Board");
    await userEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sentBody(calls, "PATCH")).toEqual({ name: "Board" });
    expect(toasts.calls).toEqual([]); // an edit closes its dialog: no toast
  });

  it("shows the line about a copy that already exists, only for a fresh copy", () => {
    const { unmount } = open(editing(executive, true));
    expect(screen.getByText("This copy already exists. Cancel keeps it; delete it from the list if you do not want it.")).toBeInTheDocument();
    unmount();
    open(editing(executive));
    expect(screen.queryByText(/This copy already exists/)).toBeNull();
  });
});

describe("RoleEditor: a built-in role is read-only", () => {
  const operator = () => builtinRoles()[1];

  it("is titled Role <name>, written out, with every control locked and the Operator's boxes ticked", () => {
    open(editing(operator()));
    expect(screen.getByRole("dialog", { name: "Role Operator" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Description")).toHaveAttribute("readonly");
    expect(screen.getAllByRole("checkbox")).toHaveLength(29);
    for (const each of screen.getAllByRole("checkbox")) expect(each).toBeDisabled();
    expect(checked()).toHaveLength(10);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText("Built-in roles cannot be changed. Duplicate it to make your own.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Start from")).toBeNull();
  });

  it("calls onDuplicate with the role, and Close closes", async () => {
    const { onDuplicate, onClose } = open(editing(operator()));
    await userEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(onDuplicate).toHaveBeenCalledWith(expect.objectContaining({ id: 2, name: "operator" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows why a Duplicate failed and stays open", async () => {
    const { onDuplicate, onClose } = open(editing(operator()));
    onDuplicate.mockRejectedValueOnce(new ApiError(403, "cannot save a role with more access than yours"));
    await userEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot save a role with more access than yours.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the built-in Administrator with Manage roles ticked and locked, and 'Administrator' as its name", () => {
    open(editing(builtinRoles()[2]));
    expect(screen.getByRole("dialog", { name: "Role Administrator" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Administrator");
    expect(box("Manage roles")).toBeChecked();
    expect(box("Manage roles")).toBeDisabled();
    expect(screen.getAllByRole("checkbox")).toHaveLength(30);
    expect(checked()).toHaveLength(30);
  });
});

describe("RoleEditor: hints about what a Change needs", () => {
  it("names the See that is missing, in words, and takes the line away when it is ticked", async () => {
    open(NEW);
    await tick("Change assets");
    expect(within(summary()).getByText("Change assets also needs See the Assets Tree to show anything.")).toBeInTheDocument();
    await tick("See the Assets Tree");
    expect(within(summary()).queryByText(/also needs/)).toBeNull();
  });

  it("says that Change dashboards also needs the assets and the graph, even with See dashboards", async () => {
    open(NEW);
    await tick("See dashboards");
    await tick("Change dashboards");
    expect(within(summary()).getByText("Change dashboards also needs See the Assets Tree and See scans and the graph to show anything.")).toBeInTheDocument();
    await tick("See scans and the graph");
    expect(within(summary()).getByText("Change dashboards also needs See the Assets Tree to show anything.")).toBeInTheDocument();
  });

  it("writes one line per gap, in a plain list", async () => {
    open(NEW);
    await tick("Change assets");
    await tick("Export the audit log");
    expect(within(summary()).getAllByRole("listitem")).toHaveLength(2);
    expect(summary().querySelector("[aria-live]")).toBeNull();
  });
});

describe("RoleEditor: an id this build does not know", () => {
  const extra: PermissionRow = { id: "zzz.new", area: "Reports", kind: "change", label: "Do the new thing", description: "Something a newer server added." };

  it("is rendered from the API row, stays ticked on save and is ignored by the pages in the summary", async () => {
    const role = roleRow({ id: 7, name: "Futurist", permissions: ["assets.view", "zzz.new"] });
    const { calls, onClose } = open(editing(role), { permissions: [...catalogue(), extra], routes: { "PATCH /api/roles/7": { body: role } } });
    expect(screen.getByRole("rowheader", { name: "Reports" })).toBeInTheDocument();
    expect(box("Do the new thing")).toBeChecked();
    expect(summary()).toHaveTextContent("Opens: Assets Tree.");
    expect(summary()).toHaveTextContent("Can change: Do the new thing.");
    await tick("See dashboards");
    await userEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sentBody(calls, "PATCH").permissions).toEqual(["assets.view", "dashboards.view", "zzz.new"]);
  });
});

describe("RoleEditor: the keyboard", () => {
  function Host() {
    const [shown, setShown] = useState(false);
    return (
      <>
        <button onClick={() => setShown(true)}>New role</button>
        {shown && <RoleEditor mode={NEW} roles={builtinRoles()} permissions={catalogue()} onClose={() => setShown(false)} />}
      </>
    );
  }
  const openHost = async () => {
    mockFetch({});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><Host /></QueryClientProvider>);
    await userEvent.click(screen.getByRole("button", { name: "New role" }));
  };

  it("Escape closes the editor and the focus is back on the button that opened it", async () => {
    await openHost();
    expect(screen.getByLabelText("Name")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "New role" })).toHaveFocus();
  });

  it("Escape with a tip open closes the tip only; a second Escape closes the editor", async () => {
    await openHost();
    await userEvent.click(screen.getAllByRole("button", { name: "What does this mean?" })[0]);
    expect(screen.getByRole("note")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByRole("dialog", { name: "New role" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Tab reaches every checkbox and Space ticks the one it is on", async () => {
    await openHost();
    const reached = new Set<Element>();
    let first: HTMLElement | null = null;
    for (let step = 0; step < 150; step++) {
      await userEvent.tab();
      const at = document.activeElement as HTMLElement;
      if (at.getAttribute("type") === "checkbox") { reached.add(at); first ??= at; }
      if (at === screen.getByRole("button", { name: "Save" })) break;
    }
    expect(reached.size).toBe(29);
    first!.focus();
    expect(first).not.toBeChecked();
    await userEvent.keyboard(" ");
    expect(first).toBeChecked();
  });
});

describe("RoleEditor: offering what a permission needs", () => {
  const USERS_NEED = "Change users also needs See users to show anything.";
  const UNTICK_USERS = "Change users needs See users to show anything. Also untick Change users?";
  // Not a bare getByRole("group"): fieldset.role-sensitive is a group too. Every sentence the prompt can say contains "to show anything".
  const cards = () => screen.queryAllByRole("group", { name: /to show anything/ });
  const button = (name: string) => screen.getByRole("button", { name });
  const cardOf = (name: string) => screen.getByRole("group", { name });
  const hints = () => within(summary()).queryAllByRole("listitem").map((li) => li.textContent);

  it("opens a group right after the box that was ticked, names it with its sentence, focuses the primary button and keeps the hint line", async () => {
    open(NEW);
    await tick("Change users");
    const group = cardOf(USERS_NEED);
    expect(box("Change users").closest("label")!.nextElementSibling).toBe(group);
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Also tick See users", "Not now"]);
    expect(within(group).getByRole("button", { name: "Also tick See users" })).toHaveFocus();
    expect(hints()).toEqual([USERS_NEED]);
  });

  it("Also tick ticks both, closes the group, puts the focus back on the box, takes the hint away and saves exactly both", async () => {
    const { calls, onClose } = open(NEW, { routes: { "POST /api/roles": { status: 201, body: roleRow({ id: 9 }) } } });
    await userEvent.type(screen.getByLabelText("Name"), "Staff");
    await tick("Change users");
    await userEvent.click(button("Also tick See users"));
    expect(cards()).toEqual([]);
    expect(box("Change users")).toBeChecked();
    expect(box("See users")).toBeChecked();
    expect(box("Change users")).toHaveFocus();
    expect(hints()).toEqual([]);
    await userEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sorted(sentBody(calls, "POST").permissions)).toEqual(["users.edit", "users.view"]);
  });

  it("Not now keeps only the box that was ticked, hands the focus back and leaves the hint; it asks again only after an untick and a tick", async () => {
    open(NEW);
    await tick("Change users");
    await userEvent.click(button("Not now"));
    expect(cards()).toEqual([]);
    expect(checked()).toEqual(["Change users"]);
    expect(box("Change users")).toHaveFocus();
    expect(hints()).toEqual([USERS_NEED]);
    await tick("See the audit log"); // nothing to offer, and no memory of the earlier offer either
    expect(cards()).toEqual([]);
    await tick("Change users"); // unticked: nobody needs it, nothing opens
    expect(cards()).toEqual([]);
    await tick("Change users");
    expect(cardOf(USERS_NEED)).toBeInTheDocument();
  });

  it("lists several needs and one click ticks them all", async () => {
    open(NEW);
    await tick("See dashboards");
    await tick("Change dashboards");
    const group = cardOf("Change dashboards also needs these to show anything:");
    expect(within(group).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["See the Assets Tree", "See scans and the graph"]);
    await userEvent.click(within(group).getByRole("button", { name: "Also tick 2 permissions" }));
    expect(cards()).toEqual([]);
    expect(checked().sort()).toEqual(["Change dashboards", "See dashboards", "See scans and the graph", "See the Assets Tree"]);
    expect(hints()).toEqual([]);
  });

  it("offers Change assets and See the Assets Tree when Manage asset kinds is ticked alone, and one click ticks both", async () => {
    open(NEW);
    await tick("Manage asset kinds");
    const group = cardOf("Manage asset kinds also needs these to show anything:");
    expect(within(group).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Change assets", "See the Assets Tree"]);
    await userEvent.click(within(group).getByRole("button", { name: "Also tick 2 permissions" }));
    expect(cards()).toEqual([]);
    expect(checked().sort()).toEqual(["Change assets", "Manage asset kinds", "See the Assets Tree"]);
  });

  it("Escape closes only the group and gives the box the focus; a second Escape closes the dialog", async () => {
    const { onClose } = open(NEW);
    await tick("Change users");
    await userEvent.keyboard("{Escape}");
    expect(cards()).toEqual([]);
    expect(screen.getByRole("dialog", { name: "New role" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(box("Change users")).toBeChecked();
    expect(box("Change users")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a press outside (the Name field) closes the group and keeps the tick", async () => {
    open(NEW);
    await tick("Change users");
    expect(cards()).toHaveLength(1);
    await userEvent.click(screen.getByLabelText("Name"));
    expect(cards()).toEqual([]);
    expect(box("Change users")).toBeChecked();
    expect(screen.getByLabelText("Name")).toHaveFocus();
  });

  it("never shows more than one group, however quickly the boxes are ticked", async () => {
    open(NEW);
    for (const label of ["Change assets", "Change dashboards", "Change tariffs", "Change sources", "Change storage settings"]) {
      await tick(label);
      expect(cards().length, `after ticking ${label}`).toBe(1);
    }
    expect(cards()[0]).toHaveAccessibleName("Change storage settings also needs See storage to show anything.");
  });

  it("offers to untick what needs the box that was unticked, and Also untick does both", async () => {
    open(NEW);
    await tick("See users");
    await tick("Change users");
    expect(cards()).toEqual([]); // its need is ticked: nothing to offer
    await tick("See users");
    const group = cardOf(UNTICK_USERS);
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Also untick Change users", "Leave ticked"]);
    expect(within(group).getByRole("button", { name: "Also untick Change users" })).toHaveFocus();
    await userEvent.click(within(group).getByRole("button", { name: "Also untick Change users" }));
    expect(cards()).toEqual([]);
    expect(checked()).toEqual([]);
    expect(box("See users")).toHaveFocus();
  });

  it("Leave ticked keeps the dependent ticked, and the hint line then says what it lacks", async () => {
    open(NEW);
    await tick("See users");
    await tick("Change users");
    await tick("See users");
    await userEvent.click(button("Leave ticked"));
    expect(cards()).toEqual([]);
    expect(checked()).toEqual(["Change users"]);
    expect(hints()).toEqual([USERS_NEED]);
  });

  it("unticking something nobody needs opens nothing", async () => {
    open(NEW);
    await tick("See users");
    await tick("See users");
    expect(cards()).toEqual([]);
  });

  it("does not prompt when Start from fills the ticks, and an open group is gone after Start from", async () => {
    open(NEW);
    const select = screen.getByLabelText("Start from");
    await userEvent.selectOptions(select, "Operator");
    expect(cards()).toEqual([]);
    await userEvent.selectOptions(select, "Viewer");
    expect(cards()).toEqual([]);
    await userEvent.selectOptions(select, "Nothing");
    await tick("Change users");
    expect(cards()).toHaveLength(1);
    fireEvent.change(select, { target: { value: "Viewer" } }); // no pointer press, no focus move: only chooseStart can close the group here
    expect(cards()).toEqual([]);
  });

  it("does not prompt when a role is opened for editing, even one whose ticks break a dependency (the hint line says so)", () => {
    open(editing(roleRow({ id: 7, name: "Odd", permissions: ["users.edit"] })));
    expect(cards()).toEqual([]);
    expect(hints()).toEqual([USERS_NEED]);
  });

  it("does not prompt in a built-in role: its boxes cannot be clicked", async () => {
    open(editing(builtinRoles()[1]));
    await userEvent.click(box("Change users"));
    expect(box("Change users")).not.toBeChecked();
    expect(cards()).toEqual([]);
  });

  it("a new offer on the same box is a fresh card that takes the focus (a keyboard untick right after a tick)", async () => {
    open(NEW);
    await tick("Change tariffs"); // needs See tariffs and See the Assets Tree
    await userEvent.click(button("Not now"));
    await tick("See tariffs"); // opens "See tariffs also needs See the Assets Tree", focus on its primary button
    expect(cardOf("See tariffs also needs See the Assets Tree to show anything.")).toBeInTheDocument();
    await userEvent.tab({ shift: true });
    expect(box("See tariffs")).toHaveFocus();
    await userEvent.keyboard(" "); // unticks it: Change tariffs needs it, so the same box now has an untick offer
    const group = cardOf("Change tariffs needs See tariffs to show anything. Also untick Change tariffs?");
    expect(cards()).toHaveLength(1);
    expect(within(group).getByRole("button", { name: "Also untick Change tariffs" })).toHaveFocus();
  });

  it("unticking the box that has an open offer closes the offer (nobody needs it, so there is nothing new to say)", async () => {
    open(NEW);
    await tick("Change users");
    await userEvent.tab({ shift: true }); // from the card's primary button back to its box: the card stays
    expect(box("Change users")).toHaveFocus();
    expect(cards()).toHaveLength(1);
    await userEvent.keyboard(" ");
    expect(box("Change users")).not.toBeChecked();
    expect(cards()).toEqual([]);
  });

  it("keyboard: Space on a box with a need, Enter on the primary button, and both are ticked with the focus back on the box", async () => {
    open(NEW);
    box("Change users").focus();
    await userEvent.keyboard(" ");
    expect(button("Also tick See users")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(cards()).toEqual([]);
    expect(checked().sort()).toEqual(["Change users", "See users"]);
    expect(box("Change users")).toHaveFocus();
  });

  it("keyboard: Tab from the box goes to the primary button first, then Not now, and past them the group closes", async () => {
    open(NEW);
    await tick("Change users");
    box("Change users").focus(); // the focus is on the card's button after a tick; the box is still its anchor, so the card stays
    expect(cards()).toHaveLength(1);
    await userEvent.tab();
    expect(button("Also tick See users")).toHaveFocus();
    await userEvent.tab();
    expect(button("Not now")).toHaveFocus();
    await userEvent.tab();
    expect(within(box("Change users").closest(".role-perm") as HTMLElement).getByRole("button", { name: "What does this mean?" })).toHaveFocus();
    expect(cards()).toEqual([]);
    expect(box("Change users")).toBeChecked();
  });
});
