import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import type { AssetTreeMove } from "../components/AssetTree";
import { mockFetch, type Routes as FetchRoutes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { spyToasts } from "../test/toasts";
import { accountKnown, SignedIn } from "../test/signedIn";
import { userFor } from "../test/users";
import { AssetsPage } from "./AssetsPage";
import { AssetsSummary } from "./AssetsSummary";

// The wiring of W7p between the page and its tree: what the page hands the tree and what it locks while a move is open. The tree itself
// (picking, dragging) is AssetTree.test.tsx's; here it is a stub that shows the props it was given.
const seen = vi.hoisted(() => ({ tree: {} as { move?: AssetTreeMove; disabled?: boolean } }));
vi.mock("../components/AssetTree", () => ({
  AssetTree: (props: { move?: AssetTreeMove; disabled?: boolean }) => {
    seen.tree = props;
    return <nav aria-label="Asset tree stub" data-disabled={String(Boolean(props.disabled))} data-moved={props.move?.moved ? String(props.move.moved.firstId) : ""} data-moved-ids={props.move?.moved?.ids.join(",") ?? ""} data-line={props.move?.moved?.line ?? ""} />;
  },
}));

const assets = [
  { id: 1, parent_id: null, name: "Site", kind: "site", sort_order: 0 },
  { id: 2, parent_id: 1, name: "Room A", kind: "room", sort_order: 0 },
  { id: 3, parent_id: null, name: "Yard", kind: "site", sort_order: 0 },
];
const registry = [{ id: 1, name: "Site", icon: "site", asset_count: 2 }, { id: 2, name: "Room", icon: "room", asset_count: 1 }];
const emptyFleet = { power: { kw: null, counted: 0, of: 0 }, energy_today: null, cost_today: null, currency: null, attention: { total: 0, items: [] } };
const authed = (role: string): FetchRoutes => ({
  "GET /api/fleet/summary": { body: emptyFleet },
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor(role) },
  "GET /api/assets": { body: assets },
  "GET /api/asset-kinds": { body: registry },
  "GET /api/site": { body: { timezone: "UTC", currency: "USD" } },
});
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

function renderPage() {
  const spy = spyToasts();
  renderWithProviders(
    <>
      <Routes>
        <Route path="/assets" element={<AssetsPage />}>
          <Route index element={<AssetsSummary />} />
        </Route>
      </Routes>
      <SignedIn />
    </>,
    { route: "/assets", path: "*", toasts: spy.api },
  );
  return spy;
}
const stub = () => screen.getByRole("navigation", { name: "Asset tree stub" });

beforeEach(() => { seen.tree = {}; });

describe("AssetsPage and the tree's moving (W7p)", () => {
  it.each(["viewer", "operator"])("gives a %s's tree no move (no assets.edit: no picking, no dragging)", async (role) => {
    mockFetch(authed(role));
    renderPage();
    await accountKnown();
    await screen.findByRole("navigation", { name: "Asset tree stub" });
    expect(seen.tree.move).toBeUndefined();
  });

  it("gives an editor's tree the move, with handlers that open the dialog and move", async () => {
    mockFetch(authed("admin"));
    renderPage();
    await accountKnown();
    await waitFor(() => expect(seen.tree.move).toBeDefined());
    expect(seen.tree.move).toEqual({ onDrop: expect.any(Function), onMoveTo: expect.any(Function), onUndo: expect.any(Function), moved: null });
  });

  it("locks the page while Move to... is open: the tree is disabled, Add asset is off, and both come back on Cancel", async () => {
    mockFetch(authed("admin"));
    renderPage();
    await accountKnown();
    const add = await screen.findByRole("button", { name: "Add asset" });
    await waitFor(() => expect(add).toBeEnabled());
    expect(stub()).toHaveAttribute("data-disabled", "false");
    act(() => seen.tree.move!.onMoveTo([2], null));
    expect(await screen.findByRole("dialog", { name: 'Move "Room A" to...' })).toBeInTheDocument();
    expect(stub()).toHaveAttribute("data-disabled", "true");
    expect(add).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(stub()).toHaveAttribute("data-disabled", "false");
    expect(add).toBeEnabled();
  });

  it("moves through the dialog, hands the tree the signal and offers Undo", async () => {
    const calls = mockFetch({ ...authed("admin"), "POST /api/assets/move-preview": { body: preview }, "POST /api/assets/move": { body: result } });
    const spy = renderPage();
    await accountKnown();
    await waitFor(() => expect(seen.tree.move).toBeDefined());
    act(() => seen.tree.move!.onMoveTo([2], null));
    await userEvent.click(await screen.findByRole("radio", { name: "Yard" }));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(stub()).toHaveAttribute("data-moved", "2"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toMatchObject({ kind: "success", text: "Moved Room A to Yard", options: { action: { label: "Undo" }, durationMs: 8000 } });
    expect(calls.filter((c) => c.method === "POST" && c.path === "/api/assets/move")[0].body).toEqual({
      moves: [{ ids: [2], parent_id: 3, before_id: null }],
      expect: preview.expect,
    });
    expect(stub()).toHaveAttribute("data-disabled", "false"); // unlocked again
    expect(stub()).toHaveAttribute("data-moved-ids", "2");
    expect(stub()).toHaveAttribute("data-line", "Moved Room A to Yard. Press Ctrl+Z to undo.");
  });

  it("gives the tree a Ctrl+Z route to the latest move's Undo: it sends the undo request, and finds nothing to undo after", async () => {
    const calls = mockFetch({ ...authed("admin"), "POST /api/assets/move-preview": { body: preview }, "POST /api/assets/move": { body: result } });
    const spy = renderPage();
    await accountKnown();
    await waitFor(() => expect(seen.tree.move).toBeDefined());
    expect(seen.tree.move!.onUndo!()).toBe(false); // nothing moved yet
    await act(async () => { await seen.tree.move!.onDrop([2], { parent_id: 3, before_id: null }); });
    let started = false;
    await act(async () => { started = seen.tree.move!.onUndo!(); });
    expect(started).toBe(true);
    await waitFor(() => expect(spy.calls.at(-1)).toEqual({ kind: "success", text: "Undone" }));
    const moves = calls.filter((c) => c.method === "POST" && c.path === "/api/assets/move");
    expect(moves.map((c) => (c.body as { undo_of?: string }).undo_of)).toEqual([undefined, "r-1"]);
    expect(seen.tree.move!.onUndo!()).toBe(false);
  });

  it("moves on a drop (a preview, then the move)", async () => {
    const calls = mockFetch({ ...authed("admin"), "POST /api/assets/move-preview": { body: preview }, "POST /api/assets/move": { body: result } });
    const spy = renderPage();
    await accountKnown();
    await waitFor(() => expect(seen.tree.move).toBeDefined());
    await act(async () => { await seen.tree.move!.onDrop([2], { parent_id: 3, before_id: null }); });
    expect(spy.calls[0]).toMatchObject({ kind: "success", text: "Moved Room A to Yard" });
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/api/assets/move-preview", "/api/assets/move"]);
  });

  it("starts no move while an Add asset dialog is open", async () => {
    const calls = mockFetch({ ...authed("admin"), "POST /api/assets/move-preview": { body: preview } });
    renderPage();
    await accountKnown();
    await userEvent.click(await screen.findByRole("button", { name: "Add asset" }));
    await screen.findByRole("dialog", { name: "Add asset" });
    await act(async () => { await seen.tree.move!.onDrop([2], { parent_id: 3, before_id: null }); });
    act(() => seen.tree.move!.onMoveTo([2], null));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });
});
