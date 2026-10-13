import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
      "Delete assets", "Choose the default dashboard", "Export billing as CSV", "Run network scans", "Accept scan results", "Change sign-in protection", "Export the audit log",
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
    expect(screen.getAllByRole("checkbox")).toHaveLength(28);
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
    expect(screen.getAllByRole("checkbox")).toHaveLength(29);
    expect(checked()).toHaveLength(29);
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
    expect(reached.size).toBe(28);
    first!.focus();
    expect(first).not.toBeChecked();
    await userEvent.keyboard(" ");
    expect(first).toBeChecked();
  });
});
