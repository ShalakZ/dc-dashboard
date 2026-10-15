import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAssets, useInvalidate, keys } from "../api/queries";
import type { Asset, AssetImpact } from "../api/types";
import type { RemoveItem } from "../api/assetsBulk";
import { planDelete, type DeletePlan, type RemoveResult } from "../lib/assetsBulk";
import { buildTree } from "../lib/tree";
import { indexTree } from "../lib/treeMove";
import { holdFetch } from "../test/holdFetch";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { userFor } from "../test/users";
import { BulkDeleteAssetsDialog } from "./BulkDeleteAssetsDialog";

// Site
//   Hall A: Rack 1, Rack 2
//   Hall B
// Yard
const asset = (id: number, parent_id: number | null, name: string): Asset => ({ id, parent_id, name, kind: "room", sort_order: 0 });
const ASSETS: Asset[] = [asset(1, null, "Site"), asset(2, 1, "Hall A"), asset(3, 1, "Hall B"), asset(4, 2, "Rack 1"), asset(5, 2, "Rack 2"), asset(7, null, "Yard")];
const INDEX = indexTree(buildTree(ASSETS));
const plan = (...ids: number[]): DeletePlan => planDelete(ids, INDEX, (id) => INDEX.nameOf(id) ?? "?");
const impact = (assets = 1, mappings = 0, tariffs = 0): AssetImpact => ({ assets, mappings, tariffs });
const impactPath = (id: number) => `GET /api/assets/${id}/impact`;
const LEAF: Routes = Object.fromEntries([2, 3, 4, 5, 7].map((id) => [impactPath(id), { body: impact() }]));
const noneDeleted = (over: Partial<RemoveResult> = {}): RemoveResult => ({ deleted: [], gone: [], failed: null, notTried: [], assets: 0, ...over });
const didDelete = (ids: number[], assets = ids.length): RemoveResult => noneDeleted({ deleted: ids, assets });
const reasonOf = "Insufficient permission.";

const SAME_ASSETS: Routes = { "GET /api/me": { body: userFor("admin") }, "GET /api/setup": { body: { needed: false } }, "GET /api/assets": { body: ASSETS } };
const gets = (calls: { method: string; path: string }[], path: string) => calls.filter((c) => c.method === "GET" && c.path === path).length;

interface Spies { run: ReturnType<typeof vi.fn>; onStale: ReturnType<typeof vi.fn>; onDone: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> }

/** Something on the page that refreshes the asset list the way a delete does, and shows the list is read: the dialog must not follow it. */
function Refresher() {
  const invalidate = useInvalidate();
  const { data = [] } = useAssets();
  return (
    <>
      <button type="button" onClick={() => void invalidate(keys.assets, keys.fleet)}>refresh the lists</button>
      <span data-testid="assets">{data.length}</span>
    </>
  );
}

function open(p: DeletePlan, routes: Routes = {}, run: (items: RemoveItem[]) => Promise<RemoveResult> = async (items) => didDelete(items.map((i) => i.id)), { hold = false } = {}) {
  const calls = mockFetch({ ...SAME_ASSETS, ...LEAF, ...routes });
  const held = hold ? holdFetch((method, path) => method === "GET" && path.endsWith("/impact")) : null;
  const spies: Spies = { run: vi.fn(run), onStale: vi.fn(), onDone: vi.fn(), onCancel: vi.fn() };
  renderWithProviders(
    <>
      <Refresher />
      <BulkDeleteAssetsDialog plan={p} run={spies.run} onStale={spies.onStale} onDone={spies.onDone} onCancel={spies.onCancel} />
    </>,
  );
  return { calls, held, ...spies };
}
const dialog = (title: string) => screen.findByRole("dialog", { name: title });
const deleteButton = (name = "Delete") => screen.getByRole("button", { name });
/** The numbers are in: the button is on. */
const ready = async (name = "Delete") => { await waitFor(() => expect(deleteButton(name)).toBeEnabled()); };

