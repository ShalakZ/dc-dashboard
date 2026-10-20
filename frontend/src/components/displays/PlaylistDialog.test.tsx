import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { Asset, PlaylistRow } from "../../api/types";
import { authed } from "../../test/dashboardFixtures";
import { mockFetch, type Routes } from "../../test/fetchMock";
import { renderWithProviders } from "../../test/render";
import { spyToasts } from "../../test/toasts";
import { userFor } from "../../test/users";
import { DASHBOARDS, LIMITS, playlist, playlistItem } from "./displayFixtures";
import { PlaylistDialog } from "./PlaylistDialog";

const ASSETS: Asset[] = [
  { id: 11, parent_id: null, name: "Hall 1", kind: "generic", sort_order: 0 },
  { id: 12, parent_id: null, name: "Hall 2", kind: "generic", sort_order: 1 },
];
const WALL_A = playlist(1, "Wall A", [
  playlistItem(21, { position: 0, dashboard_id: 3, dashboard_name: "Hall A", seconds: 30 }),
  playlistItem(22, { position: 1, dashboard_id: 4, dashboard_name: "Hall B", seconds: 45, focus_asset_id: 11, focus_name: "Hall 1" }),
  playlistItem(23, { position: 2, dashboard_id: 5, dashboard_name: "Ops", seconds: 90 }),
]);

function Host({ existing }: { existing: PlaylistRow | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open it</button>
      {open && <PlaylistDialog playlist={existing} limits={LIMITS} onClose={() => setOpen(false)} />}
    </>
  );
}
/** `role` signs in a built-in role; `permissions` signs in a custom one that holds exactly those. */
async function show(existing: PlaylistRow | null, over: Routes = {}, permissions?: string[]) {
  const toasts = spyToasts();
  const calls = mockFetch({
    ...authed("admin"),
    ...(permissions ? { "GET /api/me": { body: userFor("Wall editor", { permissions: permissions as never }) } } : {}),
    "GET /api/dashboards": { body: DASHBOARDS },
    "GET /api/assets": { body: ASSETS },
    "POST /api/playlists": { status: 201, body: playlist(9, "New") },
    "PUT /api/playlists/1": { body: WALL_A },
    "GET /api/displays": { body: { displays: [], playlists: [], limits: LIMITS } },
    ...over,
  });
  renderWithProviders(<Host existing={existing} />, { route: "/displays", path: "*", toasts: toasts.api });
  await userEvent.click(await screen.findByRole("button", { name: "Open it" }));
  const dialog = await screen.findByRole("dialog", { name: existing ? "Edit playlist" : "New playlist" });
  // The dashboards are the select's options: wait until they are there.
  if (existing) await within(dialog).findAllByRole("option", { name: "Ops" });
  return { calls, toasts, dialog };
}
const writes = (calls: ReturnType<typeof mockFetch>) => calls.filter((c) => c.method === "POST" || c.method === "PUT");
const item = (dialog: HTMLElement, n: number) => within(dialog).getAllByRole("group", { name: new RegExp(`^Item ${n}:`) })[0];
const save = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: "Save" });

