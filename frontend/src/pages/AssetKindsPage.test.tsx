import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AssetKind } from "../api/types";
import { authed } from "../test/dashboardFixtures";
import { holdFetch } from "../test/holdFetch";
import { mockFetch } from "../test/fetchMock";
import { iconHtml } from "../test/iconHtml";
import { renderWithProviders } from "../test/render";
import { useSaveClock } from "../test/saveWindow";
import { accountKnown, SignedIn } from "../test/signedIn";
import { spyToasts } from "../test/toasts";
import type { BuiltinRole } from "../test/users";
import { AssetKindsPage } from "./AssetKindsPage";

const kind = (id: number, name: string, icon: string, asset_count = 0): AssetKind => ({ id, name, icon, asset_count });

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

function show({ role = "admin", kinds = [RACK, PUMP, SENSOR], over = {} }: { role?: BuiltinRole; kinds?: AssetKind[]; over?: Record<string, unknown> } = {}) {
  const fake = server(kinds, over);
  const calls = mockFetch({ ...authed(role), ...fake.routes } as Parameters<typeof mockFetch>[0]);
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

  it.each<BuiltinRole>(["viewer", "operator"])("gives a %s the list, with no New kind and no row menu", async (role) => {
    show({ role });
    await screen.findByText("Rack", { selector: "td *" });
    await accountKnown();
    expect(screen.queryByRole("button", { name: "New kind" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Assets"]);
    expect(within(rowOf("Rack")).getAllByRole("cell")).toHaveLength(2);
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
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/api/asset-kinds", body: { name: "Hall", icon: "room" } }]);
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
  ])("a kind in use (%s) opens the same dialog, says why it cannot go, and has no way to confirm", async (name, why) => {
    const { calls } = show();
    await screen.findByText(name, { selector: "td *" });
    await choose(name, "Delete");
    const ask = dialog(`Delete the kind "${name}"?`);
    expect(within(ask).getByRole("alert")).toHaveTextContent(why);
    expect(within(ask).getByRole("button", { name: "Delete" })).toBeDisabled();
    await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the server's refusal inside the dialog when the count it was shown is out of date", async () => {
    const stale = { status: 409, body: { detail: "3 assets use this kind. Change their kind first.", assets: 3 } };
    const { toasts } = show({ over: { "DELETE /api/asset-kinds/2": stale } });
    await screen.findByText("Pump", { selector: "td *" });
    await choose("Pump", "Delete");
    const ask = dialog('Delete the kind "Pump"?');
    await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
    expect(await within(ask).findByRole("alert")).toHaveTextContent("3 assets use this kind. Change their kind first.");
    expect(toasts.calls).toEqual([]);
    expect(screen.getByText("Pump", { selector: "td *" })).toBeInTheDocument();
  });

  it("does not let New kind start a second dialog while the confirmation is open", async () => {
    show();
    await screen.findByText("Pump", { selector: "td *" });
    await choose("Pump", "Delete");
    expect(screen.getByRole("button", { name: "New kind" })).toBeDisabled();
  });
});