describe("BulkDeleteAssetsDialog", () => {
  it("opens at once with the checking line and Delete off, before the impacts have arrived", async () => {
    const view = open(plan(4, 5), {}, undefined, { hold: true });
    expect(await dialog("Delete 2 assets?")).toHaveTextContent("Checking what this deletes…");
    expect(deleteButton()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Delete anyway" })).not.toBeInTheDocument(); // "anyway" is not known yet: the label does not change width when the numbers land
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(view.run).not.toHaveBeenCalled();
    await act(async () => view.held!.release());
    await ready();
  });

  it("lists the picked names and says it cannot be undone, with the plain Delete, when nothing else goes", async () => {
    open(plan(3, 4, 7));
    const box = await dialog("Delete 3 assets?");
    await ready();
    expect(box).toHaveTextContent("Rack 1, Hall B, Yard. This can't be undone."); // tree order, not pick order
    expect(box).not.toHaveTextContent("will be deleted"); // no billing warning for a plain delete
    expect(within(box).queryByRole("button", { name: "Delete anyway" })).not.toBeInTheDocument();
  });

  it("asks one impact per ROOT, never for a pick inside another pick", async () => {
    const view = open(plan(2, 4, 5, 7));
    await dialog("Delete 4 assets?");
    await ready();
    expect(gets(view.calls, "/api/assets/2/impact")).toBe(1);
    expect(gets(view.calls, "/api/assets/7/impact")).toBe(1);
    expect(gets(view.calls, "/api/assets/4/impact")).toBe(0);
    expect(gets(view.calls, "/api/assets/5/impact")).toBe(0);
  });

  it("names at most eight and counts the rest", async () => {
    const many: DeletePlan = {
      picked: Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, name: `Pick ${i + 1}` })),
      roots: Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, name: `Pick ${i + 1}` })),
      inside: [],
    };
    const routes: Routes = Object.fromEntries(many.roots.map((r) => [impactPath(r.id), { body: impact() }]));
    open(many, routes);
    const box = await dialog("Delete 10 assets?");
    await ready();
    expect(box).toHaveTextContent("Pick 1, Pick 2, Pick 3, Pick 4, Pick 5, Pick 6, Pick 7, Pick 8 and 2 more.");
    expect(box).not.toHaveTextContent("Pick 9");
  });

  it("says for a pick inside another pick that it goes with it, and counts the title by picks", async () => {
    open(plan(2, 4), { [impactPath(2)]: { body: impact(3) } });
    const box = await dialog("Delete 2 assets?");
    await ready("Delete anyway"); // Hall A has a Rack 2 nobody picked
    expect(box).toHaveTextContent("Hall A, Rack 1. Rack 1 is inside Hall A, which is also picked, so it goes with it. 3 assets, 0 mappings and 0 tariffs will be deleted; their past energy and cost figures disappear from Billing and dashboards. This can't be undone.");
  });

  it("is plain when the sub-assets are all picked, and Delete anyway when one is not or something is attached", async () => {
    // Hall A, Rack 1 and Rack 2 picked: 3 assets in the subtree, all of them picked
    open(plan(2, 4, 5), { [impactPath(2)]: { body: impact(3) } });
    await dialog("Delete 3 assets?");
    await ready();
    expect(deleteButton().textContent).toBe("Delete");
  });

  it.each([
    ["a mapping", impact(1, 1, 0), "1 asset, 1 mapping and 0 tariffs will be deleted"],
    ["a tariff", impact(1, 0, 2), "1 asset, 0 mappings and 2 tariffs will be deleted"],
  ])("a pick with %s on it is Delete anyway and says what goes", async (_name, counts, sentence) => {
    open(plan(7), { [impactPath(7)]: { body: counts } });
    const box = await dialog("Delete 1 asset?");
    await ready("Delete anyway");
    expect(box).toHaveTextContent(sentence);
    expect(box).toHaveTextContent("their past energy and cost figures disappear from Billing and dashboards. This can't be undone.");
  });

  it("adds the numbers of all the roots up", async () => {
    open(plan(2, 7), { [impactPath(2)]: { body: impact(3, 2, 0) }, [impactPath(7)]: { body: impact(1, 1, 1) } });
    const box = await dialog("Delete 2 assets?");
    await ready("Delete anyway");
    expect(box).toHaveTextContent("4 assets, 3 mappings and 1 tariff will be deleted");
  });

  it("a failed check is an error, and Delete stays off", async () => {
    open(plan(4, 5), { [impactPath(5)]: { status: 500, body: { detail: "database is locked" } } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not check what this deletes: database is locked");
    expect(deleteButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  describe("a pick that somebody else deleted", () => {
    const gone: Routes = { [impactPath(5)]: { status: 404, body: { detail: "asset not found" } } };

    it("blocks the dialog: only Close, the sentence, and the page is told once to refresh", async () => {
      const view = open(plan(4, 5), gone);
      const box = await dialog("Delete 2 assets?");
      await waitFor(() => expect(box).toHaveTextContent("Some of the picked assets were already deleted by someone else. The tree has been refreshed; pick again."));
      expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(view.onCancel).toHaveBeenCalledTimes(1);
      expect(view.onStale).toHaveBeenCalledTimes(1);
      expect(view.run).not.toHaveBeenCalled();
    });

    it("tells the page once even when the page re-renders", async () => {
      const view = open(plan(4, 5), gone);
      await screen.findByRole("button", { name: "Close" });
      await userEvent.click(screen.getByRole("button", { name: "refresh the lists" }));
      await waitFor(() => expect(gets(view.calls, "/api/assets")).toBeGreaterThan(1));
      expect(view.onStale).toHaveBeenCalledTimes(1);
    });
  });

  it("does not ask for the numbers again when the asset lists are refreshed while it is open (the key is outside the assets prefix)", async () => {
    const view = open(plan(4, 5));
    await dialog("Delete 2 assets?");
    await ready();
    const impactGets = () => view.calls.filter((c) => c.method === "GET" && c.path.endsWith("/impact")).length;
    const before = { impacts: impactGets(), lists: gets(view.calls, "/api/assets") };
    expect(before.impacts).toBe(2);
    await userEvent.click(screen.getByRole("button", { name: "refresh the lists" }));
    await waitFor(() => expect(gets(view.calls, "/api/assets")).toBeGreaterThan(before.lists)); // the list DID refresh...
    await act(async () => {});
    expect(impactGets()).toBe(before.impacts); // ...and the numbers the person read did not
    expect(deleteButton()).toBeEnabled();
  });

  describe("Delete", () => {
    it("runs the roots in tree order, each with the counts that were shown, and hands the result to the page", async () => {
      const result = didDelete([2, 7], 5);
      const view = open(plan(7, 4, 2), { [impactPath(2)]: { body: impact(3) }, [impactPath(7)]: { body: impact(2, 1, 0) } }, async () => result);
      await dialog("Delete 3 assets?");
      await ready("Delete anyway");
      await userEvent.click(deleteButton("Delete anyway"));
      await waitFor(() => expect(view.onDone).toHaveBeenCalledWith(result));
      expect(view.run).toHaveBeenCalledTimes(1);
      expect(view.run.mock.calls[0][0]).toEqual([
        { id: 2, name: "Hall A", seen: impact(3) },
        { id: 7, name: "Yard", seen: impact(2, 1, 0) },
      ]);
      expect(view.onCancel).not.toHaveBeenCalled();
    });

    it("a double press sends one run", async () => {
      let finish!: (r: RemoveResult) => void;
      const view = open(plan(4), {}, () => new Promise<RemoveResult>((resolve) => { finish = resolve; }));
      await dialog("Delete 1 asset?");
      await ready();
      const button = deleteButton();
      act(() => { button.click(); button.click(); });
      expect(view.run).toHaveBeenCalledTimes(1);
      await act(async () => finish(didDelete([4])));
      await waitFor(() => expect(view.onDone).toHaveBeenCalledTimes(1));
      expect(view.run).toHaveBeenCalledTimes(1);
    });

    it("nothing is sent while the numbers are loading", async () => {
      const view = open(plan(4), {}, undefined, { hold: true });
      await dialog("Delete 1 asset?");
      await userEvent.click(deleteButton()); // disabled: nothing happens
      expect(view.run).not.toHaveBeenCalled();
    });

    it("all of them already gone (a 404 each): the page is told, nothing was deleted", async () => {
      const result = noneDeleted({ gone: [4, 5] });
      const view = open(plan(4, 5), {}, async () => result);
      await dialog("Delete 2 assets?");
      await ready();
      await userEvent.click(deleteButton());
      await waitFor(() => expect(view.onDone).toHaveBeenCalledWith(result));
    });

    it("some went and one was refused: the page is told, with the report", async () => {
      const result = noneDeleted({ deleted: [4], assets: 1, failed: { id: 5, name: "Rack 2", reason: "Insufficient permission." }, notTried: [7] });
      const view = open(plan(4, 5, 7), {}, async () => result);
      await dialog("Delete 3 assets?");
      await ready();
      await userEvent.click(deleteButton());
      await waitFor(() => expect(view.onDone).toHaveBeenCalledWith(result));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // the toast says it, not the dialog
    });

    it("the first root was refused because more would go now: the dialog shows the new numbers and asks again; nothing was deleted", async () => {
      const refused = noneDeleted({ failed: { id: 2, name: "Hall A", reason: "More was added under it since the numbers were shown.", now: impact(4, 1, 0) }, notTried: [7] });
      const view = open(plan(2, 7), { [impactPath(2)]: { body: impact(3) } }, async () => refused);
      const box = await dialog("Delete 2 assets?");
      await ready("Delete anyway");
      expect(box).toHaveTextContent("4 assets, 0 mappings and 0 tariffs will be deleted"); // Hall A's 3 and the Yard's 1
      await userEvent.click(deleteButton("Delete anyway"));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("More was added while this was open. The numbers above are updated; delete again to confirm."));
      expect(box).toHaveTextContent("5 assets, 1 mapping and 0 tariffs will be deleted"); // Hall A's new 4 + the Yard's 1
      expect(view.onDone).not.toHaveBeenCalled();
      // The second press confirms what is on screen now.
      view.run.mockImplementationOnce(async () => didDelete([2, 7], 5));
      await userEvent.click(deleteButton("Delete anyway"));
      await waitFor(() => expect(view.onDone).toHaveBeenCalledTimes(1));
      expect(view.run.mock.calls[1][0]).toEqual([
        { id: 2, name: "Hall A", seen: impact(4, 1, 0) },
        { id: 7, name: "Yard", seen: impact(1) },
      ]);
    });

    it("the first was already gone and the second was refused: the dialog stays with the second's new numbers, and the second press sends both again", async () => {
      const refused = noneDeleted({ gone: [2], failed: { id: 7, name: "Yard", reason: "More was added under it since the numbers were shown.", now: impact(2, 0, 0) } });
      const view = open(plan(2, 7), {}, async () => refused);
      const box = await dialog("Delete 2 assets?");
      await ready();
      await userEvent.click(deleteButton());
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("More was added while this was open."));
      expect(view.onDone).not.toHaveBeenCalled();
      expect(box).toHaveTextContent("3 assets, 0 mappings and 0 tariffs will be deleted"); // Hall A's 1 + the Yard's new 2
      view.run.mockImplementationOnce(async () => noneDeleted({ gone: [2], deleted: [7], assets: 2 }));
      await userEvent.click(deleteButton("Delete anyway"));
      await waitFor(() => expect(view.onDone).toHaveBeenCalledTimes(1));
      expect(view.run.mock.calls[1][0].map((i: RemoveItem) => i.id)).toEqual([2, 7]);
      expect(view.run.mock.calls[1][0][1].seen).toEqual(impact(2, 0, 0));
    });

    it("another failure with nothing deleted: the dialog stays and shows the name and the reason", async () => {
      const refused = noneDeleted({ failed: { id: 4, name: "Rack 1", reason: reasonOf }, notTried: [5] });
      const view = open(plan(4, 5), {}, async () => refused);
      await dialog("Delete 2 assets?");
      await ready();
      await userEvent.click(deleteButton());
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent('"Rack 1" could not be deleted: Insufficient permission.'));
      expect(view.onDone).not.toHaveBeenCalled();
      expect(deleteButton()).toBeEnabled(); // it may be tried again
      expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    });

    it("a run that rejects (it should not) stays in the dialog with the message", async () => {
      const view = open(plan(4), {}, async () => { throw new Error("The connection was lost."); });
      await dialog("Delete 1 asset?");
      await ready();
      await userEvent.click(deleteButton());
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The connection was lost."));
      expect(view.onDone).not.toHaveBeenCalled();
    });
  });

  it("Cancel and Escape are the page's onCancel", async () => {
    const view = open(plan(4));
    await dialog("Delete 1 asset?");
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(view.onCancel).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(view.onCancel).toHaveBeenCalledTimes(2);
    expect(view.run).not.toHaveBeenCalled();
  });
});
