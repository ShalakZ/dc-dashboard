import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { spyToasts } from "../test/toasts";
import { accountKnown, SignedIn } from "../test/signedIn";
import { userFor } from "../test/users";
import { AssetsPage } from "./AssetsPage";

// The page, the REAL tree and the move dialog together (AssetsPage.move.test.tsx stubs the tree): the way the open asset is moved from the
// tree's top slot, where the focus goes, and what the page locks while the dialog is open.
const before = [
  { id: 1, parent_id: null, name: "Site", kind: "site", sort_order: 0 },
  { id: 2, parent_id: 1, name: "Room A", kind: "room", sort_order: 0 },
  { id: 3, parent_id: null, name: "Yard", kind: "site", sort_order: 0 },
];
const after = before.map((a) => (a.id === 2 ? { ...a, parent_id: 3 } : a));
const registry = [{ id: 1, name: "Site", icon: "site", asset_count: 2 }, { id: 2, name: "Room", icon: "room", asset_count: 1 }];
const emptyFleet = { power: { kw: null, counted: 0, of: 0 }, energy_today: null, cost_today: null, currency: null, attention: { total: 0, items: [] } };
const preview = {
  assets: 1, unchanged: [], currency: "USD", rate_changes: false,
  roots: [{
    id: 2, name: "Room A", subtree_assets: 1, from_parent_id: 1, from_parent_name: "Site", to_parent_id: 3, to_parent_name: "Yard",
    change: "parent", rate_before: null, rate_after: null, rate_changes_today: false, rate_changes_other_days: false,
  }],
  expect: { assets: 1, parents: { "2": 1 }, rate_changes: false },
};
const result = {
  request_id: "r-1", assets: 1, unchanged: [],
  moved: [{ id: 2, name: "Room A", from_parent_id: 1, to_parent_id: 3, from_parent_name: "Site", to_parent_name: "Yard", change: "parent" }],
  undo: { moves: [{ ids: [2], parent_id: 1, before_id: null }], expect: { assets: 1, parents: { "2": 3 } } },
};

function setup() {
  let moved = false;
  const calls = mockFetch({
    "GET /api/fleet/summary": { body: emptyFleet },
    "GET /api/setup": { body: { needed: false } },
    "GET /api/me": { body: userFor("admin") },
    "GET /api/assets": () => ({ body: moved ? after : before }),
    "GET /api/asset-kinds": { body: registry },
    "GET /api/site": { body: { timezone: "UTC", currency: "USD" } },
    "POST /api/assets/move-preview": { body: preview },
    "POST /api/assets/move": () => { moved = true; return { body: result }; },
  });
  const spy = spyToasts();
  renderWithProviders(
    <>
      <Routes>
        <Route path="/assets" element={<AssetsPage />}>
          <Route path=":id" element={<p>the asset page</p>} />
        </Route>
      </Routes>
      <SignedIn />
    </>,
    { route: "/assets/2", path: "*", toasts: spy.api },
  );
  return { calls, spy };
}
const slot = () => screen.getByRole("group", { name: "Selection" });
const treeLink = (name: string) => within(document.querySelector("ul.tree") as HTMLElement).getByRole("link", { name });

describe("moving the open asset from the tree's top slot (W7p)", () => {
  it("Cancel gives the focus back to the slot's button, which the page locked while the dialog was open", async () => {
    setup();
    await accountKnown();
    await screen.findByRole("link", { name: "Room A" });
    const button = await within(slot()).findByRole("button", { name: "Move to..." });
    await userEvent.click(button);
    await screen.findByRole("dialog", { name: 'Move "Room A" to...' });
    expect(button).toHaveAttribute("aria-disabled", "true"); // the page is locked: the tree's buttons are off
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).toHaveFocus();
  });

  it("a move puts the focus on the moved asset's link in the tree (not on the slot's button that is still there), with an Undo toast", async () => {
    const { calls, spy } = setup();
    await accountKnown();
    await screen.findByRole("link", { name: "Room A" });
    await userEvent.click(await within(slot()).findByRole("button", { name: "Move to..." }));
    await userEvent.click(await screen.findByRole("radio", { name: "Yard" }));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === "POST" && c.path === "/api/assets/move")[0].body).toEqual({
      moves: [{ ids: [2], parent_id: 3, before_id: null }],
      expect: preview.expect,
    });
    await waitFor(() => expect(treeLink("Room A")).toHaveFocus());
    // Room A now sits under Yard in the tree.
    expect(within(treeLink("Yard").closest("li")!).getByRole("link", { name: "Room A" })).toBeInTheDocument();
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toMatchObject({ kind: "success", options: { action: { label: "Undo" } } });
  });
});
