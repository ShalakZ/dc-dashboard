import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AssetKind } from "../api/types";
import type { PermissionId } from "../lib/permissions";
import { authed } from "../test/dashboardFixtures";
import { holdFetch } from "../test/holdFetch";
import { mockFetch } from "../test/fetchMock";
import { iconHtml } from "../test/iconHtml";
import { renderWithProviders } from "../test/render";
import { useSaveClock } from "../test/saveWindow";
import { accountKnown, SignedIn } from "../test/signedIn";
import { spyToasts } from "../test/toasts";
import { userFor, type BuiltinRole } from "../test/users";
import { AssetKindsPage } from "./AssetKindsPage";

const kind = (id: number, name: string, icon: string, asset_count = 0): AssetKind => ({ id, name, icon, asset_count });
/** The line a reader sees in place of New kind and the row menu. */
const REASON = 'Managing asset kinds needs the "Manage asset kinds" permission.';

useSaveClock(); // the dialogs' Save refuses a second click within 400 ms

/** The registry the fake server holds; the handlers change it, so the page's refetch shows the result. */
function server(initial: AssetKind[], over: Record<string, unknown> = {}) {
  const rows = initial.map((row) => ({ ...row }));
  const routes = {
    "GET /api/asset-kinds": () => ({ body: rows }),
    "POST /api/asset-kinds": ({ body }: { body: unknown }) => {
      const { name, icon } = body as { name: string; icon?: string };
      const row = kind(Math.max(0, ...rows.map((r) => r.id)) + 1, name, icon ?? "generic");
      rows.push(row);
      return { status: 201, body: row };
    },
    "PATCH /api/asset-kinds/1": ({ body }: { body: unknown }) => {
      const row = rows.find((r) => r.id === 1)!;
      Object.assign(row, body as object);
      return { body: row };
    },
    "DELETE /api/asset-kinds/2": () => {
      rows.splice(rows.findIndex((r) => r.id === 2), 1);
      return { status: 204 };
    },
    ...over,
  };
  return { rows, routes };
}

const RACK = kind(1, "Rack", "rack", 12);
const PUMP = kind(2, "Pump", "pump", 0);
const SENSOR = kind(3, "Sensor", "sensor", 1);

/** `permissions`: a custom role that holds exactly these (what the page asks `can` about is the account's list, never the role's name). */
function show({ role = "admin", kinds = [RACK, PUMP, SENSOR], over = {}, permissions }: { role?: BuiltinRole; kinds?: AssetKind[]; over?: Record<string, unknown>; permissions?: PermissionId[] } = {}) {
  const fake = server(kinds, over);
  const me = permissions ? { "GET /api/me": { body: userFor("custom", { permissions }) } } : {};
  const calls = mockFetch({ ...authed(role), ...me, ...fake.routes } as Parameters<typeof mockFetch>[0]);
  const toasts = spyToasts();
  renderWithProviders(<><AssetKindsPage /><SignedIn /></>, { route: "/assets/kinds", path: "/assets/kinds", toasts: toasts.api });
  return { ...fake, calls, toasts };
}
const rowOf = (name: string) => screen.getByText(name, { selector: "td *" }).closest("tr") as HTMLElement;
const newKind = () => screen.findByRole("button", { name: "New kind" });
const menu = async (name: string) => {
  await userEvent.click(within(rowOf(name)).getByRole("button", { name: `Actions for ${name}` }));
  return screen.getByRole("menu", { name: `Actions for ${name}` });
};
const choose = async (name: string, item: string) => userEvent.click(within(await menu(name)).getByRole("menuitem", { name: item }));
const dialog = (name: string) => screen.getByRole("dialog", { name });

