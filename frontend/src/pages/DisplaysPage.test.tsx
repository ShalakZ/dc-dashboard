import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NO_PLAYLISTS } from "../components/displays/PlaylistsCard";
import { NO_SCREENS } from "../components/displays/ScreensCard";
import { DASHBOARDS, displaysList, LIMITS, playlist, playlistItem, screenRow } from "../components/displays/displayFixtures";
import { authed } from "../test/dashboardFixtures";
import { mockFetch, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { spyToasts } from "../test/toasts";
import { DisplaysPage } from "./DisplaysPage";

const NOW = new Date("2026-10-20T12:00:00Z"); // 15:00 in the site's zone (Asia/Qatar), so "3 min ago" never crosses midnight
const WALL_A = playlist(1, "Wall A", [
  playlistItem(21, { dashboard_id: 3, dashboard_name: "Hall A" }),
  playlistItem(22, { position: 1, dashboard_id: null, dashboard_name: "Ops", skipped: "dashboard_deleted" }),
  playlistItem(23, { position: 2, dashboard_id: 4, dashboard_name: "Hall B", skipped: "no_widgets" }),
], { display_count: 1 });
const WALL_B = playlist(2, "Wall B", [playlistItem(31)], { display_count: 0 });
const HALL_TV = screenRow(1, "Hall TV", 1, "Wall A", { last_seen_at: "2026-10-20T11:57:00+00:00", last_client: "10.0.0.12" });
const LOBBY = screenRow(2, "Lobby", 2, "Wall B");
const OLD = screenRow(3, "Old", 1, "Wall A", { status: "revoked", revoked_at: "2026-10-19T08:00:00+00:00", last_seen_at: "2026-10-19T07:00:00+00:00" });
const FULL = displaysList({ displays: [HALL_TV, LOBBY, OLD], playlists: [WALL_A, WALL_B] });

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }); }); // only the clock: fake timers would hang React Query
afterEach(() => { vi.useRealTimers(); });

function show(list = FULL, over: Routes = {}) {
  const toasts = spyToasts();
  const calls = mockFetch({
    ...authed("admin"),
    "GET /api/displays": { body: list },
    "GET /api/dashboards": { body: DASHBOARDS },
    "GET /api/assets": { body: [] },
    "GET /api/audit": { body: { items: [], total: 0 } },
    ...over,
  });
  renderWithProviders(<DisplaysPage />, { route: "/displays", path: "*", toasts: toasts.api });
  return { calls, toasts };
}
const row = (name: string) => screen.getByRole("cell", { name }).closest("tr")!;
const reads = (calls: ReturnType<typeof mockFetch>) => calls.filter((c) => c.method === "GET" && c.path === "/api/displays").length;
const writes = (calls: ReturnType<typeof mockFetch>) => calls.filter((c) => c.method !== "GET");
async function chooseFromMenu(name: string, item: string) {
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${name}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}

