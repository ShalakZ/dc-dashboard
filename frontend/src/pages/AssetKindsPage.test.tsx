import { act, screen, waitFor, within } from "@testing-library/react";
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

const kind = (id: number, name: string, icon: string, asset_count = 0): AssetKind => ({ id, name, icon, asset_count, starter: false });
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
type Fake = ReturnType<typeof server>;
/** `over`: routes that replace the fake server's, or a function that builds them from the fake (a route that must change the rows the list answers with). */
function show({ role = "admin", kinds = [RACK, PUMP, SENSOR], over = {}, permissions }: { role?: BuiltinRole; kinds?: AssetKind[]; over?: Record<string, unknown> | ((fake: Fake) => Record<string, unknown>); permissions?: PermissionId[] } = {}) {
  const fake = server(kinds);
  Object.assign(fake.routes, typeof over === "function" ? over(fake) : over);
  const me = permissions ? { "GET /api/me": { body: userFor("custom", { permissions }) } } : {};
  const calls = mockFetch({ ...authed(role), ...me, ...fake.routes } as Parameters<typeof mockFetch>[0]);
  const toasts = spyToasts();
  const { unmount } = renderWithProviders(<><AssetKindsPage /><SignedIn /></>, { route: "/assets/kinds", path: "/assets/kinds", toasts: toasts.api });
  return { ...fake, calls, toasts, unmount };
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
      expect(within(row).getAllByRole("cell").map((c) => c.textContent)).toEqual(["", name, counts[name], ""]); // the checkbox cell, the name, the count, the menu cell
      expect(row.querySelector("td.kind-assets")).toHaveTextContent(counts[name]);
      expect(row.querySelector(".kind-tile svg")!.innerHTML).toBe(icons[name]); // an icon the catalogue lacks draws the generic one
      expect(row.querySelector(".kind-tile")).toHaveAttribute("aria-hidden", "true");
    }
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["", "Name", "Assets", ""]);
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
    expect(screen.queryByRole("button", { name: "Add common data-centre kinds" })).not.toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: "Add common data-centre kinds" })).not.toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Add common data-centre kinds" })).toBeEnabled();
    expect(within(rowOf("Rack")).getByRole("button", { name: "Actions for Rack" })).toBeInTheDocument();
    expect(screen.queryByText(REASON)).not.toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["", "Name", "Assets", ""]);
  });

  it("an administrator holds it, and the reason line is gone once the account is known", async () => {
    show();
    expect(await newKind()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add common data-centre kinds" })).toBeEnabled();
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
    expect(await screen.findByRole("button", { name: "Add common data-centre kinds" })).toBeEnabled();
  });
});