describe("the Asset kinds page", () => {
  it("has the title, the trail back to Assets Tree and a tip that says what a kind is for", async () => {
    show();
    expect(await screen.findByRole("heading", { name: "Asset kinds", level: 1 })).toBeInTheDocument();
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(trail).getByRole("link", { name: "Assets Tree" })).toHaveAttribute("href", "/assets");
    expect(within(trail).getByText("Asset kinds")).toHaveAttribute("aria-current", "page");
    await userEvent.click(screen.getByRole("button", { name: "What does this mean?" }));
    expect(screen.getByRole("note")).toHaveTextContent("An asset without an icon of its own shows its kind's icon. Change a kind's icon here and every asset of that kind follows.");
  });

  it("lists each kind with its icon and how many assets have it", async () => {
    show({ kinds: [RACK, PUMP, SENSOR, kind(4, "Odd", "zzz", 2)] });
    await screen.findByText("Rack", { selector: "td *" });
    const icons = { Rack: iconHtml("kindRack"), Pump: iconHtml("kindPump"), Sensor: iconHtml("kindSensor"), Odd: iconHtml("kindGeneric") };
    const counts = { Rack: "12 assets", Pump: "No assets", Sensor: "1 asset", Odd: "2 assets" };
    for (const name of Object.keys(icons) as (keyof typeof icons)[]) {
      const row = rowOf(name);
      expect(within(row).getAllByRole("cell").map((c) => c.textContent)).toEqual([name, counts[name], ""]);
      expect(row.querySelector(".kind-tile svg")!.innerHTML).toBe(icons[name]); // an icon the catalogue lacks draws the generic one
      expect(row.querySelector(".kind-tile")).toHaveAttribute("aria-hidden", "true");
    }
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Assets", ""]);
  });

  it("shows a name of any length in full, with its title", async () => {
    const long = `Long ${"x".repeat(80)}`;
    show({ kinds: [kind(9, long, "generic")] });
    expect(await screen.findByText(long)).toHaveAttribute("title", long);
  });

  it("shows the page's header and a skeleton, labelled for a screen reader, until the list arrives", async () => {
    mockFetch({ ...authed("admin"), "GET /api/asset-kinds": { body: [RACK] } });
    const held = holdFetch((method, path) => method === "GET" && path === "/api/asset-kinds");
    renderWithProviders(<><AssetKindsPage /><SignedIn /></>, { route: "/assets/kinds", path: "/assets/kinds" });
    expect(screen.getByRole("heading", { name: "Asset kinds", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading asset kinds");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    held.release();
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says so when there are no kinds, and still offers New kind to somebody who may add one", async () => {
    show({ kinds: [] });
    expect(await screen.findByText("No kinds yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(await newKind()).toBeEnabled();
  });

  it("shows the server's error under the header when the list cannot be read", async () => {
    show({ over: { "GET /api/asset-kinds": { status: 500, body: { detail: "database is down" } } } });
    expect(await screen.findByRole("alert")).toHaveTextContent("database is down");
    expect(screen.getByRole("heading", { name: "Asset kinds", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it.each<BuiltinRole>(["viewer", "operator"])("gives a %s the list, with no New kind, no starter pack button and no row menu, and says why", async (role) => {
    show({ role });
    await screen.findByText("Rack", { selector: "td *" });
    await accountKnown();
    expect(screen.queryByRole("button", { name: "New kind" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add data-centre kinds" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument();
    expect(screen.getByText(REASON)).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Assets"]);
    expect(within(rowOf("Rack")).getAllByRole("cell")).toHaveLength(2);
  });
});

describe("Manage asset kinds (assets.kinds)", () => {
  // Change assets is not enough: a rename or a move changes the kind of every asset that uses it, so the page asks for its own permission.
  it("a role that holds Change assets but not Manage asset kinds gets the list and the reason, and none of the controls", async () => {
    show({ permissions: ["assets.view", "assets.edit"] });
    await screen.findByText("Rack", { selector: "td *" });
    await accountKnown();
    expect(screen.queryByRole("button", { name: "New kind" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add data-centre kinds" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Assets"]);
    const note = screen.getByText(REASON);
    expect(note.tagName).toBe("P");
    expect(note).not.toHaveAttribute("role"); // a plain line: not an alert, not a status, and not ReadOnlyNote (its words name the wrong thing)
    expect(screen.queryByText(/read-only|read only/i)).not.toBeInTheDocument();
  });

  it("a role that holds Manage asset kinds gets New kind, the starter pack button and the row menu, and no reason line", async () => {
    show({ permissions: ["assets.view", "assets.kinds"] });
    expect(await newKind()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add data-centre kinds" })).toBeEnabled();
    expect(within(rowOf("Rack")).getByRole("button", { name: "Actions for Rack" })).toBeInTheDocument();
    expect(screen.queryByText(REASON)).not.toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Assets", ""]);
  });

  it("an administrator holds it, and the reason line is gone once the account is known", async () => {
    show();
    expect(await newKind()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add data-centre kinds" })).toBeEnabled();
    expect(screen.queryByText(REASON)).not.toBeInTheDocument();
  });

  it("draws the reason line while the list loads too, so the table does not move down when the list arrives", async () => {
    mockFetch({ ...authed("viewer"), "GET /api/asset-kinds": { body: [RACK] } });
    const held = holdFetch((method, path) => method === "GET" && path === "/api/asset-kinds");
    renderWithProviders(<><AssetKindsPage /><SignedIn /></>, { route: "/assets/kinds", path: "/assets/kinds" });
    expect(screen.getByRole("status")).toHaveTextContent("Loading asset kinds");
    expect(screen.getByText(REASON)).toBeInTheDocument();
    held.release();
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getAllByText(REASON)).toHaveLength(1);
  });

  it("offers the starter pack to somebody who may manage kinds when the list is empty", async () => {
    show({ kinds: [] });
    expect(await screen.findByText("No kinds yet.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Add data-centre kinds" })).toBeEnabled();
  });
});

describe("the data-centre starter pack", () => {
  const pack = (reply: unknown) => ({ "POST /api/asset-kinds/starter-pack": reply });
  const press = async () => userEvent.click(await screen.findByRole("button", { name: "Add data-centre kinds" }));

  it("posts nothing but the click, says how many kinds it added, and the list shows them", async () => {
    const added = ["UPS", "Battery", "PDU"];
    const fake = server([RACK, PUMP, SENSOR]);
    // The fake server of this test (its routes read its own rows), with the pack route on top of it.
    const { calls, toasts } = show({
      over: {
        ...fake.routes,
        ...pack(() => {
          added.forEach((name, i) => fake.rows.push(kind(10 + i, name, name.toLowerCase())));
          return { body: { added, already_there: 5 } };
        }),
      },
    });
    await press();
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "success", text: "Added 3 kinds" }]));
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/api/asset-kinds/starter-pack", body: undefined }]);
    expect(await screen.findByText("Battery", { selector: "td *" })).toBeInTheDocument(); // the list was refetched
  });

  it("says Added 1 kind for one", async () => {
    const { toasts } = show({ over: pack({ body: { added: ["Valve"], already_there: 38 } }) });
    await press();
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "success", text: "Added 1 kind" }]));
  });

  it("says they are all there when the server added none, and still refreshes the list", async () => {
    const { toasts, calls } = show({ over: pack({ body: { added: [], already_there: 39 } }) });
    await press();
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "success", text: "All the data-centre kinds are already there" }]));
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.path === "/api/asset-kinds")).toHaveLength(2));
  });

  it("shows the server's refusal as an error toast, with no success toast and no change to the page", async () => {
    const { toasts } = show({ over: pack({ status: 403, body: { detail: "insufficient permission" } }) });
    await press();
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "error", text: "Your role does not allow this." }]));
    expect(screen.getByRole("button", { name: "Add data-centre kinds" })).toBeEnabled();
    expect(screen.getByText("Rack", { selector: "td *" })).toBeInTheDocument();
  });

  it("keeps the focus on the button while the request runs, and a second click sends nothing (aria-disabled, never the native attribute)", async () => {
    const { calls } = show({ over: pack({ body: { added: ["UPS"], already_there: 0 } }) });
    const button = await screen.findByRole("button", { name: "Add data-centre kinds" });
    const held = holdFetch((method, path) => method === "POST" && path === "/api/asset-kinds/starter-pack");
    await userEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"));
    expect(button).not.toBeDisabled();
    expect(button).toHaveFocus();
    await userEvent.click(button);
    held.release();
    await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled", "true"));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(button).toHaveFocus();
  });

  it("is off while a delete confirmation is open, like New kind (two dialogs would share Escape and the focus trap)", async () => {
    show();
    await screen.findByText("Pump", { selector: "td *" });
    await choose("Pump", "Delete");
    expect(screen.getByRole("button", { name: "Add data-centre kinds" })).toBeDisabled();
  });
});

