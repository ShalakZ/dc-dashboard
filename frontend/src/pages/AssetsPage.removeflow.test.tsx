import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import type { Asset, User } from "../api/types";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { spyToasts } from "../test/toasts";
import { accountKnown, SignedIn } from "../test/signedIn";
import { userFor } from "../test/users";
import { AssetsPage } from "./AssetsPage";

// The page with the REAL tree, the pick bar and the delete dialog together (T2 covers the hook and the dialog on their own, AssetTree.remove.test.tsx
// the button on its own): Ctrl-click two rows, Delete in the bar, the dialog, one DELETE per top-level pick, the toast, the picks, the focus and the URL.
//
//   Site 1 > Room A 2, Room B 3
//   Yard 4 > Shed 5
//   Annex 6
const asset = (id: number, parent_id: number | null, name: string): Asset => ({ id, parent_id, name, kind: "site", sort_order: id });
const ASSETS: Asset[] = [asset(1, null, "Site"), asset(2, 1, "Room A"), asset(3, 1, "Room B"), asset(4, null, "Yard"), asset(5, 4, "Shed"), asset(6, null, "Annex")];
const registry = [{ id: 1, name: "Site", icon: "site", asset_count: 6 }];
const emptyFleet = { power: { kw: null, counted: 0, of: 0 }, energy_today: null, cost_today: null, currency: null, attention: { total: 0, items: [] } };
/** What `GET /api/assets/{id}/impact` answers; a root not listed here answers one asset and nothing else. */
const IMPACTS: Record<number, { assets: number; mappings: number; tariffs: number }> = { 2: { assets: 1, mappings: 2, tariffs: 1 } };

/** A server that remembers: a DELETE takes the asset (and what is below it) out of the next list. `deletes` is every DELETE url as it arrived, with its query. */
function setup(route: string, user: User = userFor("admin")) {
  let list = [...ASSETS];
  const deletes: string[] = [];
  const subtree = (id: number): Set<number> => {
    const ids = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const a of list) if (a.parent_id !== null && ids.has(a.parent_id) && !ids.has(a.id)) { ids.add(a.id); grew = true; }
    }
    return ids;
  };
  const routes: Parameters<typeof mockFetch>[0] = {
    "GET /api/fleet/summary": { body: emptyFleet },
    "GET /api/setup": { body: { needed: false } },
    "GET /api/me": { body: user },
    "GET /api/assets": () => ({ body: list }),
    "GET /api/asset-kinds": { body: registry },
    "GET /api/site": { body: { timezone: "UTC", currency: "USD" } },
  };
  for (const a of ASSETS) {
    routes[`GET /api/assets/${a.id}/impact`] = () => ({ body: IMPACTS[a.id] ?? { assets: subtree(a.id).size, mappings: 0, tariffs: 0 } });
    routes[`DELETE /api/assets/${a.id}`] = ({ url }) => {
      deletes.push(url.replace(/^https?:\/\/[^/]+/, ""));
      const gone = subtree(a.id);
      list = list.filter((x) => !gone.has(x.id));
      return { status: 204 };
    };
  }
  const calls = mockFetch(routes);
  const spy = spyToasts();
  renderWithProviders(
    <>
      <Routes>
        <Route path="/assets" element={<AssetsPage />}>
          <Route path=":id" element={<p>the asset page</p>} />
        </Route>
      </Routes>
      <Where />
      <SignedIn />
    </>,
    { route, path: "*", toasts: spy.api },
  );
  return { calls, deletes, spy };
}

/** The page's URL, for the tests that watch it move. */
function Where() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}
const path = () => screen.getByTestId("path").textContent;
const slot = () => screen.getByRole("group", { name: "Selection" });
const treeLink = (name: string) => within(document.querySelector("ul.tree") as HTMLElement).getByRole("link", { name });
const bar = (name: string | RegExp) => within(slot()).getByRole("button", { name });
const barButtons = () => within(slot()).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
/** A Ctrl-click on a row: the tree picks it and does not open it. */
const ctrlClick = (name: string) => fireEvent.click(treeLink(name), { ctrlKey: true });
/** The tree has arrived and the pick bar is there (it exists for someone who may change assets). */
async function treeReady() {
  await accountKnown();
  await screen.findByRole("link", { name: "Annex" });
  await within(document.body).findByRole("group", { name: "Selection" });
}