describe("DisplaysPage: what it shows", () => {
  it("has one h1, the summary strip and the two cards", async () => {
    show();
    expect(await screen.findByRole("heading", { level: 1, name: "Displays" })).toBeInTheDocument();
    const tile = (title: string) => screen.getAllByText(title).map((el) => el.closest(".tile")).find((el): el is HTMLElement => el !== null)!; // "Active" is also a status chip
    await screen.findByRole("heading", { level: 2, name: "Screens" });
    expect(screen.getByRole("heading", { level: 2, name: "Playlists" })).toBeInTheDocument();
    expect(within(tile("Active")).getByText("2")).toBeInTheDocument();
    expect(within(tile("Revoked")).getByText("1")).toBeInTheDocument();
    expect(within(tile("Never connected")).getByText("1")).toBeInTheDocument(); // Lobby: an active link nobody opened
    expect(within(tile("Playlists")).getByText("2")).toBeInTheDocument();
  });

  it("lists each screen with its playlist, status and when it last connected", async () => {
    show();
    await screen.findByRole("cell", { name: "Hall TV" });
    expect(within(row("Hall TV")).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Hall TV", "Wall A", "Active", "3 min ago from 10.0.0.12", ""]);
    expect(within(row("Lobby")).getByText("Never connected")).toBeInTheDocument();
    expect(within(row("Old")).getByText("Revoked")).toBeInTheDocument();
    expect(within(row("Old")).getByText("Yesterday")).toBeInTheDocument(); // no address was kept
  });

  it("draws the Last connected cell as two lines, the time and then the address, with the whole sentence as its title", async () => {
    show();
    await screen.findByRole("cell", { name: "Hall TV" });
    const cell = within(row("Hall TV")).getAllByRole("cell")[3];
    expect(cell).toHaveAttribute("title", "Last connected 3 min ago from 10.0.0.12");
    expect(cell.querySelector(".displays-from")).toHaveTextContent("from 10.0.0.12");
    expect(cell.firstElementChild).toHaveTextContent("3 min ago");
    expect(within(row("Old")).getAllByRole("cell")[3].querySelector(".displays-from")).toBeNull(); // no address, one line
  });

  it("lists each playlist with its dashboards and, when some are skipped, a line for each saying why", async () => {
    show();
    const card = (await screen.findByRole("heading", { level: 2, name: "Playlists" })).closest("section")!;
    const wallA = within(card).getByRole("cell", { name: "Wall A" }).closest("tr")!;
    expect(within(wallA).getByText("2 items are skipped")).toBeInTheDocument();
    expect(within(wallA).getByText("The dashboard Ops was deleted")).toBeInTheDocument();
    expect(within(wallA).getByText("This dashboard has no widgets")).toBeInTheDocument();
    const wallB = within(card).getByRole("cell", { name: "Wall B" }).closest("tr")!;
    expect(within(wallB).getByText("1 dashboard")).toBeInTheDocument();
    expect(within(wallB).queryByText(/skipped/)).toBeNull();
  });

  it("says what to do when there are no screens and no playlists, and New display waits with its reason", async () => {
    show(displaysList());
    expect(await screen.findByText(NO_SCREENS)).toBeInTheDocument();
    expect(NO_SCREENS).toBe("No screens yet. Make a playlist, then add a display.");
    expect(screen.getByText(NO_PLAYLISTS)).toBeInTheDocument();
    expect(NO_PLAYLISTS).toBe("No playlists yet.");
    const newDisplay = screen.getByRole("button", { name: "New display" });
    expect(newDisplay).toHaveAttribute("aria-disabled", "true");
    expect(newDisplay).not.toBeDisabled();
    expect(newDisplay).toHaveAttribute("title", "Make a playlist first");
    expect(newDisplay).toHaveAccessibleDescription("Make a playlist first");
    await userEvent.click(newDisplay);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("draws the loading page with the tiles and both cards, and no real text", async () => {
    mockFetch({ ...authed("admin"), "GET /api/displays": { body: FULL } });
    const held = holdFetch((method, path) => method === "GET" && path === "/api/displays");
    renderWithProviders(<DisplaysPage />, { route: "/displays", path: "*" });
    expect(await screen.findByRole("heading", { level: 1, name: "Displays" })).toBeInTheDocument();
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("Loading displays");
    expect(region.querySelectorAll(".tile")).toHaveLength(4);
    expect(region.querySelectorAll(".page-card")).toHaveLength(2);
    expect(region.querySelectorAll("tbody tr")).toHaveLength(6);
    expect(screen.queryByText("Hall TV")).toBeNull();
    held.release();
    expect(await screen.findByRole("cell", { name: "Hall TV" })).toBeInTheDocument();
  });

  it("shows the server's sentence when the list cannot be read", async () => {
    show(FULL, { "GET /api/displays": { status: 500, body: { detail: "the displays could not be read" } } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the displays: the displays could not be read");
  });
});

describe("DisplaysPage: the row menus", () => {
  it("gives a screen Rename, Change playlist and Revoke in its menu and Delete as the trash button named for it", async () => {
    show();
    await screen.findByRole("cell", { name: "Hall TV" });
    const trash = within(row("Hall TV")).getByRole("button", { name: "Delete Hall TV" });
    expect(trash).toHaveClass("trash-btn");
    await userEvent.click(within(row("Hall TV")).getByRole("button", { name: "Actions for Hall TV" }));
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["Rename", "Change playlist", "Revoke"]);
  });

  it("turns Revoke off for a screen that is revoked already", async () => {
    show();
    await screen.findByRole("cell", { name: "Old" });
    await userEvent.click(within(row("Old")).getByRole("button", { name: "Actions for Old" }));
    expect(await screen.findByRole("menuitem", { name: "Revoke" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeEnabled();
  });

  it("gives a playlist Edit in its menu and the trash button named for it", async () => {
    show();
    await screen.findByRole("cell", { name: "Hall TV" });
    await userEvent.click(screen.getByRole("button", { name: "Actions for Wall B" }));
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["Edit"]);
    expect(screen.getByRole("button", { name: "Delete Wall B" })).toHaveClass("trash-btn");
  });
});

describe("DisplaysPage: Revoke", () => {
  it("asks first, in the page's words, and does nothing on Cancel or Escape", async () => {
    const { calls } = show();
    await screen.findByRole("cell", { name: "Hall TV" });
    await chooseFromMenu("Hall TV", "Revoke");
    const dialog = await screen.findByRole("dialog", { name: "Revoke Hall TV?" });
    expect(dialog).toHaveTextContent("Revoke Hall TV?The screen stops showing dashboards within a minute.");
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel", "Revoke"]);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Actions for Hall TV" })).toHaveFocus();
    await chooseFromMenu("Hall TV", "Revoke");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writes(calls)).toEqual([]);
  });

  it("revokes with a POST, tells it in a toast and reads the list again", async () => {
    const { calls, toasts } = show(FULL, { "POST /api/displays/1/revoke": { body: { ...HALL_TV, status: "revoked" } } });
    await screen.findByRole("cell", { name: "Hall TV" });
    const before = reads(calls);
    await chooseFromMenu("Hall TV", "Revoke");
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Revoke Hall TV?" })).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes(calls).map((c) => [c.method, c.path])).toEqual([["POST", "/api/displays/1/revoke"]]);
    expect(toasts.calls).toEqual([{ kind: "success", text: "Hall TV revoked" }]);
    expect(reads(calls)).toBe(before + 1);
  });

  it("keeps the dialog open with the server's sentence when it is refused, and still reads the list again", async () => {
    const { calls } = show(FULL, { "POST /api/displays/1/revoke": { status: 403, body: { detail: "this display belongs to another site" } } });
    await screen.findByRole("cell", { name: "Hall TV" });
    const before = reads(calls);
    await chooseFromMenu("Hall TV", "Revoke");
    const dialog = await screen.findByRole("dialog", { name: "Revoke Hall TV?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This display belongs to another site");
    await waitFor(() => expect(reads(calls)).toBe(before + 1)); // on failure too: the page may be out of date
  });
});

describe("DisplaysPage: Rename and Change playlist", () => {
  it("renames with a PUT of the new name and says what a taken name is", async () => {
    const { calls } = show(FULL, { "PUT /api/displays/1": { status: 409, body: { detail: "a display with this name already exists" } } });
    await screen.findByRole("cell", { name: "Hall TV" });
    await chooseFromMenu("Hall TV", "Rename");
    const dialog = await screen.findByRole("dialog", { name: "Rename display" });
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Hall TV");
    await userEvent.clear(within(dialog).getByLabelText("Name"));
    await userEvent.type(within(dialog).getByLabelText("Name"), "Lobby");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("A display with this name already exists")).toBeInTheDocument();
    expect(writes(calls).map((c) => [c.method, c.path, c.body])).toEqual([["PUT", "/api/displays/1", { name: "Lobby" }]]);
  });

  it("changes the playlist with a PUT of the playlist id, closes, and the focus returns to the row menu", async () => {
    const { calls, toasts } = show(FULL, { "PUT /api/displays/1": { body: { ...HALL_TV, playlist_id: 2, playlist_name: "Wall B" } } });
    await screen.findByRole("cell", { name: "Hall TV" });
    await chooseFromMenu("Hall TV", "Change playlist");
    const dialog = await screen.findByRole("dialog", { name: "Change playlist" });
    expect(within(dialog).getByLabelText("Playlist")).toHaveFocus();
    await userEvent.selectOptions(within(dialog).getByLabelText("Playlist"), "Wall B");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes(calls).map((c) => [c.method, c.path, c.body])).toEqual([["PUT", "/api/displays/1", { playlist_id: 2 }]]);
    expect(toasts.calls).toEqual([{ kind: "success", text: "Playlist changed" }]);
    expect(screen.getByRole("button", { name: "Actions for Hall TV" })).toHaveFocus();
  });

  it("sends nothing when the name was not changed", async () => {
    const { calls } = show();
    await screen.findByRole("cell", { name: "Hall TV" });
    await chooseFromMenu("Hall TV", "Rename");
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Rename display" })).getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writes(calls)).toEqual([]);
  });
});

describe("DisplaysPage: Delete", () => {
  it("deletes a screen with a DELETE after asking, and the focus goes to the heading", async () => {
    const { calls, toasts } = show(FULL, { "DELETE /api/displays/2": { status: 204 } });
    await screen.findByRole("cell", { name: "Lobby" });
    await userEvent.click(within(row("Lobby")).getByRole("button", { name: "Delete Lobby" }));
    const dialog = await screen.findByRole("dialog", { name: 'Delete display "Lobby"?' });
    expect(dialog).toHaveTextContent("Its link stops working for good.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes(calls).map((c) => [c.method, c.path])).toEqual([["DELETE", "/api/displays/2"]]);
    expect(toasts.calls).toEqual([{ kind: "success", text: 'Display "Lobby" deleted' }]);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Displays" })).toHaveFocus());
  });

  it("shows the server's 409 inside the dialog for a playlist a screen still shows, instead of closing", async () => {
    const { calls } = show(FULL, { "DELETE /api/playlists/1": { status: 409, body: { detail: "this playlist is shown by: Hall TV, Old (revoked)" } } });
    await screen.findByRole("cell", { name: "Hall TV" });
    await userEvent.click(screen.getByRole("button", { name: "Delete Wall A" }));
    const dialog = await screen.findByRole("dialog", { name: 'Delete playlist "Wall A"?' });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This playlist is shown by: Hall TV, Old (revoked). Change their playlist or delete them first.");
    expect(screen.getByRole("dialog", { name: 'Delete playlist "Wall A"?' })).toBeInTheDocument();
    expect(writes(calls).map((c) => [c.method, c.path])).toEqual([["DELETE", "/api/playlists/1"]]);
  });

  it("keeps the refusal in a slot of its own that is there before it lands, so Cancel and Delete do not move, and gives it no second copy in the dialog", async () => {
    const detail = "this playlist is shown by 10 screens: A, B, C and 7 more. Change their playlist or delete them first.";
    show(FULL, { "DELETE /api/playlists/1": { status: 409, body: { detail } } });
    await screen.findByRole("cell", { name: "Hall TV" });
    await userEvent.click(screen.getByRole("button", { name: "Delete Wall A" })); // Wall A is shown by a screen, so the refusal is expected
    const dialog = await screen.findByRole("dialog", { name: 'Delete playlist "Wall A"?' });
    const slot = dialog.querySelector(".displays-refusal")!;
    expect(slot).toBeInTheDocument(); // reserved at once, empty
    expect(slot).toBeEmptyDOMElement();
    expect(slot).toHaveClass("displays-refusal-reserved");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(slot).toHaveTextContent("This playlist is shown by 10 screens: A, B, C and 7 more. Change their playlist or delete them first."));
    expect(slot.textContent!.match(/Change their playlist/g)).toHaveLength(1); // the server's advice is not repeated
    expect(within(dialog).getAllByRole("alert")).toEqual([slot]); // the dialog's own error line stays unused
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Delete Wall A" })); // opened again: the old refusal is gone
    expect(within(await screen.findByRole("dialog", { name: 'Delete playlist "Wall A"?' })).getByRole("alert")).toBeEmptyDOMElement();
  });

  it("reserves no room for a refusal on a playlist no screen shows", async () => {
    show(FULL);
    await screen.findByRole("cell", { name: "Hall TV" });
    await userEvent.click(screen.getByRole("button", { name: "Delete Wall B" }));
    const dialog = await screen.findByRole("dialog", { name: 'Delete playlist "Wall B"?' });
    expect(dialog.querySelector(".displays-refusal")).not.toHaveClass("displays-refusal-reserved");
  });

  it("shows another refusal of the delete in the same slot, with a capital and a full stop", async () => {
    show(FULL, { "DELETE /api/playlists/2": { status: 404, body: { detail: "playlist not found" } } });
    await screen.findByRole("cell", { name: "Hall TV" });
    await userEvent.click(screen.getByRole("button", { name: "Delete Wall B" }));
    const dialog = await screen.findByRole("dialog", { name: 'Delete playlist "Wall B"?' });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("Playlist not found."));
  });

  it("starts the refusal of a screen's delete or revoke with a capital too", async () => {
    show(FULL, { "DELETE /api/displays/2": { status: 409, body: { detail: "this display is busy" } } });
    await screen.findByRole("cell", { name: "Lobby" });
    await userEvent.click(within(row("Lobby")).getByRole("button", { name: "Delete Lobby" }));
    const dialog = await screen.findByRole("dialog", { name: 'Delete display "Lobby"?' });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This display is busy");
  });

  it("deletes a playlist no screen shows", async () => {
    const { calls } = show(FULL, { "DELETE /api/playlists/2": { status: 204 } });
    await screen.findByRole("cell", { name: "Hall TV" });
    await userEvent.click(screen.getByRole("button", { name: "Delete Wall B" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: 'Delete playlist "Wall B"?' })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes(calls).map((c) => [c.method, c.path])).toEqual([["DELETE", "/api/playlists/2"]]);
  });
});