describe("PlaylistDialog: a new playlist", () => {
  it("opens with the focus on Name, no items, Add a dashboard and a Save that waits for a name", async () => {
    const { dialog } = await show(null);
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    expect(within(dialog).queryAllByRole("group")).toHaveLength(0);
    expect(within(dialog).getByText("0 of 20 dashboards")).toBeInTheDocument();
    expect(save(dialog)).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByText("Enter a name.")).toBeInTheDocument();
  });

  it("adds an item with a Dashboard placeholder, 60 seconds and the focus on its Dashboard; Save then waits for the dashboard (a new item needs one)", async () => {
    const { dialog } = await show(null);
    await userEvent.type(within(dialog).getByLabelText("Name"), "Wall C");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add a dashboard" }));
    const first = item(dialog, 1);
    const select = within(first).getByLabelText("Dashboard");
    expect(select).toHaveFocus();
    expect(within(first).getByRole("option", { name: "Choose a dashboard" })).toBeInTheDocument();
    expect(within(first).getByLabelText("Seconds on screen")).toHaveValue(60);
    expect(save(dialog)).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByText("Choose a dashboard for item 1.")).toBeInTheDocument();
    await userEvent.selectOptions(select, "Ops");
    expect(save(dialog)).not.toHaveAttribute("aria-disabled");
  });

  it("saves with a POST: no id on a new item, the dashboard, a null focus and the seconds as a number", async () => {
    const { dialog, calls, toasts } = await show(null);
    await userEvent.type(within(dialog).getByLabelText("Name"), "  Wall C ");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add a dashboard" }));
    await userEvent.selectOptions(within(item(dialog, 1)).getByLabelText("Dashboard"), "Hall B");
    await userEvent.clear(within(item(dialog, 1)).getByLabelText("Seconds on screen"));
    await userEvent.type(within(item(dialog, 1)).getByLabelText("Seconds on screen"), "20");
    await userEvent.click(save(dialog));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(writes(calls).map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/api/playlists", { name: "Wall C", items: [{ dashboard_id: 4, focus_asset_id: null, seconds: 20 }] }],
    ]);
    expect(toasts.calls).toEqual([{ kind: "success", text: "Playlist saved" }]);
    expect(screen.getByRole("button", { name: "Open it" })).toHaveFocus();
  });

  it("explains seconds out of range and does not send them", async () => {
    const { dialog, calls } = await show(null);
    await userEvent.type(within(dialog).getByLabelText("Name"), "Wall C");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add a dashboard" }));
    await userEvent.selectOptions(within(item(dialog, 1)).getByLabelText("Dashboard"), "Ops");
    await userEvent.clear(within(item(dialog, 1)).getByLabelText("Seconds on screen"));
    await userEvent.type(within(item(dialog, 1)).getByLabelText("Seconds on screen"), "5");
    expect(within(dialog).getByText("Seconds on screen for item 1 must be a whole number from 10 to 3600.")).toBeInTheDocument();
    await userEvent.click(save(dialog));
    expect(writes(calls)).toEqual([]);
  });

  it("stops adding at the limit: Add a dashboard is aria-disabled and does nothing", async () => {
    const { dialog } = await show(null);
    const add = within(dialog).getByRole("button", { name: "Add a dashboard" });
    for (let i = 0; i < 20; i += 1) await userEvent.click(add);
    expect(within(dialog).getAllByRole("group")).toHaveLength(20);
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).not.toBeDisabled();
    await userEvent.click(add);
    expect(within(dialog).getAllByRole("group")).toHaveLength(20);
    expect(within(dialog).getByText("20 of 20 dashboards")).toBeInTheDocument();
  });

  it("shows the server's refusal in the dialog, which stays open and keeps what was typed", async () => {
    const { dialog } = await show(null, { "POST /api/playlists": { status: 409, body: { detail: "a playlist with this name already exists" } } });
    await userEvent.type(within(dialog).getByLabelText("Name"), "Wall A");
    await userEvent.click(save(dialog));
    expect(await within(dialog).findByText("a playlist with this name already exists")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Wall A");
    await userEvent.type(within(dialog).getByLabelText("Name"), "2"); // typing again drops the stale refusal
    expect(within(dialog).queryByText("a playlist with this name already exists")).toBeNull();
  });

  it("Escape closes it and the focus goes back to the opener; Tab wraps from Save to Name", async () => {
    const { dialog } = await show(null);
    await userEvent.type(within(dialog).getByLabelText("Name"), "x");
    await userEvent.tab({ shift: true }); // Name is the first control: round to the last
    expect(save(dialog)).toHaveFocus();
    await userEvent.tab();
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open it" })).toHaveFocus();
  });
});

