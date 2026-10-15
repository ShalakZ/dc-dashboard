import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { useLocation, useMatch, useNavigate } from "react-router";
import { useAssets } from "../api/queries";
import type { Asset } from "../api/types";
import type { AssetTreeRemove } from "../components/AssetTree";
import type { Timers } from "../lib/progress";
import { parseAssetId } from "../lib/tree";
import { holdFetch } from "../test/holdFetch";
import { mockFetch, type Routes } from "../test/fetchMock";
import { manualTimers } from "../test/manualTimers";
import { renderWithProviders } from "../test/render";
import { spyToasts } from "../test/toasts";
import { userFor } from "../test/users";
import { useTreeDelete } from "./useTreeDelete";

// Annex
// Site
//   Hall A: Rack 1 (4), Rack 2 (5)
//   Hall B: Rack 1 (6)
// Yard
const asset = (id: number, parent_id: number | null, name: string): Asset => ({ id, parent_id, name, kind: "room", sort_order: 0 });
const ASSETS: Asset[] = [
  asset(1, null, "Site"), asset(2, 1, "Hall A"), asset(3, 1, "Hall B"), asset(4, 2, "Rack 1"), asset(5, 2, "Rack 2"),
  asset(6, 3, "Rack 1"), asset(7, null, "Yard"), asset(8, null, "Annex"),
];

/** A server that remembers: DELETE removes the subtree, so the next list is shorter. `deletes` is every DELETE url as it arrived. */
function world(assets: Asset[] = ASSETS, over: Routes = {}) {
  let list = [...assets];
  const deletes: string[] = [];
  const subtree = (id: number) => {
    const ids = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const a of list) if (a.parent_id !== null && ids.has(a.parent_id) && !ids.has(a.id)) { ids.add(a.id); grew = true; }
    }
    return ids;
  };
  const routes: Routes = {
    "GET /api/me": { body: userFor("admin") },
    "GET /api/setup": { body: { needed: false } },
    "GET /api/assets": () => ({ body: list }),
  };
  for (const a of assets) {
    routes[`GET /api/assets/${a.id}/impact`] = () => (list.some((x) => x.id === a.id) ? { body: { assets: subtree(a.id).size, mappings: 0, tariffs: 0 } } : { status: 404, body: { detail: "asset not found" } });
    routes[`DELETE /api/assets/${a.id}`] = ({ url }) => {
      deletes.push(url.replace(/^https?:\/\/[^/]+/, ""));
      if (!list.some((x) => x.id === a.id)) return { status: 404, body: { detail: "asset not found" } };
      const gone = subtree(a.id);
      list = list.filter((x) => !gone.has(x.id));
      return { status: 204 };
    };
  }
  const calls = mockFetch({ ...routes, ...over });
  return { calls, deletes, removeBehindTheBack: (id: number) => { const gone = subtree(id); list = list.filter((x) => !gone.has(x.id)); } };
}

interface Handle { remove: AssetTreeRemove | undefined; busy: boolean; setGranted: (v: boolean) => void; setPicks: (ids: number[]) => void; client: QueryClient; removes: (AssetTreeRemove | undefined)[] }
let handle: Handle;

/**
 * What the Assets page and its tree do around the hook. The pick bar's Delete is `opener`: it exists while something is picked and the viewer
 * holds the permission, and the picks follow the list like the tree's `prune` (a deleted asset is no longer picked). The tree's rows, its
 * filter and Layout's #main are the places the focus may go.
 */