describe("DisplaysPage: the playlist and display dialogs", () => {
  it("opens the playlist editor from Edit with the stored items, and from New playlist empty", async () => {
    show();
    await screen.findByRole("cell", { name: "Hall TV" });
    await chooseFromMenu("Wall A", "Edit");
    const dialog = await screen.findByRole("dialog", { name: "Edit playlist" });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Wall A");
    expect(within(dialog).getAllByRole("group")).toHaveLength(3);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "New playlist" }));
    expect(within(await screen.findByRole("dialog", { name: "New playlist" })).queryAllByRole("group")).toHaveLength(0);
  });

  it("saves an edited playlist with a PUT, reads both lists again and closes", async () => {
    const { calls } = show(FULL, { "PUT /api/playlists/2": { body: WALL_B } });
    await screen.findByRole("cell", { name: "Hall TV" });
    await chooseFromMenu("Wall B", "Edit");
    const dialog = await screen.findByRole("dialog", { name: "Edit playlist" });
    const before = reads(calls);
    await userEvent.clear(within(dialog).getByLabelText("Name"));
    await userEvent.type(within(dialog).getByLabelText("Name"), "Wall C");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes(calls).map((c) => [c.method, c.path])).toEqual([["PUT", "/api/playlists/2"]]);
    await waitFor(() => expect(reads(calls)).toBe(before + 1));
  });

  it("opens New display with the playlists to choose from", async () => {
    show();
    await screen.findByRole("cell", { name: "Hall TV" });
    await userEvent.click(screen.getByRole("button", { name: "New display" }));
    const dialog = await screen.findByRole("dialog", { name: "New display" });
    expect(within(dialog).getAllByRole("option").map((o) => o.textContent)).toEqual(["Wall A", "Wall B"]);
    expect(LIMITS.displays).toBe(50);
  });
});