describe("the data-centre starter pack", () => {
  const pack = (reply: unknown) => ({ "POST /api/asset-kinds/starter-pack": reply });
  const press = async () => userEvent.click(await screen.findByRole("button", { name: "Add common data-centre kinds" }));

  it("posts nothing but the click, with NO query (the server's default is the common set), says how many kinds it added, and the list shows them", async () => {
    const added = ["UPS", "Battery", "PDU"];
    const sent: string[] = [];
    const { calls, toasts } = show({
      over: (fake) => pack(({ url }: { url: string }) => {
        sent.push(url); // mockFetch strips the query from `calls`, so the url is recorded here: "no query" would pass vacuously otherwise
        added.forEach((name, i) => fake.rows.push(kind(10 + i, name, name.toLowerCase())));
        return { body: { added, already_there: 13 } };
      }),
    });
    await press();
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "success", text: "Added 3 kinds" }]));
    expect(sent).toEqual(["/api/asset-kinds/starter-pack"]);
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/api/asset-kinds/starter-pack", body: undefined }]);
    expect(await screen.findByText("Battery", { selector: "td *" })).toBeInTheDocument(); // the list was refetched
  });

  it("says Added 1 kind for one", async () => {
    const { toasts } = show({ over: pack({ body: { added: ["Valve"], already_there: 38 } }) });
    await press();
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "success", text: "Added 1 kind" }]));
  });

  it("says the common kinds are all there when the server added none, and still refreshes the list", async () => {
    const { toasts, calls } = show({ over: pack({ body: { added: [], already_there: 16 } }) });
    await press();
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "success", text: "All the common data-centre kinds are already there" }]));
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.path === "/api/asset-kinds")).toHaveLength(2));
  });

  it("the toolbar's button asks for the whole catalogue (?set=all) and has its own sentences: Added 1 kind, and all the data-centre kinds are already there", async () => {
    const replies = [{ added: ["Valve"], already_there: 38 }, { added: [], already_there: 39 }];
    const sent: string[] = [];
    const { toasts } = show({ over: pack(({ url }: { url: string }) => { sent.push(url); return { body: replies.shift() }; }) });
    const all = await screen.findByRole("button", { name: "Add all 39 data-centre kinds" });
    await userEvent.click(all);
    await waitFor(() => expect(toasts.calls).toHaveLength(1));
    await waitFor(() => expect(all).not.toHaveAttribute("aria-disabled", "true"));
    await userEvent.click(all);
    await waitFor(() => expect(toasts.calls).toHaveLength(2));
    expect(toasts.calls).toEqual([{ kind: "success", text: "Added 1 kind" }, { kind: "success", text: "All the data-centre kinds are already there" }]);
    expect(sent).toEqual(["/api/asset-kinds/starter-pack?set=all", "/api/asset-kinds/starter-pack?set=all"]);
  });

  it("is a plain button next to the primary New kind, and says common in its name", async () => {
    show();
    const button = await screen.findByRole("button", { name: "Add common data-centre kinds" });
    expect(button).not.toHaveClass("primary");
    expect(await newKind()).toHaveClass("primary");
    expect(screen.queryByRole("button", { name: "Add data-centre kinds" })).not.toBeInTheDocument();
  });

  it("shows the server's refusal as an error toast, with no success toast and no change to the page", async () => {
    const { toasts } = show({ over: pack({ status: 403, body: { detail: "insufficient permission" } }) });
    await press();
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "error", text: "Your role does not allow this." }]));
    expect(screen.getByRole("button", { name: "Add common data-centre kinds" })).toBeEnabled();
    expect(screen.getByText("Rack", { selector: "td *" })).toBeInTheDocument();
  });

  it("keeps the focus on the button while the request runs, and a second click sends nothing (aria-disabled, never the native attribute)", async () => {
    const { calls } = show({ over: pack({ body: { added: ["UPS"], already_there: 0 } }) });
    const button = await screen.findByRole("button", { name: "Add common data-centre kinds" });
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
    expect(screen.getByRole("button", { name: "Add common data-centre kinds" })).toBeDisabled();
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

  describe("a kind in use: the dialog asks where its assets go", () => {
    /** The server's DELETE: the kind goes, and with move_to its assets join the target (its count grows). Every url is recorded as sent, query included. */
    const removing = (id: number, sent: string[], reply?: () => { status: number; body?: unknown }) => (fake: Fake) => ({
      [`DELETE /api/asset-kinds/${id}`]: ({ url }: { url: string }) => {
        sent.push(url);
        if (reply) return reply();
        const row = fake.rows.find((r) => r.id === id)!;
        const target = fake.rows.find((r) => String(r.id) === new URL(url, "http://x").searchParams.get("move_to"));
        if (target) target.asset_count += row.asset_count;
        fake.rows.splice(fake.rows.indexOf(row), 1);
        return { status: 204 };
      },
    });
    const picker = (ask: HTMLElement) => within(ask).getByLabelText("Move the assets to") as HTMLSelectElement;
    const optionTexts = (ask: HTMLElement) => within(picker(ask)).getAllByRole("option").map((o) => o.textContent);

    it("opens the move form: the count in words, a labelled select of every OTHER kind sorted by name, and a Delete that waits for a choice", async () => {
      const { calls } = show();
      await screen.findByText("Rack", { selector: "td *" });
      await choose("Rack", "Delete");
      const ask = dialog('Delete the kind "Rack"?');
      expect(ask).toHaveAccessibleDescription('12 assets use "Rack". Move them to another kind, then delete "Rack".');
      expect(optionTexts(ask)).toEqual(["Choose a kind…", "Pump", "Sensor"]); // Rack itself is not offered
      expect(picker(ask)).toHaveValue("");
      expect(picker(ask).closest("[aria-live]")).toBeNull(); // outside the region the dialog is described by
      expect(within(ask).getByRole("button", { name: "Delete" })).toBeDisabled();
      expect(within(ask).getByRole("button", { name: "Cancel" })).toHaveFocus();
      expect(within(ask).queryByRole("alert")).not.toBeInTheDocument();
      expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    });

    it("sorts the choices by key, whatever order the list came in", async () => {
      show({ kinds: [kind(1, "Zebra", "rack", 2), kind(2, "apple", "pump"), kind(3, "Mango", "sensor"), kind(4, "Berry", "room")] });
      await screen.findByText("Zebra", { selector: "td *" });
      await choose("Zebra", "Delete");
      expect(optionTexts(dialog('Delete the kind "Zebra"?'))).toEqual(["Choose a kind…", "apple", "Berry", "Mango"]);
    });

    it("says it in the singular for one asset", async () => {
      show();
      await screen.findByText("Sensor", { selector: "td *" });
      await choose("Sensor", "Delete");
      expect(dialog('Delete the kind "Sensor"?')).toHaveAccessibleDescription('1 asset uses "Sensor". Move it to another kind, then delete "Sensor".');
    });

    it("moves with the choice: sends move_to and the count it showed, toasts where they went, and the list follows", async () => {
      const sent: string[] = [];
      const { toasts } = show({ over: removing(1, sent) });
      await screen.findByText("Rack", { selector: "td *" });
      await choose("Rack", "Delete");
      const ask = dialog('Delete the kind "Rack"?');
      await userEvent.selectOptions(picker(ask), "Sensor");
      expect(within(ask).getByRole("button", { name: "Delete" })).toBeEnabled();
      await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(sent).toEqual(["/api/asset-kinds/1?move_to=3&expect_assets=12"]);
      expect(toasts.calls).toEqual([{ kind: "success", text: 'Kind "Rack" deleted, 12 assets moved to Sensor' }]);
      await waitFor(() => expect(screen.queryByText("Rack", { selector: "td *" })).not.toBeInTheDocument());
      expect(within(rowOf("Sensor")).getByText("13 assets")).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("button", { name: "Actions for Pump" })).toHaveFocus()); // the row and its menu are gone: the row that moved up has it
    });

    it("toasts the singular for one asset", async () => {
      const sent: string[] = [];
      const { toasts } = show({ over: removing(3, sent) });
      await screen.findByText("Sensor", { selector: "td *" });
      await choose("Sensor", "Delete");
      const ask = dialog('Delete the kind "Sensor"?');
      await userEvent.selectOptions(picker(ask), "Pump");
      await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(toasts.calls).toHaveLength(1));
      expect(sent).toEqual(["/api/asset-kinds/3?move_to=2&expect_assets=1"]);
      expect(toasts.calls[0].text).toBe('Kind "Sensor" deleted, 1 asset moved to Pump');
    });

    it("an unused kind still goes with no query at all, and its toast names no move", async () => {
      const sent: string[] = [];
      const { toasts } = show({ over: removing(2, sent) });
      await screen.findByText("Pump", { selector: "td *" });
      await choose("Pump", "Delete");
      expect(within(dialog('Delete the kind "Pump"?')).queryByRole("combobox")).not.toBeInTheDocument();
      await userEvent.click(within(dialog('Delete the kind "Pump"?')).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(toasts.calls).toHaveLength(1));
      expect(sent).toEqual(["/api/asset-kinds/2"]);
      expect(toasts.calls[0].text).toBe('Kind "Pump" deleted');
    });

    it("with no other kind to move to, it is the blocked dialog: why, no select, no Delete, Close in place of Cancel", async () => {
      const { calls } = show({ kinds: [RACK] });
      await screen.findByText("Rack", { selector: "td *" });
      await choose("Rack", "Delete");
      const ask = dialog('Delete the kind "Rack"?');
      expect(within(ask).getByRole("alert")).toHaveTextContent('12 assets use "Rack". Create another kind to move them to first.');
      expect(within(ask).queryByRole("combobox")).not.toBeInTheDocument();
      expect(within(ask).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
      expect(within(ask).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
      expect(within(ask).getByRole("button", { name: "Close" })).toHaveFocus();
      await userEvent.click(within(ask).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    });

    it("says the singular in the blocked dialog too", async () => {
      show({ kinds: [SENSOR] });
      await screen.findByText("Sensor", { selector: "td *" });
      await choose("Sensor", "Delete");
      expect(within(dialog('Delete the kind "Sensor"?')).getByRole("alert")).toHaveTextContent('1 asset uses "Sensor". Create another kind to move it to first.');
    });

    describe("when the server says the count is not what the dialog showed (409)", () => {
      it("shows the server's count, keeps the choice, and the next click sends the new count", async () => {
        const sent: string[] = [];
        let stale = true;
        const { toasts } = show({
          over: (fake) => removing(1, sent, () => {
            if (!stale) return { status: 204 };
            stale = false;
            fake.rows[0].asset_count = 14;
            return { status: 409, body: { detail: "14 assets use this kind now. Check the new count and try again.", assets: 14 } };
          })(fake),
        });
        await screen.findByText("Rack", { selector: "td *" });
        await choose("Rack", "Delete");
        const ask = dialog('Delete the kind "Rack"?');
        await userEvent.selectOptions(picker(ask), "Sensor");
        await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
        await waitFor(() => expect(ask).toHaveAccessibleDescription('14 assets use "Rack". Move them to another kind, then delete "Rack".'));
        expect(picker(ask)).toHaveValue("3"); // the choice stays
        expect(within(ask).getByRole("button", { name: "Delete" })).toBeEnabled();
        expect(within(ask).getAllByRole("alert").map((a) => a.textContent)).toEqual(["14 assets use this kind now. Check the new count and try again."]); // why it changed: the server's words, in the dialog's own error line
        expect(toasts.calls).toEqual([]);
        await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(sent).toEqual(["/api/asset-kinds/1?move_to=3&expect_assets=12", "/api/asset-kinds/1?move_to=3&expect_assets=14"]);
        expect(toasts.calls).toEqual([{ kind: "success", text: 'Kind "Rack" deleted, 14 assets moved to Sensor' }]);
      });

      // The server's line says the count changed (W7o fix wave): a second Delete press is then a conscious one.
      const staleTwice = (sent: string[], counts: number[]) => (fake: Fake) => removing(1, sent, () => {
        const n = counts.shift();
        if (n === undefined) return { status: 204 };
        fake.rows[0].asset_count = n;
        return { status: 409, body: { detail: `${n} assets use this kind now. Check the new count and try again.`, assets: n } };
      })(fake);
      const chooseSensorAndDelete = async () => {
        await screen.findByText("Rack", { selector: "td *" });
        await choose("Rack", "Delete");
        const ask = dialog('Delete the kind "Rack"?');
        await userEvent.selectOptions(picker(ask), "Sensor");
        await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
        return ask;
      };

      it("takes the line away when another kind is chosen, and Delete still works", async () => {
        const sent: string[] = [];
        show({ over: staleTwice(sent, [14]) });
        const ask = await chooseSensorAndDelete();
        expect(await within(ask).findByRole("alert")).toHaveTextContent("14 assets use this kind now. Check the new count and try again.");
        await userEvent.selectOptions(picker(ask), "Pump");
        expect(within(ask).queryByRole("alert")).not.toBeInTheDocument();
        expect(within(ask).getByRole("button", { name: "Delete" })).toBeEnabled();
        await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(sent).toEqual(["/api/asset-kinds/1?move_to=3&expect_assets=12", "/api/asset-kinds/1?move_to=2&expect_assets=14"]);
      });

      it("replaces the line with the newer one when the count moves again (one line, never two)", async () => {
        show({ over: staleTwice([], [14, 15]) });
        const ask = await chooseSensorAndDelete();
        expect(await within(ask).findByRole("alert")).toHaveTextContent("14 assets use");
        await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
        await waitFor(() => expect(within(ask).getByRole("alert")).toHaveTextContent("15 assets use this kind now."));
        expect(within(ask).getAllByRole("alert")).toHaveLength(1);
      });

      it("a later refusal (422) shows only its own words: the old line is gone when the next request starts", async () => {
        let answers = 0;
        show({
          over: (fake) => ({
            "DELETE /api/asset-kinds/1": () => {
              answers += 1;
              if (answers === 1) { fake.rows[0].asset_count = 14; return { status: 409, body: { detail: "14 assets use this kind now. Check the new count and try again.", assets: 14 } }; }
              return { status: 422, body: { detail: "that kind no longer exists." } };
            },
          }),
        });
        const ask = await chooseSensorAndDelete();
        expect(await within(ask).findByRole("alert")).toHaveTextContent("14 assets use");
        await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
        await waitFor(() => expect(within(ask).getByRole("alert")).toHaveTextContent("That kind no longer exists."));
        expect(within(ask).getAllByRole("alert")).toHaveLength(1);
      });

      it("opens clean the next time (the line of an earlier dialog is not remembered)", async () => {
        show({ over: staleTwice([], [14]) });
        const ask = await chooseSensorAndDelete();
        expect(await within(ask).findByRole("alert")).toBeInTheDocument();
        await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
        await choose("Rack", "Delete");
        expect(within(dialog('Delete the kind "Rack"?')).queryByRole("alert")).not.toBeInTheDocument();
      });

      it("drops the choice when that kind is gone from the refreshed list, and the focus goes to the select (not the page body)", async () => {
        const { calls } = show({
          over: (fake) => ({
            "DELETE /api/asset-kinds/1": () => {
              fake.rows.splice(fake.rows.findIndex((r) => r.id === 3), 1); // somebody deleted Sensor meanwhile
              return { status: 409, body: { detail: "13 assets use this kind now.", assets: 13 } };
            },
          }),
        });
        await screen.findByText("Rack", { selector: "td *" });
        await choose("Rack", "Delete");
        const ask = dialog('Delete the kind "Rack"?');
        await userEvent.selectOptions(picker(ask), "Sensor");
        await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
        await waitFor(() => expect(optionTexts(ask)).toEqual(["Choose a kind…", "Pump"]));
        expect(picker(ask)).toHaveValue("");
        expect(ask).toHaveAccessibleDescription('13 assets use "Rack". Move them to another kind, then delete "Rack".');
        expect(within(ask).getByRole("button", { name: "Delete" })).toBeDisabled();
        await waitFor(() => expect(picker(ask)).toHaveFocus());
        expect(document.activeElement).not.toBe(document.body);
        expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
      });

      it("turns the plain dialog (nothing used the kind when it opened) into the move form with the server's count, and the select takes the focus", async () => {
        const { toasts, calls } = show({ over: { "DELETE /api/asset-kinds/2": { status: 409, body: { detail: "3 assets use this kind. Change their kind first.", assets: 3 } } } });
        await screen.findByText("Pump", { selector: "td *" });
        await choose("Pump", "Delete");
        const ask = dialog('Delete the kind "Pump"?');
        expect(within(ask).getByText("Assets that carry the name later get an automatic icon.")).toBeInTheDocument();
        await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
        await waitFor(() => expect(ask).toHaveAccessibleDescription('3 assets use "Pump". Move them to another kind, then delete "Pump".'));
        expect(within(ask).queryByText("Assets that carry the name later get an automatic icon.")).not.toBeInTheDocument(); // the stale reassurance is gone
        expect(optionTexts(ask)).toEqual(["Choose a kind…", "Rack", "Sensor"]);
        expect(within(ask).getByRole("button", { name: "Delete" })).toBeDisabled(); // a choice first
        await waitFor(() => expect(picker(ask)).toHaveFocus());
        expect(document.activeElement).not.toBe(document.body);
        expect(within(ask).getAllByRole("alert").map((a) => a.textContent)).toEqual(["3 assets use this kind. Change their kind first."]); // why the plain question became the form
        expect(toasts.calls).toEqual([]);
        expect(screen.getByText("Pump", { selector: "td *" })).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
      });

      it.each([
        ["3 assets", { detail: "3 assets use this kind.", assets: 3 }, '3 assets use "Pump". Create another kind to move them to first.'],
        ["1 asset", { detail: "1 asset uses this kind.", assets: 1 }, '1 asset uses "Pump". Create another kind to move it to first.'],
        ["no count in the answer", { detail: "Some assets use this kind." }, '1 asset uses "Pump". Create another kind to move it to first.'],
      ])("turns the plain dialog into the blocked one when there is no other kind to move to (%s)", async (_case, body, why) => {
        const { toasts } = show({ kinds: [PUMP], over: { "DELETE /api/asset-kinds/2": { status: 409, body } } });
        await screen.findByText("Pump", { selector: "td *" });
        await choose("Pump", "Delete");
        const ask = dialog('Delete the kind "Pump"?');
        await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
        expect(await within(ask).findByRole("alert")).toHaveTextContent(why);
        expect(within(ask).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
        expect(within(ask).getAllByRole("alert")).toHaveLength(1); // the sentence once, not the server's wording on top of it
        await waitFor(() => expect(within(ask).getByRole("button", { name: "Close" })).toHaveFocus());
        expect(toasts.calls).toEqual([]);
      });

      it("turns the move form into the plain dialog when the server says no asset is left, and the next Delete sends no query", async () => {
        const sent: string[] = [];
        let first = true;
        const { toasts } = show({
          over: (fake) => removing(1, sent, () => {
            if (!first) return { status: 204 };
            first = false;
            fake.rows[0].asset_count = 0;
            return { status: 409, body: { detail: "No assets use this kind now. Check the new count and try again.", assets: 0 } };
          })(fake),
        });
        await screen.findByText("Rack", { selector: "td *" });
        await choose("Rack", "Delete");
        const ask = dialog('Delete the kind "Rack"?');
        await userEvent.selectOptions(picker(ask), "Pump");
        await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
        expect(await within(ask).findByText("Assets that carry the name later get an automatic icon.")).toBeInTheDocument();
        expect(within(ask).queryByRole("combobox")).not.toBeInTheDocument();
        expect(within(ask).getAllByRole("alert").map((a) => a.textContent)).toEqual(["No assets use this kind now. Check the new count and try again."]);
        await waitFor(() => expect(within(ask).getByRole("button", { name: "Delete" })).toBeEnabled());
        await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(sent).toEqual(["/api/asset-kinds/1?move_to=2&expect_assets=12", "/api/asset-kinds/1"]);
        expect(toasts.calls).toEqual([{ kind: "success", text: 'Kind "Rack" deleted' }]);
      });
    });

    it("shows a 422 inside the dialog in the server's words, and the dialog stays confirmable", async () => {
      const { toasts } = show({ over: { "DELETE /api/asset-kinds/1": { status: 422, body: { detail: "that kind no longer exists." } } } });
      await screen.findByText("Rack", { selector: "td *" });
      await choose("Rack", "Delete");
      const ask = dialog('Delete the kind "Rack"?');
      await userEvent.selectOptions(picker(ask), "Pump");
      await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
      expect(await within(ask).findByRole("alert")).toHaveTextContent("That kind no longer exists.");
      expect(picker(ask)).toHaveValue("2");
      expect(within(ask).getByRole("button", { name: "Delete" })).toBeEnabled();
      expect(toasts.calls).toEqual([]);
      expect(screen.getByText("Rack", { selector: "td *" })).toBeInTheDocument();
    });

    it("opens each time with no choice (the last one is not remembered)", async () => {
      show();
      await screen.findByText("Rack", { selector: "td *" });
      await choose("Rack", "Delete");
      await userEvent.selectOptions(picker(dialog('Delete the kind "Rack"?')), "Pump");
      await userEvent.click(within(dialog('Delete the kind "Rack"?')).getByRole("button", { name: "Cancel" }));
      await choose("Rack", "Delete");
      expect(picker(dialog('Delete the kind "Rack"?'))).toHaveValue("");
      expect(within(dialog('Delete the kind "Rack"?')).getByRole("button", { name: "Delete" })).toBeDisabled();
    });
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

  describe("where the focus goes after a confirmed delete (the row and its menu are gone), without scrolling", () => {
    /** Every focus() call of the test with the element and the options it was given. */
    const focusCalls = () => {
      const calls: { el: Element; options: FocusOptions | undefined }[] = [];
      const real = HTMLElement.prototype.focus;
      const spy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
        calls.push({ el: this, options });
        real.call(this, options);
      });
      return { calls, restore: () => spy.mockRestore() };
    };
    const del = async (name: string) => {
      await choose(name, "Delete");
      await userEvent.click(within(dialog(`Delete the kind "${name}"?`)).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    };
    const FOUR = [kind(1, "Alpha", "rack"), kind(2, "Pump", "pump"), kind(3, "Hall", "hall"), kind(4, "Valve", "valve")];
    const removingRow = (id: number) => (fake: Fake) => ({
      [`DELETE /api/asset-kinds/${id}`]: () => { fake.rows.splice(fake.rows.findIndex((r) => r.id === id), 1); return { status: 204 }; },
    });

    it("is the menu button of the next row, with preventScroll, and never New kind or the page body", async () => {
      const { calls, restore } = focusCalls();
      try {
        show({ kinds: FOUR, over: removingRow(2) });
        await screen.findByText("Pump", { selector: "td *" });
        await del("Pump");
        await waitFor(() => expect(screen.getByRole("button", { name: "Actions for Hall" })).toHaveFocus());
        expect(document.activeElement).not.toBe(document.body);
        expect(screen.getByRole("button", { name: "New kind" })).not.toHaveFocus();
        const last = calls.filter((c) => c.el === screen.getByRole("button", { name: "Actions for Hall" })).at(-1);
        expect(last?.options).toEqual({ preventScroll: true });
      } finally {
        restore();
      }
    });

    it("is the menu button of the previous row when the deleted one was the last", async () => {
      show({ kinds: FOUR, over: removingRow(4) });
      await screen.findByText("Valve", { selector: "td *" });
      await del("Valve");
      await waitFor(() => expect(screen.getByRole("button", { name: "Actions for Hall" })).toHaveFocus());
    });

    it("goes by the rows SHOWN: under a filter the neighbour is the next row of the filter, not of the whole list", async () => {
      show({ kinds: [kind(1, "Alpha", "rack"), kind(2, "Pump", "pump"), kind(3, "Hall", "hall", 2), kind(4, "Valve", "valve")], over: removingRow(2) });
      await screen.findByText("Pump", { selector: "td *" });
      await userEvent.click(filterButton("Unused 3"));
      await del("Pump"); // Hall is in use, so the filter hides it: the next shown row is Valve
      await waitFor(() => expect(screen.getByRole("button", { name: "Actions for Valve" })).toHaveFocus());
    });

    it("is the filter in use, with preventScroll, when no row is left to take it", async () => {
      const { calls, restore } = focusCalls();
      try {
        show({ kinds: [PUMP], over: removingRow(2) });
        await screen.findByText("Pump", { selector: "td *" });
        await del("Pump");
        await waitFor(() => expect(screen.getByRole("button", { name: /^All 0$/ })).toHaveFocus());
        expect(screen.getByRole("button", { name: "New kind" })).not.toHaveFocus();
        expect(calls.filter((c) => c.el === screen.getByRole("button", { name: /^All 0$/ })).at(-1)?.options).toEqual({ preventScroll: true });
      } finally {
        restore();
      }
    });

    it("is the filter in use when the neighbour left the list meanwhile (deleted elsewhere)", async () => {
      const { rows } = show({ kinds: FOUR, over: removingRow(2) });
      await screen.findByText("Pump", { selector: "td *" });
      await choose("Pump", "Delete");
      rows.splice(rows.findIndex((r) => r.id === 3), 1); // Hall, the neighbour, is gone when the list is read again
      await userEvent.click(within(dialog('Delete the kind "Pump"?')).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByRole("button", { name: /^All 2$/ })).toHaveFocus());
      expect(onTheBody()).toBe(false);
    });
  });

  it("gives the focus back to the menu button that opened it when the confirmation is cancelled, and never moves it to New kind", async () => {
    show();
    await screen.findByText("Pump", { selector: "td *" });
    await choose("Pump", "Delete");
    await userEvent.click(within(dialog('Delete the kind "Pump"?')).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Actions for Pump" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "New kind" })).not.toHaveFocus();
  });

  it("does not let New kind start a second dialog while the confirmation is open", async () => {
    show();
    await screen.findByText("Pump", { selector: "td *" });
    await choose("Pump", "Delete");
    expect(screen.getByRole("button", { name: "New kind" })).toBeDisabled();
  });
});

// ---- W7q: the list tools (Starter tag, filters, selection) ----

const starter = (id: number, name: string, icon: string, asset_count = 0): AssetKind => ({ ...kind(id, name, icon, asset_count), starter: true });
/** Six kinds: two starter (Rack in use, Room unused) and four of the person's own (Pump, Hall, Valve unused, Sensor in use). Unused: Pump, Room, Hall, Valve. */
const MIXED = [starter(1, "Rack", "rack", 12), kind(2, "Pump", "pump"), kind(3, "Sensor", "sensor", 1), starter(4, "Room", "room"), kind(5, "Hall", "hall"), kind(6, "Valve", "valve")];
const box = (name: string) => screen.getByRole("checkbox", { name: `Select ${name}` }) as HTMLInputElement;
const headerBox = () => screen.getByRole("checkbox", { name: "Select all shown kinds" }) as HTMLInputElement;
const filterButton = (name: string) => screen.getByRole("button", { name });
const namesShown = () => within(screen.getByRole("table")).getAllByRole("row").slice(1).map((r) => r.querySelector(".kind-label")!.textContent);
const selected = (text: string) => screen.getByText(text);
const shiftClick = async (name: string) => {
  const user = userEvent.setup(); // the direct userEvent.* calls each start with no key held; one instance keeps Shift down across the three steps
  await user.keyboard("{Shift>}");
  await user.click(box(name));
  await user.keyboard("{/Shift}");
};
const onTheBody = () => document.activeElement === document.body || document.activeElement === null;

describe("the Starter tag", () => {
  it("marks the kinds the server calls starter, beside the name and never inside it", async () => {
    show({ kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    const tag = within(rowOf("Rack")).getByText("Starter");
    expect(tag).toHaveClass("role-badge", "kind-starter");
    expect(tag.parentElement).toHaveClass("kind-cell");
    expect(tag.parentElement).toBe(rowOf("Rack").querySelector(".kind-label")!.parentElement); // a sibling of the label
    expect(rowOf("Rack").querySelector(".kind-label")).toHaveTextContent(/^Rack$/); // the label's whole text stays the name (the e2e rows are found by it)
    expect(within(rowOf("Rack").querySelector(".kind-label") as HTMLElement).queryByText("Starter")).not.toBeInTheDocument();
    expect(within(rowOf("Room")).getByText("Starter")).toBeInTheDocument();
  });

  it("is not on a kind of the person's own, however it is spelled", async () => {
    show({ kinds: [...MIXED, kind(7, "Rack 2", "rack", 1)] });
    await screen.findByText("Rack", { selector: "td *" });
    for (const name of ["Pump", "Sensor", "Hall", "Valve", "Rack 2"]) expect(within(rowOf(name)).queryByText("Starter")).not.toBeInTheDocument();
    expect(screen.getAllByText("Starter", { selector: "td span" })).toHaveLength(2);
  });

  it("is the server's word alone: a kind named like a starter one gets no tag from its name", async () => {
    show({ kinds: [kind(1, "Rack", "rack", 1), kind(2, "Server", "server")] }); // starter: false from the server
    await screen.findByText("Rack", { selector: "td *" });
    expect(screen.queryByText("Starter", { selector: "td span" })).not.toBeInTheDocument();
  });

  it("is also shown to a reader", async () => {
    show({ role: "viewer", kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    expect(within(rowOf("Rack")).getByText("Starter")).toBeInTheDocument();
  });
});

describe("the filter", () => {
  it("is a group named Show of four pressed-state buttons whose names carry the counts over the whole list", async () => {
    show({ kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    const group = screen.getByRole("group", { name: "Show" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["All 6", "Starter 2", "Yours 4", "Unused 4"]);
    expect(filterButton("All 6")).toHaveAttribute("aria-pressed", "true");
    for (const name of ["Starter 2", "Yours 4", "Unused 4"]) expect(filterButton(name)).toHaveAttribute("aria-pressed", "false");
    expect(namesShown()).toEqual(["Rack", "Pump", "Sensor", "Room", "Hall", "Valve"]);
  });

  it.each([
    ["Starter 2", ["Rack", "Room"]],
    ["Yours 4", ["Pump", "Sensor", "Hall", "Valve"]],
    ["Unused 4", ["Pump", "Room", "Hall", "Valve"]],
  ])("%s shows only its rows, in the list's order, and is the one pressed", async (name, rows) => {
    show({ kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    await userEvent.click(filterButton(name));
    expect(namesShown()).toEqual(rows);
    expect(filterButton(name)).toHaveAttribute("aria-pressed", "true");
    expect(filterButton("All 6")).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(filterButton("All 6"));
    expect(namesShown()).toHaveLength(6);
  });

  it("keeps the counts of the whole list while a filter is on and rows are ticked", async () => {
    show({ kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    await userEvent.click(filterButton("Unused 4"));
    await userEvent.click(box("Pump"));
    expect(within(screen.getByRole("group", { name: "Show" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["All 6", "Starter 2", "Yours 4", "Unused 4"]);
  });

  it("follows the list: a kind that gets an asset leaves Unused when the list is fetched again", async () => {
    const { rows } = show({ kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    await userEvent.click(filterButton("Unused 4"));
    rows.find((r) => r.name === "Hall")!.asset_count = 3; // an asset joins Hall
    await userEvent.click(await newKind()); // a write refetches the list
    await userEvent.type(screen.getByLabelText("Name"), "Dock");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(filterButton("All 7")).toBeInTheDocument());
    expect(filterButton("Unused 4")).toHaveAttribute("aria-pressed", "true"); // Hall left, Dock (unused) came
    expect(namesShown()).toEqual(["Pump", "Room", "Valve", "Dock"]);
  });

  it("says so when a filter shows nothing, keeps the table's header and the toolbar, and a disabled header box", async () => {
    show({ kinds: [starter(1, "Rack", "rack", 2), starter(2, "Room", "room")] });
    await screen.findByText("Rack", { selector: "td *" });
    await userEvent.click(filterButton("Yours 0"));
    expect(screen.getByText("No kinds match this filter.")).toBeInTheDocument();
    expect(screen.queryByText("Rack", { selector: "td *" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["", "Name", "Assets", ""]);
    expect(screen.getByRole("group", { name: "Show" })).toBeInTheDocument();
    expect(headerBox()).toHaveAttribute("aria-disabled", "true");
    expect(headerBox()).not.toBeDisabled();
    expect(headerBox()).not.toBeChecked();
    await userEvent.click(headerBox());
    expect(headerBox()).not.toBeChecked();
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    await userEvent.click(filterButton("All 2"));
    expect(screen.queryByText("No kinds match this filter.")).not.toBeInTheDocument();
  });

  it("forgets the picks when ANOTHER filter is chosen, and keeps them when the pressed one is pressed again", async () => {
    show({ kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    await userEvent.click(box("Pump"));
    await userEvent.click(box("Sensor"));
    expect(selected("2 selected")).toBeInTheDocument();
    await userEvent.click(filterButton("All 6"));
    expect(selected("2 selected")).toBeInTheDocument();
    await userEvent.click(filterButton("Yours 4"));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    await userEvent.click(filterButton("All 6"));
    expect(box("Pump")).not.toBeChecked(); // nothing hides in a row the filter took away
    expect(box("Sensor")).not.toBeChecked();
  });

  it("is on a reader's page too, with its counts", async () => {
    show({ role: "viewer", kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    await userEvent.click(filterButton("Starter 2"));
    expect(namesShown()).toEqual(["Rack", "Room"]);
  });
});

describe("the toolbar", () => {
  it("is drawn for a manager when the registry is empty, with zero counts and the way to add every kind", async () => {
    show({ kinds: [] });
    expect(await screen.findByText("No kinds yet.")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Show" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["All 0", "Starter 0", "Yours 0", "Unused 0"]);
    expect(screen.getByRole("button", { name: "Add all 39 data-centre kinds" })).toBeEnabled();
  });

  // Drawn for everybody once the list is in, as the skeleton already draws its room for a reader too: the empty note must not land where the toolbar was.
  it("is drawn for a reader of an empty registry too: the zero counts above the empty note, and nothing in the slot", async () => {
    show({ role: "viewer", kinds: [] });
    expect(await screen.findByText("No kinds yet.")).toBeInTheDocument();
    await accountKnown();
    const group = screen.getByRole("group", { name: "Show" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["All 0", "Starter 0", "Yours 0", "Unused 0"]);
    expect(group.closest(".kinds-toolbar")!.compareDocumentPosition(screen.getByText("No kinds yet.")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // the note is BELOW it
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add all 39 data-centre kinds" })).not.toBeInTheDocument();
    expect(document.querySelector(".kinds-slot")).toBeNull();
    expect(document.querySelector(".kinds-page [aria-live]")).toBeNull();
  });

  it("gives a reader the filter and nothing in the slot: no checkbox, no pack button, no announcer", async () => {
    show({ role: "operator", kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    await accountKnown();
    expect(screen.getByRole("group", { name: "Show" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add all 39 data-centre kinds" })).not.toBeInTheDocument();
    expect(document.querySelector(".kinds-slot")).toBeNull();
    expect(document.querySelector(".kinds-page [aria-live]")).toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(onTheBody()).toBe(true); // and no focus is moved for somebody who cannot pick
  });

  it("the idle slot's button adds the whole catalogue (set=all), toasts, and waits with aria-disabled, never the native attribute", async () => {
    const sent: string[] = [];
    const { toasts } = show({ over: { "POST /api/asset-kinds/starter-pack": ({ url }: { url: string }) => { sent.push(url); return { body: { added: ["UPS", "PDU"], already_there: 37 } }; } } });
    const button = await screen.findByRole("button", { name: "Add all 39 data-centre kinds" });
    const held = holdFetch((method, path) => method === "POST" && path === "/api/asset-kinds/starter-pack");
    await userEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"));
    expect(button).not.toBeDisabled();
    expect(button).toHaveFocus();
    await userEvent.click(button); // a second click while it runs sends nothing
    held.release();
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "success", text: "Added 2 kinds" }]));
    expect(sent).toEqual(["/api/asset-kinds/starter-pack?set=all"]);
  });

  it("the header's button still sends no query at all (the server's default pack)", async () => {
    const sent: string[] = [];
    show({ over: { "POST /api/asset-kinds/starter-pack": ({ url }: { url: string }) => { sent.push(url); return { body: { added: [], already_there: 16 } }; } } });
    await userEvent.click(await screen.findByRole("button", { name: "Add common data-centre kinds" }));
    await waitFor(() => expect(sent).toEqual(["/api/asset-kinds/starter-pack"]));
  });

  it("is off with the other buttons while a delete confirmation is open", async () => {
    show();
    await screen.findByText("Pump", { selector: "td *" });
    await choose("Pump", "Delete");
    expect(screen.getByRole("button", { name: "Add all 39 data-centre kinds" })).toBeDisabled();
  });
});

describe("picking kinds", () => {
  it("gives a manager a checkbox column: a named box in the header and in each row, and data on the row", async () => {
    show({ kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    expect(screen.getAllByRole("checkbox")).toHaveLength(7);
    expect(headerBox()).not.toBeChecked();
    expect(rowOf("Pump")).toHaveAttribute("data-kind-id", "2");
    expect(rowOf("Pump")).not.toHaveClass("is-picked");
  });

  it("ticks a row on a plain click and takes it off on the next, marks the row, and says how many in ONE live region", async () => {
    show({ kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    await userEvent.click(box("Pump"));
    expect(box("Pump")).toBeChecked();
    expect(rowOf("Pump")).toHaveClass("is-picked");
    const live = selected("1 selected");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveAttribute("aria-atomic", "true");
    expect(live).not.toHaveAttribute("role");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".kinds-page [aria-live]")).toHaveLength(1);
    await userEvent.click(box("Sensor"));
    expect(live).toHaveTextContent("2 selected"); // the same element: it was there from the start
    await userEvent.click(box("Pump"));
    expect(box("Pump")).not.toBeChecked();
    expect(rowOf("Pump")).not.toHaveClass("is-picked");
    expect(live).toHaveTextContent("1 selected");
    await userEvent.click(box("Sensor"));
    expect(live).toBeEmptyDOMElement();
    expect(document.querySelectorAll(".kinds-page [aria-live]")).toHaveLength(1);
  });

  it("swaps the idle button for the bar in the same slot: Select all unused, Delete, Clear", async () => {
    show({ kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    const slot = document.querySelector(".kinds-slot") as HTMLElement;
    expect(within(slot).getByRole("button", { name: "Add all 39 data-centre kinds" })).toBeInTheDocument();
    await userEvent.click(box("Pump"));
    expect(document.querySelector(".kinds-slot")).toBe(slot); // the same element
    expect(within(slot).queryByRole("button", { name: "Add all 39 data-centre kinds" })).not.toBeInTheDocument();
    expect(within(slot).getAllByRole("button").map((b) => b.textContent)).toEqual(["Select all unused", "Delete", "Clear"]);
    expect(within(slot).getByRole("button", { name: "Delete" })).not.toHaveAttribute("aria-disabled"); // on while no dialog is open
  });

  describe("the header box", () => {
    it("is unchecked, indeterminate while some rows are ticked, and checked when every shown row is", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      expect(headerBox()).not.toBeChecked();
      expect(headerBox()).not.toBePartiallyChecked();
      await userEvent.click(box("Pump"));
      expect(headerBox()).toBePartiallyChecked();
      expect(headerBox()).not.toBeChecked();
      for (const name of ["Rack", "Sensor", "Room", "Hall", "Valve"]) await userEvent.click(box(name));
      expect(headerBox()).toBeChecked();
      expect(headerBox()).not.toBePartiallyChecked();
    });

    it("ticks every shown row from unchecked or indeterminate, and clears them when all are ticked", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(headerBox());
      expect(selected("6 selected")).toBeInTheDocument();
      expect(screen.getAllByRole("checkbox").every((c) => (c as HTMLInputElement).checked)).toBe(true);
      await userEvent.click(headerBox());
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
      await userEvent.click(box("Pump")); // some -> all
      await userEvent.click(headerBox());
      expect(selected("6 selected")).toBeInTheDocument();
    });

    it("works on the shown rows only", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(filterButton("Starter 2"));
      await userEvent.click(headerBox());
      expect(selected("2 selected")).toBeInTheDocument();
      expect(headerBox()).toBeChecked();
      await userEvent.click(filterButton("All 6"));
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument(); // another filter forgets the picks
    });
  });

  describe("Shift and Space", () => {
    it("Shift-click ADDS the rows from the last ticked one to the clicked one, in the order shown", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(box("Pump"));
      await shiftClick("Room");
      expect(["Rack", "Pump", "Sensor", "Room", "Hall", "Valve"].filter((n) => box(n).checked)).toEqual(["Pump", "Sensor", "Room"]);
      expect(selected("3 selected")).toBeInTheDocument();
      await shiftClick("Valve"); // the anchor stays at Pump: the range grows
      expect(["Rack", "Pump", "Sensor", "Room", "Hall", "Valve"].filter((n) => box(n).checked)).toEqual(["Pump", "Sensor", "Room", "Hall", "Valve"]);
    });

    it("keeps the ticks outside the range and goes upwards too", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(box("Rack"));
      await userEvent.click(box("Hall"));
      await shiftClick("Sensor");
      expect(["Rack", "Pump", "Sensor", "Room", "Hall", "Valve"].filter((n) => box(n).checked)).toEqual(["Rack", "Sensor", "Room", "Hall"]);
    });

    it("goes by the shown order: under a filter, the rows it hides are not in the range", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(filterButton("Unused 4")); // Pump, Room, Hall, Valve
      await userEvent.click(box("Pump"));
      await shiftClick("Hall");
      expect(selected("3 selected")).toBeInTheDocument();
      await userEvent.click(filterButton("All 6"));
      await userEvent.click(box("Pump"));
      await userEvent.click(box("Sensor"));
      expect(selected("2 selected")).toBeInTheDocument(); // Sensor was never in the range
    });

    it("a Shift-click with no row ticked before acts like a plain click", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await shiftClick("Sensor");
      expect(selected("1 selected")).toBeInTheDocument();
      expect(box("Sensor")).toBeChecked();
    });

    it("Space on the focused box toggles it", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      box("Pump").focus();
      await userEvent.keyboard(" ");
      expect(box("Pump")).toBeChecked();
      await userEvent.keyboard(" ");
      expect(box("Pump")).not.toBeChecked();
    });

    it("Shift+Space on the focused box ADDS the range, the same as Shift-click, and ticks once", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(box("Pump"));
      box("Hall").focus();
      await userEvent.keyboard("{Shift>}[Space]{/Shift}");
      expect(["Rack", "Pump", "Sensor", "Room", "Hall", "Valve"].filter((n) => box(n).checked)).toEqual(["Pump", "Sensor", "Room", "Hall"]);
      expect(selected("4 selected")).toBeInTheDocument();
    });
  });

  describe("Select all unused", () => {
    it("ADDS every shown unused kind to what is ticked (a union) and keeps the used ones that were ticked", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(box("Sensor")); // in use
      await userEvent.click(screen.getByRole("button", { name: "Select all unused" }));
      expect(["Rack", "Pump", "Sensor", "Room", "Hall", "Valve"].filter((n) => box(n).checked)).toEqual(["Pump", "Sensor", "Room", "Hall", "Valve"]);
      expect(selected("5 selected")).toBeInTheDocument();
    });

    it("counts the same as the Unused filter, and works on the shown rows only", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(filterButton("Starter 2")); // Rack (in use), Room (unused)
      await userEvent.click(box("Rack"));
      await userEvent.click(screen.getByRole("button", { name: "Select all unused" }));
      expect(selected("2 selected")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Clear" }));
      await userEvent.click(filterButton("All 6"));
      await userEvent.click(box("Sensor"));
      await userEvent.click(screen.getByRole("button", { name: "Select all unused" }));
      expect(selected("5 selected")).toBeInTheDocument(); // Sensor + the 4 the Unused filter counts
    });

    it("is aria-disabled, with a click that does nothing, when no shown kind is unused", async () => {
      show({ kinds: [RACK, SENSOR] });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(box("Rack"));
      const button = screen.getByRole("button", { name: "Select all unused" });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).not.toBeDisabled();
      await userEvent.click(button);
      expect(selected("1 selected")).toBeInTheDocument();
      expect(box("Sensor")).not.toBeChecked();
    });
  });

  describe("Clear and Escape", () => {
    // The focus must never land on a button that writes: a second Enter (or a held one: its auto-repeat) on "Add all 39 data-centre kinds" would add
    // back every pack kind that was just deleted. The pressed filter button is always there, and Enter on it changes nothing.
    const addAllButton = () => screen.getByRole("button", { name: "Add all 39 data-centre kinds" });
    const packPosts = (sent: string[]) => ({ "POST /api/asset-kinds/starter-pack": ({ url }: { url: string }) => { sent.push(url); return { body: { added: ["UPS"], already_there: 38 } }; } });

    it("Clear forgets every tick, and the focus goes to the pressed filter button (never the body, never the pack button)", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(box("Pump"));
      await userEvent.click(box("Sensor"));
      await userEvent.click(screen.getByRole("button", { name: "Clear" }));
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
      expect(box("Pump")).not.toBeChecked();
      await waitFor(() => expect(filterButton("All 6")).toHaveFocus());
      expect(addAllButton()).not.toHaveFocus();
      expect(onTheBody()).toBe(false);
    });

    it("Clear by keyboard (Tab to it, Enter) lands on the pressed filter button too", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(box("Pump"));
      const clear = screen.getByRole("button", { name: "Clear" });
      clear.focus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(filterButton("All 6")).toHaveFocus());
      expect(addAllButton()).not.toHaveFocus();
    });

    it("lands on the filter in use, whichever it is", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(filterButton("Yours 4"));
      await userEvent.click(box("Pump"));
      await userEvent.click(screen.getByRole("button", { name: "Clear" }));
      await waitFor(() => expect(filterButton("Yours 4")).toHaveFocus());
    });

    it("a second Enter right after Clear by keyboard presses the filter button, which does nothing: no starter-pack call, nothing is added back", async () => {
      const sent: string[] = [];
      const { calls } = show({ kinds: MIXED, over: packPosts(sent) });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(box("Pump"));
      screen.getByRole("button", { name: "Clear" }).focus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(filterButton("All 6")).toHaveFocus());
      await userEvent.keyboard("{Enter}");
      expect(filterButton("All 6")).toHaveFocus();
      expect(filterButton("All 6")).toHaveAttribute("aria-pressed", "true");
      expect(sent).toEqual([]);
      expect(calls.filter((c) => c.path.includes("starter-pack"))).toEqual([]);
      expect(namesShown()).toHaveLength(6);
    });

    it("Escape clears the ticks; with the focus on a row box the focus stays there", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(box("Pump"));
      await userEvent.click(box("Sensor"));
      expect(box("Sensor")).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
      expect(box("Pump")).not.toBeChecked();
      expect(box("Sensor")).toHaveFocus();
      expect(onTheBody()).toBe(false);
    });

    it("Escape on a button of the bar takes the focus to the pressed filter button when the bar goes", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(box("Pump"));
      screen.getByRole("button", { name: "Delete" }).focus();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
      await waitFor(() => expect(filterButton("All 6")).toHaveFocus());
      expect(addAllButton()).not.toHaveFocus();
    });

    it("Enter right after Escape on the bar's Delete adds nothing back: no starter-pack call", async () => {
      const sent: string[] = [];
      const { calls } = show({ kinds: MIXED, over: packPosts(sent) });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(box("Pump"));
      screen.getByRole("button", { name: "Delete" }).focus();
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(filterButton("All 6")).toHaveFocus());
      await userEvent.keyboard("{Enter}");
      expect(filterButton("All 6")).toHaveFocus();
      expect(sent).toEqual([]);
      expect(calls.filter((c) => c.path.includes("starter-pack"))).toEqual([]);
    });

    describe("with the focus on the page body (the root's onKeyDown never sees a key pressed there)", () => {
      const tickTwoAndBlur = async () => {
        await screen.findByText("Rack", { selector: "td *" });
        await userEvent.click(box("Pump"));
        await userEvent.click(box("Sensor"));
        (document.activeElement as HTMLElement).blur();
        expect(onTheBody()).toBe(true);
      };

      it("Escape clears the ticks, and the focus goes to the pressed filter button (the same rule as for a bar button)", async () => {
        show({ kinds: MIXED });
        await tickTwoAndBlur();
        await userEvent.keyboard("{Escape}");
        expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
        expect(box("Pump")).not.toBeChecked();
        expect(box("Sensor")).not.toBeChecked();
        await waitFor(() => expect(filterButton("All 6")).toHaveFocus());
        expect(addAllButton()).not.toHaveFocus();
      });

      it("a second Enter after that adds nothing back", async () => {
        const sent: string[] = [];
        show({ kinds: MIXED, over: packPosts(sent) });
        await tickTwoAndBlur();
        await userEvent.keyboard("{Escape}");
        await waitFor(() => expect(filterButton("All 6")).toHaveFocus());
        await userEvent.keyboard("{Enter}");
        expect(sent).toEqual([]);
      });

      it("does nothing while the Edit dialog is open (its own Escape comes first)", async () => {
        show({ kinds: MIXED });
        await screen.findByText("Rack", { selector: "td *" });
        await userEvent.click(box("Pump"));
        await choose("Sensor", "Edit");
        expect(dialog("Edit kind")).toBeInTheDocument();
        (document.activeElement as HTMLElement).blur();
        expect(onTheBody()).toBe(true);
        await userEvent.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(selected("1 selected")).toBeInTheDocument();
      });

      it("does nothing while the delete confirmation is open", async () => {
        show({ kinds: MIXED });
        await screen.findByText("Rack", { selector: "td *" });
        await userEvent.click(box("Pump"));
        await choose("Hall", "Delete");
        (document.activeElement as HTMLElement).blur();
        expect(onTheBody()).toBe(true);
        await userEvent.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(selected("1 selected")).toBeInTheDocument();
      });

      it("does nothing while the bulk delete dialog is open", async () => {
        show({ kinds: MIXED });
        await screen.findByText("Rack", { selector: "td *" });
        await userEvent.click(box("Pump"));
        await userEvent.click(box("Hall"));
        await userEvent.click(screen.getByRole("button", { name: "Delete" }));
        expect(dialog("Delete 2 kinds?")).toBeInTheDocument();
        (document.activeElement as HTMLElement).blur();
        expect(onTheBody()).toBe(true);
        await userEvent.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(selected("2 selected")).toBeInTheDocument();
      });

      it("does nothing when nothing is ticked", async () => {
        show({ kinds: MIXED });
        await screen.findByText("Rack", { selector: "td *" });
        await userEvent.click(box("Pump"));
        await userEvent.click(box("Pump")); // ticked and unticked again
        (document.activeElement as HTMLElement).blur();
        await userEvent.keyboard("{Escape}");
        expect(onTheBody()).toBe(true); // no focus is moved when there was nothing to clear
        expect(addAllButton()).not.toHaveFocus();
      });

      it("leaves a key that something already handled alone (defaultPrevented)", async () => {
        show({ kinds: MIXED });
        await tickTwoAndBlur();
        const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        handled.preventDefault();
        act(() => { document.body.dispatchEvent(handled); }); // act: a state change the listener made would be flushed here, so the assertion below can see it
        expect(selected("2 selected")).toBeInTheDocument();
        await userEvent.keyboard("{Escape}"); // and the same key, unhandled, still clears them
        expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
      });

      it("ignores every other key", async () => {
        show({ kinds: MIXED });
        await tickTwoAndBlur();
        await userEvent.keyboard("{Enter}a{Tab}");
        expect(selected("2 selected")).toBeInTheDocument();
      });

      // The page root's onKeyDown owns every key pressed inside the page, so the document listener answers the body ALONE: a key pressed in an
      // element that is neither (a control outside the page's root) is left alone, which is also why one key is never handled twice.
      it("answers the body alone: a key pressed in a control outside the page leaves the ticks", async () => {
        show({ kinds: MIXED });
        await tickTwoAndBlur();
        const outside = document.body.appendChild(document.createElement("button"));
        outside.focus();
        try {
          await userEvent.keyboard("{Escape}");
          expect(selected("2 selected")).toBeInTheDocument();
        } finally {
          outside.remove();
        }
      });

      it("a key pressed on a row box is the page root's, and the focus stays on the box", async () => {
        show({ kinds: MIXED });
        await screen.findByText("Rack", { selector: "td *" });
        await userEvent.click(box("Pump"));
        await userEvent.click(box("Sensor"));
        await userEvent.keyboard("{Escape}");
        expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
        expect(box("Sensor")).toHaveFocus();
      });

      it("is taken off when the page goes away: every keydown listener it put on the document is removed again", async () => {
        const add = vi.spyOn(document, "addEventListener");
        const remove = vi.spyOn(document, "removeEventListener");
        const { unmount } = show({ kinds: MIXED });
        await screen.findByText("Rack", { selector: "td *" });
        await userEvent.click(box("Pump")); // the listener may be registered anew on a change
        unmount();
        const keydown = (calls: unknown[][]) => new Set(calls.filter(([type]) => type === "keydown").map(([, fn]) => fn));
        const added = keydown(add.mock.calls);
        const removed = keydown(remove.mock.calls);
        add.mockRestore();
        remove.mockRestore();
        expect(added.size).toBeGreaterThan(0);
        for (const fn of added) expect(removed.has(fn)).toBe(true);
      });
    });

    it("the header box clearing leaves the focus on the header box", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(headerBox());
      await userEvent.click(headerBox());
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
      expect(headerBox()).toHaveFocus();
    });

    it("Escape with nothing ticked does nothing", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      box("Pump").focus();
      await userEvent.keyboard("{Escape}");
      expect(box("Pump")).toHaveFocus();
    });

    it("Escape closes a row menu opened by a click and keeps the ticks", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(box("Pump"));
      await userEvent.click(within(rowOf("Sensor")).getByRole("button", { name: "Actions for Sensor" }));
      expect(screen.getByRole("menu", { name: "Actions for Sensor" })).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(selected("1 selected")).toBeInTheDocument();
      await userEvent.keyboard("{Escape}"); // the next one has no layer in front of it
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    });

    it("Escape closes a row menu opened with ArrowDown and keeps the ticks", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(box("Pump"));
      within(rowOf("Sensor")).getByRole("button", { name: "Actions for Sensor" }).focus();
      await userEvent.keyboard("{ArrowDown}");
      expect(screen.getByRole("menu", { name: "Actions for Sensor" })).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(selected("1 selected")).toBeInTheDocument();
    });

    it("Escape in the Edit dialog closes the dialog and keeps the ticks", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(box("Pump"));
      await choose("Sensor", "Edit");
      expect(dialog("Edit kind")).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(selected("1 selected")).toBeInTheDocument();
    });

    it("Escape in the delete confirmation closes it and keeps the ticks", async () => {
      show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(box("Pump"));
      await choose("Hall", "Delete");
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(selected("1 selected")).toBeInTheDocument();
    });
  });

  describe("when the list changes under the ticks", () => {
    it("forgets a ticked kind that is gone from the list and counts only the kinds still shown", async () => {
      const { rows } = show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(box("Pump"));
      await userEvent.click(box("Hall"));
      expect(selected("2 selected")).toBeInTheDocument();
      rows.splice(rows.findIndex((r) => r.name === "Hall"), 1); // deleted elsewhere
      await userEvent.click(await newKind()); // a write refetches the list
      await userEvent.type(screen.getByLabelText("Name"), "Dock");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByText("Hall", { selector: "td *" })).not.toBeInTheDocument());
      expect(selected("1 selected")).toBeInTheDocument();
      expect(box("Pump")).toBeChecked();
      // Forgotten for good, not just hidden: when a kind with that id comes back it is not ticked.
      rows.push(kind(5, "Hall", "hall"));
      await userEvent.click(await newKind());
      await userEvent.type(screen.getByLabelText("Name"), "Pier");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByText("Hall", { selector: "td *" });
      expect(box("Hall")).not.toBeChecked();
      expect(selected("1 selected")).toBeInTheDocument();
    });

    it("a kind that stops matching the filter (it got an asset) leaves the ticks with its row", async () => {
      const { rows } = show({ kinds: MIXED });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(filterButton("Unused 4"));
      await userEvent.click(box("Pump"));
      await userEvent.click(box("Hall"));
      rows.find((r) => r.name === "Pump")!.asset_count = 2;
      await userEvent.click(await newKind());
      await userEvent.type(screen.getByLabelText("Name"), "Dock");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByText("Pump", { selector: "td *" })).not.toBeInTheDocument());
      expect(selected("1 selected")).toBeInTheDocument();
    });
  });
});

describe("deleting several kinds", () => {
  /** The server's DELETE for every kind of the fake: the kind goes, and with move_to its assets join the target. Every url is recorded as sent, query included; `reply` may refuse one. */
  const deleting = (sent: string[], reply?: (id: number, fake: Fake) => { status: number; body?: unknown } | undefined) => (fake: Fake) =>
    Object.fromEntries(fake.rows.map((r) => [`DELETE /api/asset-kinds/${r.id}`, ({ url }: { url: string }) => {
      sent.push(url);
      const refused = reply?.(r.id, fake);
      if (refused) return refused;
      const row = fake.rows.find((x) => x.id === r.id)!;
      const target = fake.rows.find((x) => String(x.id) === new URL(url, "http://x").searchParams.get("move_to"));
      if (target) target.asset_count += row.asset_count;
      fake.rows.splice(fake.rows.indexOf(row), 1);
      return { status: 204 };
    }]));
  const tick = async (...names: string[]) => { for (const name of names) await userEvent.click(box(name)); };
  const press = async () => userEvent.click(screen.getByRole("button", { name: "Delete" }));
  const bulkDialog = (title: string) => screen.getByRole("dialog", { name: title });
  const confirm = async (title: string) => userEvent.click(within(bulkDialog(title)).getByRole("button", { name: "Delete" }));
  const noDialog = () => waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  const deletesOf = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method === "DELETE").map((c) => c.path);
  /** Every focus() call with its element and options (the real one still runs). */
  const spyFocus = () => {
    const calls: { el: Element; options: FocusOptions | undefined }[] = [];
    const real = HTMLElement.prototype.focus;
    const spy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      calls.push({ el: this, options });
      real.call(this, options);
    });
    return { calls, restore: () => spy.mockRestore() };
  };

  it("asks first, with the names, deletes the ticked kinds one by one in list order with no query, and says so", async () => {
    const sent: string[] = [];
    const { calls, toasts } = show({ kinds: MIXED, over: deleting(sent) });
    await screen.findByText("Rack", { selector: "td *" });
    await tick("Valve", "Pump", "Hall"); // not in list order, on purpose
    await press();
    const ask = bulkDialog("Delete 3 kinds?");
    expect(ask).toHaveAccessibleDescription("Pump, Hall, Valve. Assets that carry these names later get an automatic icon.");
    expect(deletesOf(calls)).toEqual([]);
    await confirm("Delete 3 kinds?");
    await noDialog();
    expect(sent).toEqual(["/api/asset-kinds/2", "/api/asset-kinds/5", "/api/asset-kinds/6"]);
    expect(toasts.calls).toEqual([{ kind: "success", text: "Deleted 3 kinds" }]);
    await waitFor(() => expect(screen.queryByText("Hall", { selector: "td *" })).not.toBeInTheDocument());
    expect(namesShown()).toEqual(["Rack", "Sensor", "Room"]);
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("checkbox").filter((b) => (b as HTMLInputElement).checked)).toHaveLength(0);
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/asset-kinds")).toHaveLength(2); // the list is read again ONCE, not after each deletion
  });

  it("puts the focus on the filter in use, with preventScroll, after the dialog closes (the bar and its Delete are gone)", async () => {
    const sent: string[] = [];
    show({ kinds: MIXED, over: deleting(sent) });
    await screen.findByText("Rack", { selector: "td *" });
    await tick("Pump", "Hall");
    await press();
    const spy = spyFocus();
    try {
      await confirm("Delete 2 kinds?");
      await noDialog();
      await waitFor(() => expect(screen.getByRole("button", { name: /^All 4$/ })).toHaveFocus());
      expect(onTheBody()).toBe(false);
      expect(spy.calls.filter((c) => c.el === screen.getByRole("button", { name: /^All 4$/ })).at(-1)?.options).toEqual({ preventScroll: true });
      expect(screen.getByRole("button", { name: "New kind" })).not.toHaveFocus();
    } finally {
      spy.restore();
    }
  });

  it("works from Select all unused: the dialog lists every unused kind", async () => {
    const sent: string[] = [];
    show({ kinds: MIXED, over: deleting(sent) });
    await screen.findByText("Rack", { selector: "td *" });
    await userEvent.click(box("Sensor")); // in use, ticked by hand: it stays in the selection
    await userEvent.click(screen.getByRole("button", { name: "Select all unused" }));
    await press();
    const ask = bulkDialog("Delete 5 kinds?");
    expect(within(ask).getByRole("combobox", { name: "Move the assets to" })).toBeInTheDocument(); // Sensor has an asset
    expect(within(ask).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a kind…", "Rack"]); // the only kind outside the selection
  });

  it("one ticked kind opens the same dialog with its singular title", async () => {
    show({ kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    await tick("Pump");
    await press();
    expect(bulkDialog("Delete 1 kind?")).toHaveAccessibleDescription("Pump. Assets that carry this name later get an automatic icon.");
  });

  describe("with kinds in use", () => {
    it("asks where the assets go (a select that leaves out the selection), waits for a choice, then sends move_to and the counts with those that are in use only", async () => {
      const sent: string[] = [];
      const { toasts } = show({ kinds: MIXED, over: deleting(sent) });
      await screen.findByText("Rack", { selector: "td *" });
      await tick("Rack", "Pump", "Sensor");
      await press();
      const ask = bulkDialog("Delete 3 kinds?");
      expect(ask).toHaveAccessibleDescription("2 of these kinds are used by 13 assets. Move those assets to another kind, then delete the 3.");
      const select = within(ask).getByLabelText("Move the assets to") as HTMLSelectElement;
      expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a kind…", "Hall", "Room", "Valve"]); // Rack, Pump and Sensor are not offered
      expect(within(ask).getByRole("button", { name: "Delete" })).toBeDisabled();
      await userEvent.selectOptions(select, "Room");
      expect(within(ask).getByRole("button", { name: "Delete" })).toBeEnabled();
      await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
      await noDialog();
      expect(sent).toEqual(["/api/asset-kinds/1?move_to=4&expect_assets=12", "/api/asset-kinds/2", "/api/asset-kinds/3?move_to=4&expect_assets=1"]);
      expect(toasts.calls).toEqual([{ kind: "success", text: "Deleted 3 kinds, 13 assets moved to Room" }]);
      await waitFor(() => expect(within(rowOf("Room")).getByText("13 assets")).toBeInTheDocument());
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    });

    it("is the blocked dialog when every kind is ticked and some are in use: why, and Close", async () => {
      const sent: string[] = [];
      const { calls } = show({ kinds: [RACK, PUMP], over: deleting(sent) });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(headerBox());
      await press();
      const ask = bulkDialog("Delete 2 kinds?");
      expect(within(ask).getByRole("alert")).toHaveTextContent("Every kind is selected, and 12 assets use some of them. Keep at least one kind to move them to.");
      expect(within(ask).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
      await userEvent.click(within(ask).getByRole("button", { name: "Close" }));
      await noDialog();
      expect(deletesOf(calls)).toEqual([]);
      expect(selected("2 selected")).toBeInTheDocument();
    });
  });

  describe("when something is refused", () => {
    it("a partial failure: the others go, an error toast names the kind and why, and the refused one stays ticked", async () => {
      const sent: string[] = [];
      const { toasts } = show({ kinds: MIXED, over: deleting(sent, (id, fake) => {
        if (id !== 5) return undefined;
        fake.rows.find((r) => r.id === 5)!.asset_count = 1; // an asset joined it meanwhile
        return { status: 409, body: { detail: "1 asset uses this kind now. Check the new count and try again.", assets: 1 } };
      }) });
      await screen.findByText("Rack", { selector: "td *" });
      await tick("Pump", "Hall", "Valve");
      await press();
      await confirm("Delete 3 kinds?");
      await noDialog();
      expect(sent).toEqual(["/api/asset-kinds/2", "/api/asset-kinds/5", "/api/asset-kinds/6"]); // the loop goes on after a refusal
      expect(toasts.calls).toEqual([{ kind: "error", text: 'Deleted 2 kinds. "Hall" could not be deleted: 1 asset uses it now.' }]);
      await waitFor(() => expect(namesShown()).toEqual(["Rack", "Sensor", "Room", "Hall"]));
      expect(selected("1 selected")).toBeInTheDocument();
      expect(box("Hall")).toBeChecked();
      await waitFor(() => expect(screen.getByRole("button", { name: /^All 4$/ })).toHaveFocus());
    });

    it("a refused kind that left the shown rows meanwhile (Unused: an asset joined it) is no longer ticked, and the toast still names it", async () => {
      const sent: string[] = [];
      const { toasts } = show({ kinds: MIXED, over: deleting(sent, (id, fake) => {
        if (id !== 5) return undefined;
        fake.rows.find((r) => r.id === 5)!.asset_count = 2;
        return { status: 409, body: { detail: "2 assets use this kind now.", assets: 2 } };
      }) });
      await screen.findByText("Rack", { selector: "td *" });
      await userEvent.click(filterButton("Unused 4"));
      await tick("Pump", "Hall");
      await press();
      await confirm("Delete 2 kinds?");
      await noDialog();
      expect(toasts.calls).toEqual([{ kind: "error", text: 'Deleted 1 kind. "Hall" could not be deleted: 2 assets use it now.' }]);
      await waitFor(() => expect(namesShown()).toEqual(["Room", "Valve"]));
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    });

    it("when every deletion fails the dialog stays open with the reason, nothing is toasted, and the kinds stay ticked", async () => {
      const sent: string[] = [];
      const { toasts } = show({ kinds: MIXED, over: deleting(sent, () => ({ status: 500, body: { detail: "database is down" } })) });
      await screen.findByText("Rack", { selector: "td *" });
      await tick("Pump", "Hall");
      await press();
      await confirm("Delete 2 kinds?");
      const ask = bulkDialog("Delete 2 kinds?");
      expect(await within(ask).findByRole("alert")).toHaveTextContent("Database is down");
      expect(within(ask).getByRole("button", { name: "Delete" })).toBeEnabled();
      expect(sent).toEqual(["/api/asset-kinds/2", "/api/asset-kinds/5"]);
      expect(toasts.calls).toEqual([]);
      expect(selected("2 selected")).toBeInTheDocument();
      expect(screen.getByText("Pump", { selector: "td *" })).toBeInTheDocument();
    });

    it("stops at a refusal of the role (403): the rest are not tried, and the toast says so", async () => {
      const sent: string[] = [];
      const { toasts } = show({ kinds: MIXED, over: deleting(sent, (id) => (id === 5 ? { status: 403, body: { detail: "insufficient permission" } } : undefined)) });
      await screen.findByText("Rack", { selector: "td *" });
      await tick("Pump", "Hall", "Valve");
      await press();
      await confirm("Delete 3 kinds?");
      await noDialog();
      expect(sent).toEqual(["/api/asset-kinds/2", "/api/asset-kinds/5"]); // Valve was never asked
      expect(toasts.calls).toEqual([{ kind: "error", text: "Deleted 1 kind. Stopped: Your role does not allow this. 2 were not tried." }]);
      await waitFor(() => expect(namesShown()).toEqual(["Rack", "Sensor", "Room", "Hall", "Valve"]));
      expect(selected("2 selected")).toBeInTheDocument(); // the two that were not deleted stay ticked
    });

    it("nothing deleted and the loop stopped (403 at once): the dialog stays open and says why", async () => {
      const sent: string[] = [];
      const { toasts } = show({ kinds: MIXED, over: deleting(sent, () => ({ status: 403, body: { detail: "insufficient permission" } })) });
      await screen.findByText("Rack", { selector: "td *" });
      await tick("Pump", "Hall");
      await press();
      await confirm("Delete 2 kinds?");
      expect(await within(bulkDialog("Delete 2 kinds?")).findByRole("alert")).toHaveTextContent("Your role does not allow this.");
      expect(sent).toEqual(["/api/asset-kinds/2"]);
      expect(toasts.calls).toEqual([]);
    });

    it("a kind another tab deleted (404) counts as gone: no error, and it leaves the ticks", async () => {
      const sent: string[] = [];
      const { toasts } = show({ kinds: MIXED, over: deleting(sent, (id) => (id === 5 ? { status: 404, body: { detail: "kind not found" } } : undefined)) });
      await screen.findByText("Rack", { selector: "td *" });
      await tick("Pump", "Hall");
      await press();
      await confirm("Delete 2 kinds?");
      await noDialog();
      expect(toasts.calls).toEqual([{ kind: "success", text: "Deleted 2 kinds" }]);
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    });
  });

  // The dialog's own freeze (it shows the kinds as they were at the press if the list loses them before the request is over) is pinned in
  // BulkDeleteKindsDialog.test.tsx with props: removing it there fails that test, but fails no page test, because here the mutation resolves
  // before the list's observers render, so the in-between state never shows. What the page owes is that the dialog belongs to the press: open and titled until the request is over.
  it("stays open with its own title while the request runs, and is never titled for fewer kinds, whatever the list does", async () => {
    const sent: string[] = [];
    const titles = new Set<string>();
    const watcher = new MutationObserver(() => document.querySelectorAll('[role="dialog"]').forEach((d) => titles.add(d.getAttribute("aria-label") ?? "")));
    const { toasts } = show({ kinds: MIXED, over: deleting(sent) });
    await screen.findByText("Rack", { selector: "td *" });
    await tick("Pump", "Hall");
    await press();
    watcher.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const held = holdFetch((method, path) => method === "GET" && path === "/api/asset-kinds"); // the refetch after the loop
    try {
      await confirm("Delete 2 kinds?");
      await waitFor(() => expect(sent).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(bulkDialog("Delete 2 kinds?")).toBeInTheDocument(); // busy, open, the list not yet read again
      held.release();
      await noDialog();
      await waitFor(() => expect(toasts.calls).toEqual([{ kind: "success", text: "Deleted 2 kinds" }]));
      expect([...titles]).toEqual(["Delete 2 kinds?"]); // never "Delete 0 kinds?", never closed early
    } finally {
      watcher.disconnect();
    }
  });

  it("Cancel closes it and gives the focus back to the bar's Delete, with the ticks and no request", async () => {
    const { calls } = show({ kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    await tick("Pump", "Hall");
    await press();
    expect(within(bulkDialog("Delete 2 kinds?")).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.click(within(bulkDialog("Delete 2 kinds?")).getByRole("button", { name: "Cancel" }));
    await noDialog();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "New kind" })).not.toHaveFocus();
    expect(selected("2 selected")).toBeInTheDocument();
    expect(deletesOf(calls)).toEqual([]);
  });

  it("Escape closes it and keeps the ticks: the dialog's Escape comes before the page's", async () => {
    show({ kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    await tick("Pump", "Hall");
    await press();
    await userEvent.keyboard("{Escape}");
    await noDialog();
    expect(selected("2 selected")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}"); // now no layer is open: this one clears them
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it("turns the header buttons off while it is open, like the single-kind confirmation (two dialogs would share Escape and the focus trap)", async () => {
    show({ kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    await tick("Pump");
    await press();
    expect(screen.getByRole("button", { name: "Add common data-centre kinds" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New kind" })).toBeDisabled();
  });

  it("stays open when the ticks are cleared behind it (it belongs to the press, not to the ticks), and Add all stays off", async () => {
    show({ kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    await tick("Pump", "Hall");
    await press();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    expect(bulkDialog("Delete 2 kinds?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add all 39 data-centre kinds" })).toBeDisabled();
    await userEvent.click(within(bulkDialog("Delete 2 kinds?")).getByRole("button", { name: "Cancel" }));
    await noDialog();
  });

  it("the bar's Delete does nothing while a dialog is open, and is not natively disabled", async () => {
    show({ kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    await tick("Pump");
    const bar = screen.getByRole("button", { name: "Delete" });
    await userEvent.click(bar);
    expect(bulkDialog("Delete 1 kind?")).toBeInTheDocument();
    // the dialog has a Delete too: the one of the bar is the one outside it
    const behind = screen.getAllByRole("button", { name: "Delete", hidden: true }).find((b) => b === bar)!;
    expect(behind).toHaveAttribute("aria-disabled", "true");
    expect(behind).not.toBeDisabled();
    await userEvent.click(behind);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("the header and the toolbar are also off while the Edit form is open, and New kind stays on while its own form is open (it is the form's opener)", async () => {
    show({ kinds: MIXED });
    await screen.findByText("Rack", { selector: "td *" });
    await userEvent.click(await newKind());
    expect(screen.getByRole("button", { name: "New kind" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add common data-centre kinds" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add all 39 data-centre kinds" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await newKind()).toHaveFocus(); // the form gave the focus back to its opener
    await choose("Sensor", "Edit");
    expect(screen.getByRole("button", { name: "New kind" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add common data-centre kinds" })).toBeDisabled();
  });
});

describe("the loading page", () => {
  const loading = (role: "admin" | "viewer") => {
    mockFetch({ ...authed(role), "GET /api/asset-kinds": { body: [RACK] } });
    const held = holdFetch((method, path) => method === "GET" && path === "/api/asset-kinds");
    renderWithProviders(<><AssetKindsPage /><SignedIn /></>, { route: "/assets/kinds", path: "/assets/kinds" });
    return held;
  };

  it("draws the toolbar's room and four columns for a manager, so nothing moves when the list arrives", async () => {
    const held = loading("admin");
    await accountKnown();
    const skeleton = screen.getByRole("status").closest("div")!.parentElement!;
    expect(skeleton.querySelector(".kinds-toolbar")).not.toBeNull();
    expect(document.querySelector(".kinds-toolbar .kinds-slot")).not.toBeNull();
    expect(document.querySelectorAll(".sk-table thead th")).toHaveLength(4);
    expect(document.querySelector(".sk-table colgroup")!.children).toHaveLength(4);
    held.release();
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(document.querySelectorAll(".kinds-toolbar")).toHaveLength(1);
  });

  it("draws two columns and no slot for a reader", async () => {
    const held = loading("viewer");
    await accountKnown();
    expect(document.querySelectorAll(".sk-table thead th")).toHaveLength(2);
    expect(document.querySelector(".kinds-toolbar .kinds-slot")).toBeNull();
    held.release();
    await screen.findByRole("table");
  });
});