function Harness({ canDelete = true, locked = false, blurOpener = false, alwaysOpener = false, focusAfter = null, timers }: { canDelete?: boolean; locked?: boolean; blurOpener?: boolean; alwaysOpener?: boolean; focusAfter?: number | null; timers?: Timers }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { data: assets = [] } = useAssets();
  const selectedId = parseAssetId(useMatch("/assets/:id")?.params.id);
  const [granted, setGranted] = useState(canDelete);
  const [picks, setPicks] = useState<number[]>([]);
  const { remove, dialog, busy } = useTreeDelete({ assets, selectedId, canDelete: granted, locked, timers });
  const live = picks.filter((id) => assets.some((a) => a.id === id));
  const removes = handle?.removes ?? [];
  removes.push(remove);
  handle = { remove, busy, setGranted, setPicks, client, removes };
  return (
    <div>
      {remove && (live.length > 0 || alwaysOpener) && (
        <button type="button" onClick={(e) => { remove.onDelete(live, e.currentTarget, focusAfter); if (blurOpener) e.currentTarget.blur(); }}>Delete picked</button>
      )}
      <button type="button" onClick={() => navigate("/assets/8")}>go to Annex</button>
      <button type="button" onClick={() => navigate("/assets/4")}>go to Hall A&apos;s Rack 1</button>
      <button type="button" onClick={() => navigate("/assets/6")}>go to Hall B&apos;s Rack 1</button>
      {assets.length > 0 && <input id="asset-tree-filter" aria-label="Filter assets" />}
      <ul className="tree">{assets.map((a) => <li key={a.id}><a href={`/assets/${a.id}`}>{a.name} {a.id}</a></li>)}</ul>
      <span data-testid="ids">{assets.map((a) => a.id).join(",")}</span>
      <span data-testid="busy">{String(busy)}</span>
      {dialog}
    </div>
  );
}
/** Around the Harness: the page's own URL and #main (they outlive the hook), and a way to take the hook away mid-run. */
function Outer(props: ComponentProps<typeof Harness>) {
  const [shown, setShown] = useState(true);
  const location = useLocation();
  return (
    <>
      <main id="main" tabIndex={-1}>main</main>
      <span data-testid="path">{location.pathname}</span>
      <button type="button" onClick={() => setShown(false)}>unmount the hook</button>
      {shown && <Harness {...props} />}
    </>
  );
}

function setup(props: ComponentProps<typeof Harness> = {}, { route = "/assets", assets = ASSETS, over = {} }: { route?: string; assets?: Asset[]; over?: Routes } = {}) {
  const server = world(assets, over);
  const spy = spyToasts();
  handle = undefined as unknown as Handle;
  renderWithProviders(<Outer {...props} />, { route, toasts: spy.api });
  return { ...server, spy };
}
const path = () => screen.getByTestId("path").textContent;
const ids = () => screen.getByTestId("ids").textContent;
/** The assets are in. */
const settled = async () => { await waitFor(() => expect(Number(ids()?.split(",").length)).toBeGreaterThan(1)); await act(async () => {}); };
const pick = (...picked: number[]) => act(() => handle.setPicks(picked));
const opener = () => screen.getByRole("button", { name: "Delete picked" });
const confirmButton = () => screen.getByRole("button", { name: /^Delete( anyway)?$/ });
/** Press the bar's Delete and wait for the dialog's numbers. */
async function openDialog(...picked: number[]) {
  await settled();
  await pick(...picked);
  await userEvent.click(opener());
  await screen.findByRole("dialog");
  await waitFor(() => expect(confirmButton()).toBeEnabled());
}
const confirm = async () => { await userEvent.click(confirmButton()); };
const noDialog = () => expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
const row = (id: number) => screen.getByRole("link", { name: new RegExp(` ${id}$`) });

