import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { authed } from "../../test/dashboardFixtures";
import { mockFetch, type Routes } from "../../test/fetchMock";
import { renderWithProviders } from "../../test/render";
import { userFor } from "../../test/users";
import { DisplayFieldDialog } from "./DisplayFieldDialog";
import { playlist, playlistItem, screenRow } from "./displayFixtures";
import { FOCUS_NEEDS_ASSETS } from "./displayText";

const PLAYLISTS = [playlist(1, "Wall A"), playlist(3, "Wall B"), playlist(2, "Wall C", [playlistItem(41, { focus_asset_id: 11, focus_name: "Hall 1" })])]; // Wall C names a focus asset
const HALL_TV = screenRow(1, "Hall TV", 1, "Wall A");
const ROLE: Routes = { "GET /api/me": { body: userFor("Wall editor", { permissions: ["displays.manage", "dashboards.view"] as never }) } };
const FORBIDDEN: Routes = { "PUT /api/displays/1": { status: 403, body: { detail: "insufficient permission" } } };

function Host({ field }: { field: "name" | "playlist" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open it</button>
      {open && <DisplayFieldDialog display={HALL_TV} field={field} playlists={PLAYLISTS} onClose={() => setOpen(false)} />}
    </>
  );
}
async function show(field: "name" | "playlist", over: Routes = {}) {
  mockFetch({ ...authed("admin"), ...over });
  renderWithProviders(<Host field={field} />, { route: "/displays", path: "*" });
  await userEvent.click(await screen.findByRole("button", { name: "Open it" }));
  return screen.getByRole("dialog", { name: field === "name" ? "Rename display" : "Change playlist" });
}

describe("DisplayFieldDialog: Change playlist to one that names a focus asset", () => {
  it("says why the server refused a role that may not see the assets, in place of the generic sentence", async () => {
    const dialog = await show("playlist", { ...ROLE, ...FORBIDDEN });
    await userEvent.selectOptions(within(dialog).getByLabelText("Playlist"), "Wall C");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(FOCUS_NEEDS_ASSETS);
  });

  it("leaves the generic sentence when the chosen playlist names no focus", async () => {
    const dialog = await show("playlist", { ...ROLE, ...FORBIDDEN });
    await userEvent.selectOptions(within(dialog).getByLabelText("Playlist"), "Wall B"); // no focus item
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Your role does not allow this.");
  });

  it("an administrator (who may see the assets) keeps the generic sentence", async () => {
    const dialog = await show("playlist", FORBIDDEN);
    await userEvent.selectOptions(within(dialog).getByLabelText("Playlist"), "Wall C");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Your role does not allow this.");
  });
});

describe("DisplayFieldDialog: the server's sentence", () => {
  it("starts with a capital", async () => {
    const dialog = await show("name", { "PUT /api/displays/1": { status: 409, body: { detail: "a display with this name already exists (it may be revoked): delete it or choose another name" } } });
    await userEvent.clear(within(dialog).getByLabelText("Name"));
    await userEvent.type(within(dialog).getByLabelText("Name"), "Lobby");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A display with this name already exists (it may be revoked): delete it or choose another name");
  });
});