describe("New kind", () => {
  it("opens the dialog, creates the kind with the icon suggested for its name, toasts and shows it in the list", async () => {
    const { calls, toasts } = show();
    await userEvent.click(await newKind());
    expect(dialog("New kind")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Name"), "Hall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/api/asset-kinds", body: { name: "Hall", icon: "hall" } }]);
    expect(toasts.calls).toEqual([{ kind: "success", text: "Kind created" }]);
    expect(await screen.findByText("Hall", { selector: "td *" })).toBeInTheDocument();
    expect(within(rowOf("Hall")).getByText("No assets")).toBeInTheDocument();
  });

  it("keeps the dialog open and shows the server's refusal when the name is taken", async () => {
    const { toasts } = show({ over: { "POST /api/asset-kinds": { status: 409, body: { detail: 'A kind named "Hall" already exists' } } } });
    await userEvent.click(await newKind());
    await userEvent.type(screen.getByLabelText("Name"), "Hall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await within(dialog("New kind")).findByRole("alert")).toHaveTextContent('A kind named "Hall" already exists');
    expect(screen.getByLabelText("Name")).toHaveValue("Hall");
    expect(toasts.calls).toEqual([]);
  });

  it("closes with Cancel and sends nothing", async () => {
    const { calls } = show();
    await userEvent.click(await newKind());
    await userEvent.click(within(dialog("New kind")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("Edit kind", () => {
  it("opens with the kind's name and icon, renames it, and the toast says how many assets follow", async () => {
    const { calls, toasts } = show();
    await screen.findByText("Rack", { selector: "td *" });
    await choose("Rack", "Edit");
    expect(screen.getByLabelText("Name")).toHaveValue("Rack");
    expect(within(dialog("Edit kind")).getByRole("group", { name: "Icon" })).toHaveAccessibleDescription("Rack");
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "Racks");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([{ method: "PATCH", path: "/api/asset-kinds/1", body: { name: "Racks" } }]);
    expect(toasts.calls).toEqual([{ kind: "success", text: "Kind renamed, 12 assets follow" }]);
    expect(await screen.findByText("Racks", { selector: "td *" })).toBeInTheDocument();
  });

  it.each([
    [0, "Kind renamed"],
    [1, "Kind renamed, 1 asset follows"],
    [2, "Kind renamed, 2 assets follow"],
  ])("a rename with %i assets toasts %j", async (count, text) => {
    const { toasts } = show({ kinds: [kind(1, "Rack", "rack", count), PUMP] });
    await screen.findByText("Rack", { selector: "td *" });
    await choose("Rack", "Edit");
    await userEvent.type(screen.getByLabelText("Name"), "s");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toasts.calls).toHaveLength(1));
    expect(toasts.calls[0]).toEqual({ kind: "success", text });
  });

  it("changing only the icon sends only the icon and toasts Kind saved; the list shows the new icon", async () => {
    const { calls, toasts } = show();
    await screen.findByText("Rack", { selector: "td *" });
    await choose("Rack", "Edit");
    await userEvent.click(within(dialog("Edit kind")).getByRole("button", { name: "Change icon" }));
    await userEvent.click(within(dialog("Edit kind")).getByRole("radio", { name: "Server", hidden: true }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === "PATCH")[0].body).toEqual({ icon: "server" });
    expect(toasts.calls).toEqual([{ kind: "success", text: "Kind saved" }]);
    const server = iconHtml("kindServer");
    await waitFor(() => expect(rowOf("Rack").querySelector(".kind-tile svg")!.innerHTML).toBe(server));
  });

  it("saving with nothing changed closes the dialog without a request or a toast", async () => {
    const { calls, toasts } = show();
    await screen.findByText("Rack", { selector: "td *" });
    await choose("Rack", "Edit");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(toasts.calls).toEqual([]);
  });

  it("keeps the dialog open and shows the server's refusal when the name belongs to another kind", async () => {
    show({ over: { "PATCH /api/asset-kinds/1": { status: 409, body: { detail: 'A kind named "Crane" already exists' } } } });
    await screen.findByText("Rack", { selector: "td *" });
    await choose("Rack", "Edit");
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "Crane");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await within(dialog("Edit kind")).findByRole("alert")).toHaveTextContent('A kind named "Crane" already exists');
  });

  it("opens with the kind as it was when Edit was chosen, whatever the list does meanwhile", async () => {
    const { rows } = show();
    await screen.findByText("Rack", { selector: "td *" });
    await choose("Rack", "Edit");
    rows[0].name = "Changed elsewhere";
    expect(screen.getByLabelText("Name")).toHaveValue("Rack");
  });
});

describe("Delete kind", () => {
  it("asks first, and deletes a kind no asset has, with a toast", async () => {
    const { calls, toasts } = show();
    await screen.findByText("Pump", { selector: "td *" });
    await choose("Pump", "Delete");
    const ask = dialog('Delete the kind "Pump"?');
    expect(within(ask).getByText("Assets that carry the name later get an automatic icon.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/api/asset-kinds/2"]);
    expect(toasts.calls).toEqual([{ kind: "success", text: 'Kind "Pump" deleted' }]);
    await waitFor(() => expect(screen.queryByText("Pump", { selector: "td *" })).not.toBeInTheDocument());
  });

  it("cancels without a request", async () => {
    const { calls } = show();
    await screen.findByText("Pump", { selector: "td *" });
    await choose("Pump", "Delete");
    await userEvent.click(within(dialog('Delete the kind "Pump"?')).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it.each([
    ["Rack", '12 assets use "Rack", so it can\'t be deleted. Change their kind first.'],
    ["Sensor", '1 asset uses "Sensor", so it can\'t be deleted. Change its kind first.'],
  ])("a kind in use (%s) opens the same dialog, says why it cannot go, and has no way to confirm (no Delete button, Close in place of Cancel)", async (name, why) => {
    const { calls } = show();
    await screen.findByText(name, { selector: "td *" });
    await choose(name, "Delete");
    const ask = dialog(`Delete the kind "${name}"?`);
    expect(within(ask).getByRole("alert")).toHaveTextContent(why);
    expect(within(ask).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(within(ask).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(within(ask).getByRole("button", { name: "Close" })).toHaveFocus();
    await userEvent.click(within(ask).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it.each([
    ["3 assets", { detail: "3 assets use this kind. Change their kind first.", assets: 3 }, '3 assets use "Pump", so it can\'t be deleted. Change their kind first.'],
    ["1 asset", { detail: "1 asset uses this kind. Change its kind first.", assets: 1 }, '1 asset uses "Pump", so it can\'t be deleted. Change its kind first.'],
    ["no count in the answer", { detail: "Some assets use this kind." }, '1 asset uses "Pump", so it can\'t be deleted. Change its kind first.'],
  ])("turns the open dialog into the blocked one when the server refuses because assets took the kind meanwhile (%s)", async (_case, body, why) => {
    const { toasts, calls } = show({ over: { "DELETE /api/asset-kinds/2": { status: 409, body } } });
    await screen.findByText("Pump", { selector: "td *" });
    await choose("Pump", "Delete");
    const ask = dialog('Delete the kind "Pump"?');
    expect(within(ask).getByText("Assets that carry the name later get an automatic icon.")).toBeInTheDocument();
    await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
    expect(await within(ask).findByRole("alert")).toHaveTextContent(why);
    expect(within(ask).queryByText("Assets that carry the name later get an automatic icon.")).not.toBeInTheDocument(); // the stale reassurance is gone
    expect(within(ask).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(within(ask).getAllByRole("alert")).toHaveLength(1); // the sentence once, not the server's wording on top of it
    await waitFor(() => expect(within(ask).getByRole("button", { name: "Close" })).toHaveFocus());
    expect(toasts.calls).toEqual([]);
    expect(screen.getByText("Pump", { selector: "td *" })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    await userEvent.click(within(ask).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("still shows any other refusal of the confirmed delete inside the dialog, which stays confirmable", async () => {
    const { toasts } = show({ over: { "DELETE /api/asset-kinds/2": { status: 403, body: { detail: "insufficient permission" } } } });
    await screen.findByText("Pump", { selector: "td *" });
    await choose("Pump", "Delete");
    const ask = dialog('Delete the kind "Pump"?');
    await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
    expect(await within(ask).findByRole("alert")).toHaveTextContent("Your role does not allow this.");
    expect(within(ask).getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(toasts.calls).toEqual([]);
  });

  it("puts the focus on New kind after a confirmed delete (the row and its menu are gone), not on the page body", async () => {
    show();
    await screen.findByText("Pump", { selector: "td *" });
    await choose("Pump", "Delete");
    await userEvent.click(within(dialog('Delete the kind "Pump"?')).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "New kind" })).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("does not pull the focus to New kind after Cancel (only a delete takes the opener away)", async () => {
    show();
    await screen.findByText("Pump", { selector: "td *" });
    await choose("Pump", "Delete");
    await userEvent.click(within(dialog('Delete the kind "Pump"?')).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "New kind" })).not.toHaveFocus();
  });

  it("does not let New kind start a second dialog while the confirmation is open", async () => {
    show();
    await screen.findByText("Pump", { selector: "td *" });
    await choose("Pump", "Delete");
    expect(screen.getByRole("button", { name: "New kind" })).toBeDisabled();
  });
});