describe("PlaylistDialog: editing a playlist", () => {
  it("lists the items in order with their dashboard, focus and seconds, named for the dashboard", async () => {
    const { dialog } = await show(WALL_A);
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Wall A");
    expect(within(dialog).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Item 1: Hall A", "Item 2: Hall B", "Item 3: Ops"]);
    expect(within(item(dialog, 1)).getByLabelText("Dashboard")).toHaveValue("3");
    expect(within(item(dialog, 2)).getByLabelText("Seconds on screen")).toHaveValue(45);
    expect(within(item(dialog, 1)).getByRole("button", { name: "Focus Whole site" })).toBeInTheDocument();
    expect(within(item(dialog, 2)).getByRole("button", { name: "Focus Hall 1" })).toBeInTheDocument();
    expect(within(dialog).getByText("3 of 20 dashboards")).toBeInTheDocument();
  });

  it("sends every item back with its own id and its stored dashboard and focus, in the order shown", async () => {
    const { dialog, calls } = await show(WALL_A);
    await userEvent.click(save(dialog));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(writes(calls).map((c) => [c.method, c.path, c.body])).toEqual([
      ["PUT", "/api/playlists/1", { name: "Wall A", items: [
        { id: 21, dashboard_id: 3, focus_asset_id: null, seconds: 30 },
        { id: 22, dashboard_id: 4, focus_asset_id: 11, seconds: 45 },
        { id: 23, dashboard_id: 5, focus_asset_id: null, seconds: 90 },
      ] }],
    ]);
  });

  it("moves an item with the keyboard alone, keeps the focus on the button, and sends the new order with the same ids", async () => {
    const { dialog, calls } = await show(WALL_A);
    const down = within(item(dialog, 1)).getByRole("button", { name: "Move down Hall A" });
    down.focus();
    await userEvent.keyboard("{Enter}");
    expect(within(dialog).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Item 1: Hall B", "Item 2: Hall A", "Item 3: Ops"]);
    expect(within(item(dialog, 2)).getByRole("button", { name: "Move down Hall A" })).toHaveFocus();
    await userEvent.keyboard("{Enter}"); // once more: Hall A is last now
    expect(within(item(dialog, 3)).getByRole("button", { name: "Move down Hall A" })).toHaveFocus();
    expect(within(item(dialog, 3)).getByRole("button", { name: "Move down Hall A" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Enter}"); // at the end it does nothing
    expect(within(dialog).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Item 1: Hall B", "Item 2: Ops", "Item 3: Hall A"]);
    await userEvent.click(within(item(dialog, 3)).getByRole("button", { name: "Move up Hall A" }));
    expect(within(item(dialog, 2)).getByRole("button", { name: "Move up Hall A" })).toHaveFocus();
    await userEvent.click(save(dialog));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect((writes(calls)[0].body as { items: { id: number }[] }).items.map((i) => i.id)).toEqual([22, 21, 23]);
  });

  it("the first item cannot move up and the last cannot move down (aria-disabled, not disabled)", async () => {
    const { dialog } = await show(WALL_A);
    expect(within(item(dialog, 1)).getByRole("button", { name: "Move up Hall A" })).toHaveAttribute("aria-disabled", "true");
    expect(within(item(dialog, 1)).getByRole("button", { name: "Move up Hall A" })).not.toBeDisabled();
    expect(within(item(dialog, 3)).getByRole("button", { name: "Move down Ops" })).toHaveAttribute("aria-disabled", "true");
    expect(within(item(dialog, 2)).getByRole("button", { name: "Move up Hall B" })).not.toHaveAttribute("aria-disabled");
  });

  it("removes an item, puts the focus on the next one's Remove, and does not send the removed id", async () => {
    const { dialog, calls } = await show(WALL_A);
    await userEvent.click(within(item(dialog, 2)).getByRole("button", { name: "Remove Hall B" }));
    expect(within(dialog).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Item 1: Hall A", "Item 2: Ops"]);
    expect(within(item(dialog, 2)).getByRole("button", { name: "Remove Ops" })).toHaveFocus();
    await userEvent.click(within(item(dialog, 2)).getByRole("button", { name: "Remove Ops" }));
    expect(within(item(dialog, 1)).getByRole("button", { name: "Remove Hall A" })).toHaveFocus();
    await userEvent.click(within(item(dialog, 1)).getByRole("button", { name: "Remove Hall A" }));
    expect(within(dialog).getByRole("button", { name: "Add a dashboard" })).toHaveFocus();
    expect(writes(calls)).toEqual([]);
  });

  it("gives Seconds on screen its tip", async () => {
    const { dialog } = await show(WALL_A);
    await userEvent.click(within(item(dialog, 1)).getByRole("button", { name: "What does this mean?" }));
    expect(await screen.findByText("How long this dashboard stays on screen before the next one. 10 to 3600.")).toBeInTheDocument();
  });
});

describe("PlaylistDialog: an item the screens skip", () => {
  const SKIPPING = playlist(1, "Wall A", [
    playlistItem(31, { position: 0, dashboard_id: null, dashboard_name: "Old ops", skipped: "dashboard_deleted", focus_asset_id: null }),
    playlistItem(32, { position: 1, dashboard_id: 3, dashboard_name: "Hall A", focus_asset_id: 99, focus_name: "Hall 9", skipped: "focus_gone" }),
    playlistItem(33, { position: 2, dashboard_id: 4, dashboard_name: "Hall B", skipped: "no_widgets" }),
  ]);

  it("says why under each item, and shows a placeholder where the dashboard is gone", async () => {
    const { dialog } = await show(SKIPPING);
    expect(within(item(dialog, 1)).getByText("The dashboard Old ops was deleted")).toBeInTheDocument();
    expect(within(item(dialog, 1)).getByLabelText("Dashboard")).toHaveValue("");
    expect(within(item(dialog, 1)).getByRole("option", { name: "Choose a dashboard" })).toBeInTheDocument();
    expect(within(item(dialog, 2)).getByText("The asset Hall 9 no longer exists")).toBeInTheDocument();
    expect(within(item(dialog, 3)).getByText("This dashboard has no widgets")).toBeInTheDocument();
  });

  it("saves untouched: the gone dashboard goes back as null and the vanished focus as it was, with each id", async () => {
    const { dialog, calls } = await show(SKIPPING);
    expect(save(dialog)).not.toHaveAttribute("aria-disabled"); // an old item with no dashboard does not block Save
    await userEvent.click(save(dialog));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0].body).toEqual({ name: "Wall A", items: [
      { id: 31, dashboard_id: null, focus_asset_id: null, seconds: 60 },
      { id: 32, dashboard_id: 3, focus_asset_id: 99, seconds: 60 },
      { id: 33, dashboard_id: 4, focus_asset_id: null, seconds: 60 },
    ] });
  });

  it("lets the administrator change the dashboard (the sentence goes) or remove the item", async () => {
    const { dialog, calls } = await show(SKIPPING);
    await userEvent.selectOptions(within(item(dialog, 1)).getByLabelText("Dashboard"), "Ops");
    expect(within(dialog).queryByText("The dashboard Old ops was deleted")).toBeNull();
    await userEvent.click(within(item(dialog, 3)).getByRole("button", { name: "Remove Hall B" }));
    await userEvent.click(save(dialog));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect((writes(calls)[0].body as { items: unknown[] }).items).toEqual([
      { id: 31, dashboard_id: 5, focus_asset_id: null, seconds: 60 },
      { id: 32, dashboard_id: 3, focus_asset_id: 99, seconds: 60 },
    ]);
  });
});

describe("PlaylistDialog: the Focus field", () => {
  it("opens a nested picker, drafts the choice, and applies it on Choose; the focus returns to the Focus button", async () => {
    const { dialog, calls } = await show(WALL_A);
    const focus = within(item(dialog, 1)).getByRole("button", { name: "Focus Whole site" });
    await userEvent.click(focus);
    const picker = await screen.findByRole("dialog", { name: "Focus for Hall A" });
    await userEvent.click(await within(picker).findByRole("radio", { name: "Hall 2" }));
    expect(within(item(dialog, 1)).getByRole("button", { name: "Focus Whole site" })).toBeInTheDocument(); // only a draft until Choose
    await userEvent.click(within(picker).getByRole("button", { name: "Choose" }));
    expect(screen.queryByRole("dialog", { name: "Focus for Hall A" })).toBeNull();
    expect(within(item(dialog, 1)).getByRole("button", { name: "Focus Hall 2" })).toHaveFocus();
    await userEvent.click(save(dialog));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect((writes(calls)[0].body as { items: { id: number; focus_asset_id: number | null }[] }).items.map((i) => [i.id, i.focus_asset_id])).toEqual([[21, 12], [22, 11], [23, null]]);
  });

  it("Whole site clears a focus", async () => {
    const { dialog, calls } = await show(WALL_A);
    await userEvent.click(within(item(dialog, 2)).getByRole("button", { name: "Focus Hall 1" }));
    const picker = await screen.findByRole("dialog", { name: "Focus for Hall B" });
    await within(picker).findByRole("radio", { name: "Hall 1" });
    expect(within(picker).getByRole("radio", { name: "Hall 1" })).toBeChecked();
    await userEvent.click(within(picker).getByRole("button", { name: "Whole site" }));
    await userEvent.click(within(picker).getByRole("button", { name: "Choose" }));
    expect(within(item(dialog, 2)).getByRole("button", { name: "Focus Whole site" })).toBeInTheDocument();
    await userEvent.click(save(dialog));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect((writes(calls)[0].body as { items: { id: number; focus_asset_id: number | null }[] }).items[1]).toEqual({ id: 22, dashboard_id: 4, focus_asset_id: null, seconds: 45 });
  });

  it("Escape closes only the picker; a second Escape closes the playlist dialog", async () => {
    const { dialog } = await show(WALL_A);
    await userEvent.click(within(item(dialog, 1)).getByRole("button", { name: "Focus Whole site" }));
    const picker = await screen.findByRole("dialog", { name: "Focus for Hall A" });
    await within(picker).findByRole("radio", { name: "Hall 2" });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Focus for Hall A" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Edit playlist" })).toBeInTheDocument();
    expect(within(item(dialog, 1)).getByRole("button", { name: "Focus Whole site" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("has no Focus field at all without assets.view, asks for no assets, and still sends each stored focus back", async () => {
    const { dialog, calls } = await show(WALL_A, {}, ["displays.manage", "dashboards.view"]);
    expect(within(dialog).queryByText("Focus")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /^Focus/ })).toBeNull();
    await userEvent.click(save(dialog));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect((writes(calls)[0].body as { items: { id: number; focus_asset_id: number | null }[] }).items.map((i) => [i.id, i.focus_asset_id])).toEqual([[21, null], [22, 11], [23, null]]);
    expect(calls.some((c) => c.path === "/api/assets")).toBe(false);
  });

  it("shows the server's 403 when a role without assets.view saves a playlist that names a focus", async () => {
    const { dialog } = await show(WALL_A, { "PUT /api/playlists/1": { status: 403, body: { detail: "choosing a focus needs permission to see assets" } } }, ["displays.manage", "dashboards.view"]);
    await userEvent.click(save(dialog));
    expect(await within(dialog).findByText("choosing a focus needs permission to see assets")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Edit playlist" })).toBeInTheDocument();
  });

  it("writes (hidden) for a name the caller may not read, and only then", async () => {
    const hidden = playlist(1, "Wall A", [playlistItem(41, { dashboard_id: 3, dashboard_name: null, focus_asset_id: 11, focus_name: null })]);
    const { dialog } = await show(hidden, { "GET /api/dashboards": { body: DASHBOARDS.filter((d) => d.id === 5) } }); // the list lacks dashboard 3
    expect(within(dialog).getAllByRole("group")[0]).toHaveAccessibleName("Item 1: (hidden)");
    expect(within(item(dialog, 1)).getByRole("button", { name: "Focus (hidden)" })).toBeInTheDocument();
    expect(within(item(dialog, 1)).getByLabelText("Dashboard")).toHaveValue("3");
  });
});