describe("deleting the picked assets from the pick bar (W7s)", () => {
  it("Ctrl-click two, Delete in the bar, the dialog, one DELETE each with the counts the impact showed, the toast, the picks gone, the focus on the next row", async () => {
    const { calls, deletes, spy } = setup("/assets/5"); // Shed is open and stays
    await treeReady();
    ctrlClick("Room A");
    ctrlClick("Annex");
    expect(slot()).toHaveTextContent("2 picked");
    expect(barButtons()).toEqual(["Move to...", "Delete the 2 picked assets", "Clear"]);

    await userEvent.click(bar("Delete the 2 picked assets"));
    const box = await screen.findByRole("dialog", { name: "Delete 2 assets?" });
    // Room A holds two mappings and a tariff (the impact said so), so this is not the plain delete.
    const confirm = await within(box).findByRole("button", { name: "Delete anyway" });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(box).toHaveTextContent("Room A");
    expect(box).toHaveTextContent("Annex");
    expect(box).toHaveTextContent("2 assets, 2 mappings and 1 tariff will be deleted");
    expect(deletes).toEqual([]); // nothing is deleted by looking
    expect(calls.filter((c) => c.path.endsWith("/impact")).map((c) => c.path).sort()).toEqual(["/api/assets/2/impact", "/api/assets/6/impact"]);

    await userEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deletes).toEqual([
      "/api/assets/2?confirm=true&expect_assets=1&expect_mappings=2&expect_tariffs=1",
      "/api/assets/6?confirm=true&expect_assets=1&expect_mappings=0&expect_tariffs=0",
    ]);
    expect(spy.calls).toEqual([{ kind: "success", text: "Deleted 2 assets" }]);

    // The list is read again: both rows are gone, and so are their picks (no count, no Delete, no Clear).
    await waitFor(() => expect(screen.queryByRole("link", { name: "Room A" })).not.toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "Annex" })).not.toBeInTheDocument();
    expect(slot()).not.toHaveTextContent("picked");
    expect(barButtons()).toEqual(["Move to..."]); // the open asset can still be moved
    // The Delete button went with the picks, so the focus went to the first row left after Room A, not to the body.
    await waitFor(() => expect(treeLink("Room B")).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
    expect(path()).toBe("/assets/5"); // the open asset was not among them: the page stays
  });

  it("the open asset among the deleted ones: the URL moves to its parent", async () => {
    const { deletes, spy } = setup("/assets/3"); // Room B is open, under Site
    await treeReady();
    ctrlClick("Room B"); // picking the open row does not open anything: it is open already
    ctrlClick("Annex");
    expect(slot()).toHaveTextContent("2 picked");
    expect(path()).toBe("/assets/3");

    await userEvent.click(bar("Delete the 2 picked assets"));
    const box = await screen.findByRole("dialog", { name: "Delete 2 assets?" });
    expect(box).toHaveTextContent("This can't be undone.");
    const confirm = await within(box).findByRole("button", { name: "Delete" });
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deletes).toEqual([
      "/api/assets/3?confirm=true&expect_assets=1&expect_mappings=0&expect_tariffs=0",
      "/api/assets/6?confirm=true&expect_assets=1&expect_mappings=0&expect_tariffs=0",
    ]);
    await waitFor(() => expect(path()).toBe("/assets/1")); // Room B's parent, Site (the router renders a tick after the request that triggered it; under load that tick is late)
    expect(spy.calls).toEqual([{ kind: "success", text: "Deleted 2 assets" }]);
    await waitFor(() => expect(screen.queryByRole("link", { name: "Room B" })).not.toBeInTheDocument());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("a role without assets.delete picks, moves and clears but has no Delete in the bar", async () => {
    const { calls } = setup("/assets/5", userFor("editor", { permissions: ["assets.view", "assets.edit"] }));
    await treeReady();
    ctrlClick("Room A");
    ctrlClick("Annex");
    expect(slot()).toHaveTextContent("2 picked");
    expect(barButtons()).toEqual(["Move to...", "Clear"]);
    expect(within(slot()).queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === "DELETE" || c.path.endsWith("/impact"))).toEqual([]);
  });

  it("with the Add asset dialog open a click on the bar's Delete opens no delete dialog and asks the server nothing", async () => {
    // The page hands the hook (not the tree's `disabled`) the Add/Edit dialog as a lock, as it does for Move to...: the button is not aria-disabled here,
    // it is refused. The form's backdrop and focus trap are what keep a person from reaching it.
    const { calls, deletes } = setup("/assets/5");
    await treeReady();
    ctrlClick("Room A");
    ctrlClick("Annex");
    const add = screen.getByRole("button", { name: "Add a top-level asset" });
    await waitFor(() => expect(add).toBeEnabled()); // the lists have arrived
    await userEvent.click(add);
    await screen.findByRole("dialog", { name: "Add asset" });

    await userEvent.click(bar("Delete the 2 picked assets"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1); // still only the Add asset dialog
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Add asset");
    expect(calls.filter((c) => c.method === "DELETE" || c.path.endsWith("/impact"))).toEqual([]);
    expect(deletes).toEqual([]);

    // Closing the form gives the bar its Delete back: the same press now opens the confirmation.
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await userEvent.click(bar("Delete the 2 picked assets"));
    expect(await screen.findByRole("dialog", { name: "Delete 2 assets?" })).toBeInTheDocument();
  });

  it("the page lock: with Move to... open the bar's Delete is aria-disabled, a click opens no delete dialog, and Cancel gives it back", async () => {
    const { calls, deletes } = setup("/assets/5");
    await treeReady();
    ctrlClick("Room A");
    ctrlClick("Annex");
    const del = bar("Delete the 2 picked assets");
    expect(del).not.toHaveAttribute("aria-disabled");
    await userEvent.click(bar("Move to..."));
    await screen.findByRole("dialog", { name: /^Move / });
    expect(del).toHaveAttribute("aria-disabled", "true"); // the same button, not a new one: it may hold the focus, so it is never natively disabled
    expect(del).toHaveTextContent("Delete");

    await userEvent.click(del);
    expect(screen.getAllByRole("dialog")).toHaveLength(1); // still only the Move dialog
    expect(screen.getByRole("dialog")).toHaveAccessibleName(/^Move /);
    expect(calls.filter((c) => c.method === "DELETE" || c.path.endsWith("/impact"))).toEqual([]);
    expect(deletes).toEqual([]);

    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(del).not.toHaveAttribute("aria-disabled");
    await userEvent.click(del);
    expect(await screen.findByRole("dialog", { name: "Delete 2 assets?" })).toBeInTheDocument();
  });
});