describe("useTreeDelete", () => {
  describe("what the tree is given", () => {
    it("no remove at all without assets.delete", async () => {
      setup({ canDelete: false });
      await settled();
      expect(handle.remove).toBeUndefined();
    });

    it("a remove with the permission, and the same object while nothing changes (the tree memoises its rows on it)", async () => {
      setup();
      await settled();
      expect(handle.remove).toBeDefined();
      const first = handle.remove;
      await act(async () => { await handle.client.invalidateQueries({ queryKey: ["assets"] }); });
      expect(handle.remove).toBe(first);
      expect(handle.removes.filter((r) => r !== undefined && r !== first)).toEqual([]);
    });

    it("a remove that goes away with the permission", async () => {
      setup();
      await settled();
      act(() => handle.setGranted(false));
      expect(handle.remove).toBeUndefined();
    });
  });

  describe("onDelete", () => {
    it("opens the dialog with the picked names and counts as busy until it is closed", async () => {
      setup();
      await openDialog(4, 5);
      expect(screen.getByRole("dialog", { name: "Delete 2 assets?" })).toHaveTextContent("Rack 1, Rack 2. This can't be undone.");
      expect(screen.getByTestId("busy")).toHaveTextContent("true");
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      noDialog();
      expect(screen.getByTestId("busy")).toHaveTextContent("false");
    });

    it("does nothing while the page is locked: no dialog, no request", async () => {
      const { calls } = setup({ locked: true });
      await settled();
      await pick(4);
      await userEvent.click(opener());
      noDialog();
      expect(calls.filter((c) => c.path.endsWith("/impact") || c.method === "DELETE")).toEqual([]);
    });

    it("does nothing while its dialog is open: a second press opens no second dialog", async () => {
      const { calls } = setup();
      await openDialog(4, 5);
      act(() => handle.remove!.onDelete([7], null, null));
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(screen.getByRole("dialog")).toHaveAccessibleName("Delete 2 assets?");
      expect(calls.filter((c) => c.path === "/api/assets/7/impact")).toEqual([]);
    });

    it("ignores ids that are not in the tree", async () => {
      const { calls } = setup();
      await settled();
      act(() => handle.remove!.onDelete([999], null, null));
      noDialog();
      expect(calls.filter((c) => c.path.endsWith("/impact"))).toEqual([]);
    });

    it("more than 100 top-level assets: an error toast that counts the roots, no dialog", async () => {
      const many = Array.from({ length: 105 }, (_, i) => asset(100 + i, null, `Bulk ${String(i).padStart(3, "0")}`));
      const { calls, spy } = setup({}, { assets: many });
      await waitFor(() => expect(ids()?.split(",")).toHaveLength(105));
      await act(async () => {});
      act(() => handle.remove!.onDelete(many.slice(0, 101).map((a) => a.id), null, null));
      noDialog();
      expect(spy.calls).toEqual([{ kind: "error", text: "Up to 100 assets can be deleted at once (you picked 101 top-level ones). Pick fewer." }]);
      expect(calls.filter((c) => c.path.endsWith("/impact"))).toEqual([]);
    });

    it("exactly 100 top-level assets is allowed", async () => {
      const many = Array.from({ length: 105 }, (_, i) => asset(100 + i, null, `Bulk ${String(i).padStart(3, "0")}`));
      setup({}, { assets: many });
      await waitFor(() => expect(ids()?.split(",")).toHaveLength(105));
      await act(async () => {});
      act(() => handle.remove!.onDelete(many.slice(0, 100).map((a) => a.id), null, null));
      expect(await screen.findByRole("dialog", { name: "Delete 100 assets?" })).toBeInTheDocument();
    });

    it("a picked branch counts once toward the cap", async () => {
      const kids = Array.from({ length: 120 }, (_, i) => asset(200 + i, 100, `Kid ${String(i).padStart(3, "0")}`));
      setup({}, { assets: [asset(100, null, "Parent"), ...kids] });
      await waitFor(() => expect(ids()?.split(",")).toHaveLength(121));
      await act(async () => {});
      act(() => handle.remove!.onDelete([100, ...kids.map((k) => k.id)], null, null));
      expect(await screen.findByRole("dialog", { name: "Delete 121 assets?" })).toBeInTheDocument();
    });
  });

  describe("Delete", () => {
    it("deletes the roots one after the other with the counts that were shown, toasts, closes, and refreshes everything once at the end", async () => {
      const { deletes, spy, calls } = setup();
      await settled();
      const refreshed: { key: unknown; deletesSoFar: number }[] = [];
      const original = handle.client.invalidateQueries.bind(handle.client);
      vi.spyOn(handle.client, "invalidateQueries").mockImplementation((...args: Parameters<typeof original>) => {
        refreshed.push({ key: (args[0] as { queryKey?: unknown } | undefined)?.queryKey, deletesSoFar: deletes.length });
        return original(...args);
      });
      await openDialog(4, 5);
      await confirm();
      await waitFor(() => noDialog());
      expect(deletes).toEqual([
        "/api/assets/4?confirm=true&expect_assets=1&expect_mappings=0&expect_tariffs=0",
        "/api/assets/5?confirm=true&expect_assets=1&expect_mappings=0&expect_tariffs=0",
      ]);
      expect(spy.calls).toEqual([{ kind: "success", text: "Deleted 2 assets" }]);
      expect(refreshed.map((r) => r.key)).toEqual([["assets"], ["fleet-summary"], ["billing"], ["widget-data"], ["tariffs"], ["audit"], ["graph"], ["sources"]]);
      expect(refreshed.every((r) => r.deletesSoFar === 2)).toBe(true); // after the loop, not between the requests
      await waitFor(() => expect(ids()).not.toContain("4"));
      expect(ids()).toBe("1,2,3,6,7,8");
      expect(calls.filter((c) => c.method === "GET" && c.path === "/api/assets").length).toBe(3); // the page's first read, the dialog's own fresh read, and the refresh at the end
      expect(screen.getByTestId("busy")).toHaveTextContent("false");
    });

    it("a branch is deleted whole (one request for the root) and the toast counts the assets the dialog showed", async () => {
      const { deletes, spy } = setup();
      await openDialog(2, 4);
      expect(screen.getByRole("dialog")).toHaveTextContent("Rack 1 is inside Hall A, which is also picked, so it goes with it.");
      await confirm();
      await waitFor(() => noDialog());
      expect(deletes).toEqual(["/api/assets/2?confirm=true&expect_assets=3&expect_mappings=0&expect_tariffs=0"]);
      expect(spy.calls).toEqual([{ kind: "success", text: "Deleted 3 assets" }]);
    });

    it("one failure in the middle: the roots before it are gone, the failed one and the rest are not touched, and the toast says so", async () => {
      const { deletes, spy } = setup({}, { over: { "DELETE /api/assets/3": { status: 409, body: { detail: "more than shown", assets: 3, mappings: 0, tariffs: 0 } } } });
      await openDialog(2, 3, 7);
      await confirm();
      await waitFor(() => noDialog());
      expect(deletes).toEqual(["/api/assets/2?confirm=true&expect_assets=3&expect_mappings=0&expect_tariffs=0"]); // 3's request is answered by the override, which records nothing
      expect(spy.calls).toEqual([{ kind: "error", text: 'Deleted 3 assets. "Hall B" could not be deleted: More was added under it since the numbers were shown. 1 was not tried.' }]);
      await waitFor(() => expect(ids()).toBe("1,3,6,7,8")); // the failed and the untried stay (the tree keeps them picked)
    });

    it("everything already gone: an info toast and the dialog closes", async () => {
      const { spy, deletes } = setup();
      await openDialog(4, 5);
      // somebody deletes both between the numbers and the press (the DELETEs answer 404); these answers record what was asked
      const notFound = ({ url }: { url: string }) => {
        deletes.push(url.replace(/^https?:\/\/[^/]+/, ""));
        return { status: 404, body: { detail: "asset not found" } };
      };
      mockFetchOver({ "DELETE /api/assets/4": notFound, "DELETE /api/assets/5": notFound });
      await confirm();
      await waitFor(() => noDialog());
      expect(spy.calls).toEqual([{ kind: "info", text: "Those assets were already deleted." }]);
      expect(deletes).toEqual([ // both were asked, with the counts the dialog showed, and the 404s were taken as "gone"
        "/api/assets/4?confirm=true&expect_assets=1&expect_mappings=0&expect_tariffs=0",
        "/api/assets/5?confirm=true&expect_assets=1&expect_mappings=0&expect_tariffs=0",
      ]);
    });

    it("a tree that changed since the list was cached blocks the dialog, refreshes the list, and deletes nothing (Hall A and Rack 1 picked, Rack 1 deleted by someone else)", async () => {
      const server = setup();
      await settled();
      await pick(2, 4);
      server.removeBehindTheBack(4); // the server now counts 2 under Hall A (Hall A and Rack 2): exactly the number of picks
      await userEvent.click(opener());
      const box = await screen.findByRole("dialog");
      await waitFor(() => expect(within(box).getByRole("alert")).toHaveTextContent("The tree changed while you were picking. It has been refreshed; pick again."));
      await waitFor(() => expect(ids()).toBe("1,2,3,5,6,7,8")); // the list was read again: Rack 1 is gone from it, so from the picks
      expect(within(box).queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
      expect(box.textContent).not.toContain("goes with it");
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      noDialog();
      expect(server.deletes).toEqual([]);
    });

    it("a pick that was deleted before the dialog opened blocks it, refreshes the list at once, and Close puts the focus somewhere named", async () => {
      const server = setup({ focusAfter: 7 });
      await settled();
      await pick(4, 5);
      server.removeBehindTheBack(5);
      await userEvent.click(opener());
      const box = await screen.findByRole("dialog");
      await waitFor(() => expect(box).toHaveTextContent("Some of the picked assets were already deleted by someone else. The tree has been refreshed; pick again."));
      await waitFor(() => expect(ids()).toBe("1,2,3,4,6,7,8")); // the list was read again: 5 is gone, so the pick of it is too
      expect(within(box).queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument(); // no confirm button, only Close
      expect(server.deletes).toEqual([]);
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      noDialog();
      expect(opener()).toHaveFocus(); // Rack 1 is still picked
    });
  });

  describe("the page goes away from the asset that is being deleted", () => {
    it("to the parent of the deleted root, AS SOON AS that root is gone: before the third request is answered", async () => {
      const { deletes } = setup({}, { route: "/assets/4" });
      await settled();
      await pick(2, 3, 7);
      await userEvent.click(opener());
      await screen.findByRole("dialog");
      await waitFor(() => expect(confirmButton()).toBeEnabled());
      const held = holdFetch((method, p) => method === "DELETE" && p === "/api/assets/7");
      await confirm();
      await waitFor(() => expect(path()).toBe("/assets/1")); // Rack 1 was under Hall A, whose parent is Site
      expect(deletes).toHaveLength(2); // Hall A and Hall B; Yard's request is still held
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      await act(async () => held.release());
      await waitFor(() => noDialog());
      expect(deletes).toHaveLength(3);
      expect(path()).toBe("/assets/1");
    });

    it("to /assets when the deleted root is on the top level", async () => {
      setup({}, { route: "/assets/7" });
      await openDialog(7);
      await confirm();
      await waitFor(() => noDialog());
      expect(path()).toBe("/assets");
    });

    it("when the open asset itself is picked, to its parent", async () => {
      setup({}, { route: "/assets/5" });
      await openDialog(5);
      await confirm();
      await waitFor(() => noDialog());
      expect(path()).toBe("/assets/2");
    });

    it("nowhere when the open asset is not among the deleted", async () => {
      setup({}, { route: "/assets/8" });
      await openDialog(4, 5);
      await confirm();
      await waitFor(() => noDialog());
      expect(path()).toBe("/assets/8");
    });

    it("nowhere when nothing is open", async () => {
      setup({}, { route: "/assets" });
      await openDialog(4);
      await confirm();
      await waitFor(() => noDialog());
      expect(path()).toBe("/assets");
    });

    it("not when that root's delete failed", async () => {
      setup({}, { route: "/assets/4", over: { "DELETE /api/assets/2": { status: 500, body: { detail: "database is locked" } } } });
      await openDialog(2, 7);
      await confirm();
      await screen.findByRole("alert"); // nothing went: the dialog stays and says why
      expect(path()).toBe("/assets/4");
    });

    it("not when its root was not tried because an earlier one failed", async () => {
      const { spy } = setup({}, { route: "/assets/6", over: { "DELETE /api/assets/2": { status: 500, body: { detail: "database is locked" } } } });
      await openDialog(2, 3);
      await confirm();
      await screen.findByRole("alert");
      expect(path()).toBe("/assets/6");
      expect(spy.calls).toEqual([]);
    });

    it("reads the open asset when a root is gone, not when Delete was pressed: Back may have moved the page", async () => {
      setup({}, { route: "/assets/4" });
      await openDialog(2, 7);
      const held = holdFetch((method, p) => method === "DELETE" && p === "/api/assets/2");
      await confirm();
      await userEvent.click(screen.getByRole("button", { name: "go to Annex" })); // the person goes elsewhere while the first request is out
      await waitFor(() => expect(path()).toBe("/assets/8"));
      await act(async () => held.release());
      await waitFor(() => noDialog());
      expect(path()).toBe("/assets/8"); // Hall A went, but the page is not on it any more
    });

    it("uses the tree as it was when Delete was pressed: a refresh that already dropped the gone root from the list does not strand the page on it", async () => {
      const server = setup({}, { route: "/assets/4" });
      await openDialog(2, 7);
      server.removeBehindTheBack(2); // somebody else deletes Hall A (and Rack 1 with it); the list is read again before the press
      await act(async () => { await handle.client.invalidateQueries({ queryKey: ["assets"] }); });
      await waitFor(() => expect(ids()).toBe("1,3,6,7,8"));
      await confirm();
      await waitFor(() => noDialog());
      expect(path()).toBe("/assets/1"); // Hall A's request answered 404 (gone), and the page left it for Site
    });

    it("leaves again for a later root: the person went on to an asset under it after the first move away (no one-shot)", async () => {
      setup({}, { route: "/assets/4" });
      await openDialog(2, 3, 7);
      const held = holdFetch((method, p) => method === "DELETE" && p === "/api/assets/3");
      await confirm();
      await waitFor(() => expect(path()).toBe("/assets/1")); // Hall A went with Rack 1: the page left for Site
      await userEvent.click(screen.getByRole("button", { name: "go to Hall B's Rack 1" })); // 6, under Hall B (3), the root that is next
      await waitFor(() => expect(path()).toBe("/assets/6"));
      await act(async () => held.release());
      await waitFor(() => noDialog());
      expect(path()).toBe("/assets/1"); // Hall B went too, and the page is not left on its Rack 1
    });

    it("leaves an asset the person went back to that was deleted earlier in the same run, once the loop is over", async () => {
      setup({}, { route: "/assets/4" });
      await openDialog(2, 7);
      const held = holdFetch((method, p) => method === "DELETE" && p === "/api/assets/7");
      await confirm();
      await waitFor(() => expect(path()).toBe("/assets/1")); // Hall A went with Rack 1: the page left for Site
      await userEvent.click(screen.getByRole("button", { name: "go to Hall A's Rack 1" })); // Back onto Rack 1, which is gone
      await waitFor(() => expect(path()).toBe("/assets/4"));
      await act(async () => held.release()); // Yard goes: no later root fires for Rack 1
      await waitFor(() => noDialog());
      expect(path()).toBe("/assets/1");
    });

    it("does not move the page at the end when it is not on a deleted asset", async () => {
      setup({}, { route: "/assets/4" });
      await openDialog(2, 7);
      const held = holdFetch((method, p) => method === "DELETE" && p === "/api/assets/7");
      await confirm();
      await waitFor(() => expect(path()).toBe("/assets/1"));
      await userEvent.click(screen.getByRole("button", { name: "go to Annex" }));
      await waitFor(() => expect(path()).toBe("/assets/8"));
      await act(async () => held.release());
      await waitFor(() => noDialog());
      expect(path()).toBe("/assets/8");
    });

    it("a root that answers 404 (gone already) counts as gone: the page leaves it too", async () => {
      setup({}, { route: "/assets/4", over: { "DELETE /api/assets/2": { status: 404, body: { detail: "asset not found" } }, "DELETE /api/assets/7": { status: 204 } } });
      await openDialog(2, 7);
      await confirm();
      await waitFor(() => noDialog());
      expect(path()).toBe("/assets/1");
    });
  });

  describe("the focus", () => {
    it("Cancel gives it to the Delete button, even when a click had not focused that button (Safari)", async () => {
      setup({ blurOpener: true });
      await openDialog(4);
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      noDialog();
      expect(opener()).toHaveFocus();
    });

    it("Escape does the same", async () => {
      setup({ blurOpener: true });
      await openDialog(4);
      await userEvent.keyboard("{Escape}");
      noDialog();
      expect(opener()).toHaveFocus();
    });

    it("a partial result gives it to the Delete button (the failed picks are still picked)", async () => {
      setup({ focusAfter: 8 }, { over: { "DELETE /api/assets/3": { status: 500, body: { detail: "database is locked" } } } });
      await openDialog(2, 3);
      await confirm();
      await waitFor(() => noDialog());
      expect(opener()).toHaveFocus();
    });

    it("a full success gives it to the row after the deleted ones, and leaves the Delete button alone even if it is still there", async () => {
      setup({ alwaysOpener: true, focusAfter: 7 });
      await openDialog(4, 5);
      await confirm();
      await waitFor(() => noDialog());
      expect(row(7)).toHaveFocus();
      expect(opener()).not.toHaveFocus();
    });

    it("without a row to take it: the tree's filter", async () => {
      setup({ focusAfter: null });
      await openDialog(4, 5);
      await confirm();
      await waitFor(() => noDialog());
      expect(screen.getByRole("textbox", { name: "Filter assets" })).toHaveFocus();
    });

    it("a row that is not on the page (the focus-after row went with the deletion): the filter", async () => {
      setup({ focusAfter: 99 });
      await openDialog(4);
      await confirm();
      await waitFor(() => noDialog());
      expect(screen.getByRole("textbox", { name: "Filter assets" })).toHaveFocus();
    });

    it("every asset deleted: the filter is gone too, so the main area takes it", async () => {
      setup({ focusAfter: null });
      await settled();
      await pick(1, 7, 8);
      await userEvent.click(opener());
      await screen.findByRole("dialog");
      await waitFor(() => expect(confirmButton()).toBeEnabled());
      await confirm();
      await waitFor(() => noDialog());
      expect(ids()).toBe("");
      expect(screen.getByRole("main")).toHaveFocus();
    });

    it("Cancel after the last pick was pruned from the list (somebody deleted it): the Delete button is gone, the row takes the focus", async () => {
      const server = setup({ focusAfter: 7 });
      await openDialog(4);
      server.removeBehindTheBack(4);
      await act(async () => { await handle.client.invalidateQueries({ queryKey: ["assets"] }); });
      await waitFor(() => expect(screen.queryByRole("button", { name: "Delete picked" })).not.toBeInTheDocument());
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      noDialog();
      expect(row(7)).toHaveFocus();
    });

    it("a partial result and then the permission is lost (a 403 re-reads who I am): the Delete button goes, and the focus is still not on the body", async () => {
      setup({ focusAfter: 8 }, { over: { "DELETE /api/assets/3": { status: 500, body: { detail: "database is locked" } } } });
      await openDialog(2, 3);
      await confirm();
      await waitFor(() => noDialog());
      expect(opener()).toHaveFocus();
      act(() => handle.setGranted(false));
      expect(screen.queryByRole("button", { name: "Delete picked" })).not.toBeInTheDocument();
      expect(document.activeElement).not.toBe(document.body);
      expect(row(8)).toHaveFocus();
    });

    it("the check after the refocus happens once: a later list change does not take the focus from the body", async () => {
      const server = setup({ focusAfter: 7 });
      await openDialog(4);
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(opener()).toHaveFocus();
      act(() => handle.setGranted(false)); // the check runs here and moves the focus off the lost button
      expect(row(7)).toHaveFocus();
      act(() => (document.activeElement as HTMLElement).blur());
      server.removeBehindTheBack(8);
      await act(async () => { await handle.client.invalidateQueries({ queryKey: ["assets"] }); });
      await waitFor(() => expect(ids()).toBe("1,2,3,4,5,6,7")); // the list DID change (without this the assertion below proves nothing)
      expect(document.activeElement).toBe(document.body);
    });

    describe("the check after the refocus expires", () => {
      /** Cancel with nothing else changed: the focus goes to the Delete button and the one-shot check is armed. */
      async function cancelledAndArmed() {
        const clock = manualTimers();
        const server = setup({ focusAfter: 7, timers: clock.timers });
        await openDialog(4);
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(opener()).toHaveFocus();
        expect(clock.count).toBe(1); // armed: the check waits for the next list, for at most a few seconds
        return { clock, server };
      }
      /** Somebody else's edit changes the list, with the focus on the body (a click on a blank area, say). */
      async function listChangesWithFocusOnTheBody(server: ReturnType<typeof setup>) {
        act(() => (document.activeElement as HTMLElement).blur());
        server.removeBehindTheBack(8);
        await act(async () => { await handle.client.invalidateQueries({ queryKey: ["assets"] }); });
        await waitFor(() => expect(ids()).toBe("1,2,3,4,5,6,7")); // the list DID change: what happens (or not) to the focus is about this list
        await act(async () => {});
      }

      it("is still armed a moment later: a list that lands while the focus is on the body takes it to the row", async () => {
        const { clock, server } = await cancelledAndArmed();
        clock.advance(2999);
        expect(clock.count).toBe(1);
        await listChangesWithFocusOnTheBody(server);
        expect(row(7)).toHaveFocus();
      });

      it("ends after three seconds: a later list change leaves the focus alone", async () => {
        const { clock, server } = await cancelledAndArmed();
        clock.advance(3000);
        expect(clock.count).toBe(0);
        await listChangesWithFocusOnTheBody(server);
        expect(document.activeElement).toBe(document.body);
      });

      it("ends at the first click anywhere", async () => {
        const { clock, server } = await cancelledAndArmed();
        fireEvent.pointerDown(document.body);
        expect(clock.count).toBe(0); // the timer went with it
        await listChangesWithFocusOnTheBody(server);
        expect(document.activeElement).toBe(document.body);
      });

      it("ends when the focus moves anywhere (Tab, or a click that took it)", async () => {
        const { clock, server } = await cancelledAndArmed();
        act(() => screen.getByRole("textbox", { name: "Filter assets" }).focus());
        expect(clock.count).toBe(0);
        await listChangesWithFocusOnTheBody(server);
        expect(document.activeElement).toBe(document.body);
      });

      it("the refocus itself does not end it (its own focus event comes before the watch starts)", async () => {
        const { clock } = await cancelledAndArmed();
        expect(clock.count).toBe(1);
        expect(clock.scheduled).toBe(1);
      });

      it("a check that ran leaves no timer and no listener behind", async () => {
        const live = trackListeners(["pointerdown", "focusin"]);
        const base = live.count();
        const { clock } = await cancelledAndArmed();
        expect(live.count()).toBeGreaterThan(base); // the watch for a click or a focus move is on
        act(() => handle.setGranted(false)); // the check runs here: the Delete button is gone, the row takes the focus
        expect(row(7)).toHaveFocus();
        expect(clock.count).toBe(0);
        expect(live.count()).toBe(base);
        live.stop();
      });

      it("goes with the hook: no timer and no listener outlive it", async () => {
        const live = trackListeners(["pointerdown", "focusin"]);
        const base = live.count();
        const { clock } = await cancelledAndArmed();
        expect(live.count()).toBeGreaterThan(base);
        await userEvent.click(screen.getByRole("button", { name: "unmount the hook" }));
        expect(clock.count).toBe(0);
        expect(live.count()).toBe(base);
        live.stop();
      });
    });
  });

  describe("when the page goes away while the requests run", () => {
    it("the loop finishes, but nobody navigates or takes the focus; the outcome is toasted once", async () => {
      const { deletes, spy } = setup({}, { route: "/assets/4" });
      await openDialog(2, 7);
      const held = holdFetch((method, p) => method === "DELETE" && p === "/api/assets/2");
      await confirm();
      await userEvent.click(screen.getByRole("button", { name: "unmount the hook" }));
      noDialog();
      await act(async () => held.release());
      await waitFor(() => expect(deletes).toHaveLength(2)); // the requests already started still finish, both roots
      await waitFor(() => expect(spy.calls).toHaveLength(1));
      await act(async () => {});
      expect(path()).toBe("/assets/4"); // Hall A went, but the hook is gone: no navigate
      expect(screen.getByRole("main")).not.toHaveFocus();
      expect(spy.calls).toEqual([{ kind: "success", text: "Deleted 4 assets" }]); // once: the hook and the dialog's own report must not both say it
    });

    it("a refusal with nothing deleted is toasted too: the person who confirmed is told it did not happen", async () => {
      const { deletes, spy } = setup({}, { route: "/assets/4", over: { "DELETE /api/assets/2": { status: 500, body: { detail: "database is locked" } } } });
      await openDialog(2, 7);
      const held = holdFetch((method, p) => method === "DELETE" && p === "/api/assets/2");
      await confirm();
      await userEvent.click(screen.getByRole("button", { name: "unmount the hook" }));
      await act(async () => held.release());
      await waitFor(() => expect(spy.calls).toHaveLength(1));
      await act(async () => {});
      expect(spy.calls).toEqual([{ kind: "error", text: '"Hall A" could not be deleted: Database is locked. 1 was not tried.' }]);
      expect(deletes).toEqual([]); // nothing was deleted (the override answers 500 and records nothing)
      expect(path()).toBe("/assets/4");
    });

    it("every root already gone is toasted once too", async () => {
      const { spy } = setup({}, { route: "/assets/8", over: { "DELETE /api/assets/2": { status: 404, body: { detail: "asset not found" } }, "DELETE /api/assets/7": { status: 404, body: { detail: "asset not found" } } } });
      await openDialog(2, 7);
      const held = holdFetch((method, p) => method === "DELETE" && p === "/api/assets/2");
      await confirm();
      await userEvent.click(screen.getByRole("button", { name: "unmount the hook" }));
      await act(async () => held.release());
      await waitFor(() => expect(spy.calls).toHaveLength(1));
      await act(async () => {});
      expect(spy.calls).toEqual([{ kind: "info", text: "Those assets were already deleted." }]);
    });

    it("while the page stays, the toast is the dialog's alone (the hook does not say it twice)", async () => {
      const { spy } = setup();
      await openDialog(4, 5);
      await confirm();
      await waitFor(() => noDialog());
      await act(async () => {});
      expect(spy.calls).toEqual([{ kind: "success", text: "Deleted 2 assets" }]);
    });
  });
});

/** Counts the document's listeners of these event types (added minus removed, by handler and capture flag), by spying on add/removeEventListener. */
function trackListeners(types: string[]) {
  const live: { type: string; fn: unknown; capture: boolean }[] = [];
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  const captures = (options?: boolean | EventListenerOptions) => (typeof options === "boolean" ? options : options?.capture ?? false);
  const addSpy = vi.spyOn(document, "addEventListener").mockImplementation(((type: string, fn: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (types.includes(type)) live.push({ type, fn, capture: captures(options) });
    add(type, fn, options);
  }) as typeof document.addEventListener);
  const removeSpy = vi.spyOn(document, "removeEventListener").mockImplementation(((type: string, fn: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    const at = live.findIndex((l) => l.type === type && l.fn === fn && l.capture === captures(options));
    if (at >= 0) live.splice(at, 1);
    remove(type, fn, options);
  }) as typeof document.removeEventListener);
  return { count: () => live.length, stop: () => { addSpy.mockRestore(); removeSpy.mockRestore(); } };
}

/** Puts different answers in front of the fetch that `world` installed. */
function mockFetchOver(over: Routes) {
  const inner = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const p = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      const handler = over[`${method} ${p}`];
      if (handler === undefined) return inner(input, init);
      const reply = typeof handler === "function" ? handler({ url, body: undefined }) : handler;
      const status = reply.status ?? 200;
      if (status === 204) return new Response(null, { status });
      return new Response(JSON.stringify(reply.body ?? {}), { status, headers: { "content-type": "application/json" } });
    }),
  );
}
