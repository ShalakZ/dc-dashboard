import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import type { Asset } from "../api/types";
import { buildTree } from "../lib/tree";
import { iconHtml } from "../test/iconHtml";
import { AssetTree, rowRenderProbe, type AssetTreeMove } from "./AssetTree";

const KEY = "dcdash.assetTreeFolded";
const a = (id: number, parent_id: number | null, name: string): Asset => ({ id, parent_id, name, kind: "generic", sort_order: id });

// Site > (Room A > Panel 1, Room B); Yard > Shed. Foldable: Site (1), Room A (2), Yard (5).
const flat: Asset[] = [a(1, null, "Site"), a(2, 1, "Room A"), a(3, 2, "Panel 1"), a(4, 1, "Room B"), a(5, null, "Yard"), a(6, 5, "Shed")];
const nodes = () => buildTree(flat);

type Props = Partial<Parameters<typeof AssetTree>[0]>;
const ui = (props: Props = {}) => (
  <MemoryRouter>
    <AssetTree nodes={nodes()} selectedId={null} {...props} />
  </MemoryRouter>
);

// A folded branch is hidden, so its rows are out of the accessibility tree: queries that must see inside it pass `hidden`.
const twisty = (name: string) => screen.getByRole("button", { name: `Children of ${name}`, hidden: true });
const link = (name: string) => screen.queryByRole("link", { name });
const collapseAll = () => screen.getByRole("button", { name: "Collapse all" });
const expandAll = () => screen.getByRole("button", { name: "Expand all" });
const expanded = (name: string) => twisty(name).getAttribute("aria-expanded");

describe("AssetTree fold state", () => {
  it("Collapse all folds every branch: no nested list is shown and each twisty says aria-expanded=false", async () => {
    render(ui());
    await userEvent.click(collapseAll());
    for (const name of ["Site", "Room A", "Yard"]) expect(expanded(name)).toBe("false");
    expect(link("Site")).toBeInTheDocument(); // the roots stay
    expect(link("Yard")).toBeInTheDocument();
    for (const name of ["Room A", "Room B", "Panel 1", "Shed"]) expect(link(name)).not.toBeInTheDocument();
    for (const list of document.querySelectorAll("ul.tree ul")) expect(list).not.toBeVisible();
  });

  it("Expand all shows everything again", async () => {
    render(ui());
    await userEvent.click(collapseAll());
    await userEvent.click(expandAll());
    for (const name of ["Site", "Room A", "Yard"]) expect(expanded(name)).toBe("true");
    for (const name of ["Room A", "Room B", "Panel 1", "Shed"]) expect(link(name)).toBeInTheDocument();
  });

  it("Expand all also opens a branch the user folded by hand", async () => {
    render(ui());
    await userEvent.click(twisty("Room A"));
    expect(link("Panel 1")).not.toBeInTheDocument();
    await userEvent.click(expandAll());
    expect(link("Panel 1")).toBeInTheDocument();
  });

  it("the two buttons are named Collapse all and Expand all, carry the same title, and sit before the column toggle", () => {
    render(ui());
    expect(collapseAll()).toHaveAttribute("title", "Collapse all");
    expect(expandAll()).toHaveAttribute("title", "Expand all");
    expect(collapseAll().querySelector("svg.i")).toHaveAttribute("aria-hidden", "true");
    const head = collapseAll().closest(".tree-head")!;
    const buttons = within(head as HTMLElement).getAllByRole("button");
    const toggle = within(head as HTMLElement).getByRole("button", { name: "Minimize asset tree" });
    expect(buttons.indexOf(collapseAll())).toBeLessThan(buttons.indexOf(expandAll()));
    expect(buttons.indexOf(expandAll())).toBeLessThan(buttons.indexOf(toggle));
  });

  it("is remembered: a reload (unmount, mount) keeps the fold, under dcdash.assetTreeFolded", async () => {
    const first = render(ui());
    await userEvent.click(collapseAll());
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([1, 2, 5]);
    first.unmount();
    render(ui());
    for (const name of ["Site", "Room A", "Yard"]) expect(expanded(name)).toBe("false");
    expect(link("Room B")).not.toBeInTheDocument();
  });

  it("a branch folded by hand is remembered too, and opening it again is remembered", async () => {
    const first = render(ui());
    await userEvent.click(twisty("Yard"));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([5]);
    first.unmount();
    render(ui());
    expect(expanded("Yard")).toBe("false");
    expect(expanded("Site")).toBe("true");
    await userEvent.click(twisty("Yard"));
    expect(localStorage.getItem(KEY)).toBe("none"); // an explicit "nothing folded" is the text none, never []
  });

  it("both buttons wait while the filter has text and are back when it is cleared", async () => {
    render(ui());
    const filter = screen.getByLabelText("Filter assets");
    expect(collapseAll()).toBeEnabled();
    expect(expandAll()).toBeEnabled();
    await userEvent.type(filter, "panel");
    expect(collapseAll()).toBeDisabled();
    expect(expandAll()).toBeDisabled();
    await userEvent.clear(filter);
    expect(collapseAll()).toBeEnabled();
    expect(expandAll()).toBeEnabled();
  });

  it("a filter of spaces filters nothing, so the buttons stay enabled", async () => {
    render(ui());
    await userEvent.type(screen.getByLabelText("Filter assets"), "  ");
    expect(collapseAll()).toBeEnabled();
  });

  it("both buttons are disabled when nothing can be folded", () => {
    render(ui({ nodes: buildTree([a(1, null, "Site"), a(2, null, "Yard")]) }));
    expect(collapseAll()).toBeDisabled();
    expect(expandAll()).toBeDisabled();
  });

  it("minimized, the column shows neither button (they are not rendered, like the title)", () => {
    localStorage.setItem("dcdash.assetTree", "minimized");
    render(ui());
    expect(screen.queryByRole("button", { name: "Collapse all", hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Expand all", hidden: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand asset tree" })).toBeInTheDocument();
  });

  describe("revealing the selected asset", () => {
    it("opens the ancestors of the selection when it is inside a folded branch from an earlier visit", () => {
      localStorage.setItem(KEY, "[1,2,5]");
      render(ui({ selectedId: 3 }));
      expect(expanded("Site")).toBe("true");
      expect(expanded("Room A")).toBe("true");
      expect(expanded("Yard")).toBe("false"); // not on the way
      expect(link("Panel 1")).toBeInTheDocument();
    });

    it("a different selectedId inside a folded branch unfolds only its ancestors", async () => {
      const view = render(ui({ selectedId: 5 }));
      await userEvent.click(collapseAll());
      view.rerender(ui({ selectedId: 3 }));
      expect(expanded("Site")).toBe("true");
      expect(expanded("Room A")).toBe("true");
      expect(expanded("Yard")).toBe("false"); // the others stay folded
      expect(link("Panel 1")).toBeInTheDocument();
      expect(link("Shed")).not.toBeInTheDocument();
    });

    it("Collapse all with the selected asset inside does not re-open it by itself", async () => {
      render(ui({ selectedId: 3 }));
      expect(link("Panel 1")).toBeInTheDocument();
      await userEvent.click(collapseAll());
      for (const name of ["Site", "Room A", "Yard"]) expect(expanded(name)).toBe("false");
      expect(link("Panel 1")).not.toBeInTheDocument();
    });

    it("a re-render with a NEW, structurally equal nodes array plus one unrelated extra node does not re-open the ancestors", async () => {
      const view = render(ui({ selectedId: 3 }));
      await userEvent.click(collapseAll());
      view.rerender(ui({ selectedId: 3, nodes: buildTree([...flat, a(7, null, "Annex")]) }));
      expect(link("Annex")).toBeInTheDocument(); // the new list did arrive
      for (const name of ["Site", "Room A", "Yard"]) expect(expanded(name)).toBe("false");
      expect(link("Panel 1")).not.toBeInTheDocument();
      view.rerender(ui({ selectedId: 3, nodes: nodes() })); // and a rename or a delete elsewhere is no different
      for (const name of ["Site", "Room A"]) expect(expanded(name)).toBe("false");
    });

    it("a reparent of the selected asset unfolds the new way to it", async () => {
      const view = render(ui({ selectedId: 3 }));
      await userEvent.click(collapseAll());
      // Panel 1 moves under Room B, which gets a child and so becomes foldable.
      view.rerender(ui({ selectedId: 3, nodes: buildTree(flat.map((x) => (x.id === 3 ? { ...x, parent_id: 4 } : x))) }));
      expect(expanded("Site")).toBe("true");
      expect(expanded("Room B")).toBe("true");
      expect(link("Panel 1")).toBeInTheDocument();
      expect(expanded("Yard")).toBe("false");
    });

    it("selecting a root or nothing opens nothing", async () => {
      const view = render(ui({ selectedId: null }));
      await userEvent.click(collapseAll());
      view.rerender(ui({ selectedId: 1 }));
      view.rerender(ui({ selectedId: 99 })); // unknown id
      for (const name of ["Site", "Room A", "Yard"]) expect(expanded(name)).toBe("false");
    });

    it("works while the list is still loading: the fold waits for the nodes, then the selection is revealed", () => {
      localStorage.setItem(KEY, "[1,2,5]");
      const view = render(ui({ nodes: [], selectedId: 3 }));
      expect(localStorage.getItem(KEY)).toBe("[1,2,5]"); // nothing is pruned while the list is empty
      view.rerender(ui({ selectedId: 3 }));
      expect(expanded("Site")).toBe("true");
      expect(expanded("Room A")).toBe("true");
      expect(expanded("Yard")).toBe("false");
    });
  });

  describe("what is remembered follows the tree", () => {
    it("a node that gains its first child starts open", async () => {
      const view = render(ui());
      await userEvent.click(collapseAll());
      view.rerender(ui({ nodes: buildTree([...flat, a(7, 4, "Rack")]) })); // Room B (4) was a leaf
      expect(expanded("Room B")).toBe("true");
      expect(expanded("Site")).toBe("false"); // Site is still folded, so Rack is hidden inside it
      await userEvent.click(twisty("Site"));
      expect(link("Rack")).toBeInTheDocument();
    });

    it("a folded node that loses its children and gains one later starts open, and the stored ids are pruned", async () => {
      const view = render(ui());
      await userEvent.click(twisty("Room A"));
      expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([2]);
      view.rerender(ui({ nodes: buildTree(flat.filter((x) => x.id !== 3)) })); // Panel 1 deleted: Room A is a leaf
      expect(screen.queryByRole("button", { name: "Children of Room A" })).not.toBeInTheDocument();
      expect(localStorage.getItem(KEY)).toBe("none");
      view.rerender(ui()); // Room A gets a child again
      expect(expanded("Room A")).toBe("true");
      expect(link("Panel 1")).toBeInTheDocument();
    });

    it("ids of assets that no longer exist are dropped from what is stored once the list is known", () => {
      localStorage.setItem(KEY, "[1,999]");
      render(ui());
      expect(expanded("Site")).toBe("false");
      expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([1]);
    });
  });

  describe("storage that is garbage, blocked or full", () => {
    it.each(["{nope", '{"a":1}', "7", '["x",1.5]'])("garbage in storage (%s) means everything open", (text) => {
      localStorage.setItem(KEY, text);
      render(ui());
      for (const name of ["Site", "Room A", "Yard"]) expect(expanded(name)).toBe("true");
    });

    it("a stored list of more than 5000 ids is ignored", () => {
      localStorage.setItem(KEY, JSON.stringify(Array.from({ length: 5001 }, (_, i) => i + 1)));
      render(ui());
      expect(expanded("Site")).toBe("true");
    });

    it("never raises when reading and writing storage throws, and folding still works for the visit", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
      render(ui({ selectedId: 3 }));
      await userEvent.click(collapseAll());
      expect(expanded("Site")).toBe("false");
      await userEvent.click(expandAll());
      expect(expanded("Site")).toBe("true");
      await userEvent.click(twisty("Yard"));
      expect(expanded("Yard")).toBe("false");
    });
  });
});

// w17: a big tree opens folded. Root > 3 Halls > 7 Rows each > 2 Racks each = 1 + 3 + 21 + 42 = 67 nodes, above the 60 rows a tree opens whole.
// Level 2 shows the Root and its Halls; every Hall and Row is folded, the Root is open.
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const rowId = (hall: number, j: number) => 10 + (hall - 1) * 7 + j; // 10..30
const rackId = (hall: number, j: number, k: number) => 100 + ((hall - 1) * 7 + j) * 2 + k; // 100..141
const bigAssets = (): Asset[] => {
  const out: Asset[] = [a(1, null, "Root")];
  for (let h = 1; h <= 3; h++) {
    out.push(a(h + 1, 1, `Hall ${h}`));
    for (let j = 0; j < 7; j++) {
      out.push(a(rowId(h, j), h + 1, `Row ${h}.${j}`));
      for (let k = 0; k < 2; k++) out.push(a(rackId(h, j, k), rowId(h, j), `Rack ${h}.${j}.${k}`));
    }
  }
  return out;
};
const bigNodes = () => buildTree(bigAssets());
const DEFAULT_FOLDED = [2, 3, 4, ...range(10, 30)]; // every Hall and Row
const ALL_FOLDABLE = [1, ...DEFAULT_FOLDED];
const shown = (name: string) => screen.queryByRole("link", { name }) !== null;
const savedFold = () => JSON.parse(localStorage.getItem(KEY)!) as number[];
const expectLevel2 = () => {
  expect(shown("Root")).toBe(true);
  for (const hall of [1, 2, 3]) expect(shown(`Hall ${hall}`)).toBe(true);
  expect(shown("Row 1.0")).toBe(false);
  expect(shown("Rack 1.0.0")).toBe(false);
  expect(expanded("Root")).toBe("true");
  expect(expanded("Hall 1")).toBe("false");
  expect(expanded("Row 1.0")).toBe("false");
};

describe("AssetTree opens folded when it is big (w17)", () => {
  it("a tree of more than 60 nodes with nothing remembered opens at level 2 and a visit writes nothing", () => {
    expect(bigAssets()).toHaveLength(67);
    render(ui({ nodes: bigNodes() }));
    expectLevel2();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("the [] that the old code wrote on every visit means nothing remembered: level 2", () => {
    localStorage.setItem(KEY, "[]");
    render(ui({ nodes: bigNodes() }));
    expectLevel2();
    expect(localStorage.getItem(KEY)).toBe("[]"); // not touched by a visit that changes nothing
  });

  it("the text none (an explicit Expand all) opens it fully", () => {
    localStorage.setItem(KEY, "none");
    render(ui({ nodes: bigNodes() }));
    expect(shown("Rack 3.6.1")).toBe(true);
    for (const twistyButton of document.querySelectorAll("button.twisty")) expect(twistyButton).toHaveAttribute("aria-expanded", "true");
    expect(localStorage.getItem(KEY)).toBe("none");
  });

  it("a remembered list folds exactly those branches", () => {
    localStorage.setItem(KEY, "[2,3]");
    render(ui({ nodes: bigNodes() }));
    expect(expanded("Root")).toBe("true");
    expect(expanded("Hall 1")).toBe("false");
    expect(expanded("Hall 2")).toBe("false");
    expect(expanded("Hall 3")).toBe("true");
    expect(expanded("Row 3.0")).toBe("true"); // the default does not apply once something is remembered
    expect(shown("Rack 3.0.0")).toBe(true);
    expect(shown("Row 1.0")).toBe(false);
    expect(savedFold()).toEqual([2, 3]);
  });

  it("a 6-node tree opens fully and a visit writes nothing", () => {
    render(ui());
    for (const name of ["Site", "Room A", "Yard"]) expect(expanded(name)).toBe("true");
    expect(link("Panel 1")).toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("a tree of exactly 60 nodes opens whole", () => {
    const sixty = bigAssets().slice(0, 60);
    render(ui({ nodes: buildTree(sixty) }));
    expect(expanded("Root")).toBe("true");
    expect(expanded("Hall 1")).toBe("true");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("Collapse all stores every foldable id", async () => {
    render(ui({ nodes: bigNodes() }));
    await userEvent.click(collapseAll());
    expect(savedFold()).toEqual(ALL_FOLDABLE);
    expect(shown("Root")).toBe(true);
    expect(shown("Hall 1")).toBe(false);
    expect(expanded("Root")).toBe("false");
  });

  it("Expand all stores the text none and shows everything, and a remount keeps it", async () => {
    const first = render(ui({ nodes: bigNodes() }));
    await userEvent.click(expandAll());
    expect(localStorage.getItem(KEY)).toBe("none");
    expect(shown("Rack 3.6.1")).toBe(true);
    first.unmount();
    render(ui({ nodes: bigNodes() }));
    expect(shown("Rack 3.6.1")).toBe(true);
    expect(expanded("Row 2.2")).toBe("true");
  });

  it("Collapse all and Expand all work from the default state, one after the other", async () => {
    render(ui({ nodes: bigNodes() }));
    expect(collapseAll()).toBeEnabled();
    expect(expandAll()).toBeEnabled();
    await userEvent.click(collapseAll());
    expect(shown("Hall 1")).toBe(false);
    await userEvent.click(expandAll());
    expect(shown("Hall 1")).toBe(true);
    expect(shown("Rack 2.3.1")).toBe(true);
  });

  it("a twisty click on the default state stores the default set plus that change", async () => {
    const first = render(ui({ nodes: bigNodes() }));
    await userEvent.click(twisty("Root")); // folds the Root as well
    expect(savedFold()).toEqual(ALL_FOLDABLE);
    first.unmount();
    localStorage.clear();
    render(ui({ nodes: bigNodes() }));
    await userEvent.click(twisty("Hall 1")); // opens a folded Hall: its Rows show, their Racks stay folded
    expect(savedFold()).toEqual(DEFAULT_FOLDED.filter((id) => id !== 2));
    expect(shown("Row 1.0")).toBe(true);
    expect(shown("Rack 1.0.0")).toBe(false);
    expect(expanded("Hall 2")).toBe("false");
  });

  it("an asset inside the folded part opens only its own way, and that state is remembered", () => {
    render(ui({ nodes: bigNodes(), selectedId: rackId(2, 3, 1) }));
    expect(shown("Rack 2.3.1")).toBe(true);
    expect(expanded("Root")).toBe("true");
    expect(expanded("Hall 2")).toBe("true");
    expect(expanded("Row 2.3")).toBe("true");
    expect(expanded("Hall 1")).toBe("false"); // the rest stays at the default
    expect(expanded("Hall 3")).toBe("false");
    expect(expanded("Row 2.4")).toBe("false");
    expect(shown("Rack 2.4.0")).toBe(false);
    expect(savedFold()).toEqual(DEFAULT_FOLDED.filter((id) => id !== 3 && id !== rowId(2, 3)));
  });

  it("a new nodes array of the same shape keeps the default (nothing is folded or opened by a refetch)", async () => {
    const view = render(ui({ nodes: bigNodes() }));
    view.rerender(ui({ nodes: bigNodes() }));
    expectLevel2();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("a big tree that arrives after an empty list opens at level 2 in its first frame", () => {
    const view = render(ui({ nodes: [] }));
    view.rerender(ui({ nodes: bigNodes() }));
    expectLevel2();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  describe("adding a child (+)", () => {
    // The 67 nodes above plus three leaves under the Root: 70 nodes, and "Lab" is a leaf at depth 1 (no twisty, so the default does not fold it).
    const withLeaves = (extra: Asset[] = []) => buildTree([...bigAssets(), a(200, 1, "Lab"), a(201, 1, "Spare 1"), a(202, 1, "Spare 2"), ...extra]);
    const lab = (extra: Asset[] = []) => ui({ nodes: withLeaves(extra), onAddChild });
    let onAddChild: ReturnType<typeof vi.fn>;
    beforeEach(() => { onAddChild = vi.fn(); });

    it("the child of a leaf in a big tree with nothing remembered shows when it arrives: the + remembers the fold of the moment", async () => {
      const view = render(lab());
      expect(bigAssets().length + 3).toBe(70);
      expect(localStorage.getItem(KEY)).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Add child of Lab" }));
      expect(onAddChild).toHaveBeenCalledWith(200);
      expect(savedFold()).toEqual(DEFAULT_FOLDED); // the default, written: it is what the person saw when they pressed +
      // The refetch lands: Lab now has a child. A level-2 default would fold Lab (a foldable row at depth 1); the remembered fold does not.
      view.rerender(lab([a(300, 200, "Lab rack")]));
      const child = screen.getByRole("link", { name: "Lab rack" });
      expect(child.closest("[hidden]")).toBeNull();
      expect(expanded("Lab")).toBe("true");
      expect(savedFold()).toEqual(DEFAULT_FOLDED); // the new foldable row is not added to what is folded
      expect(expanded("Hall 1")).toBe("false"); // the rest is still at the default
    });

    it("without the + the same refetch folds the new child, which is what the + guards against", () => {
      const view = render(lab());
      view.rerender(lab([a(300, 200, "Lab rack")]));
      expect(screen.getByRole("link", { name: "Lab rack", hidden: true }).closest("[hidden]")).not.toBeNull();
    });

    it("a small tree with nothing remembered stays that way: the + stores nothing and changes no row", async () => {
      render(ui({ onAddChild })); // the 6-node tree: its fold is empty, so there is nothing to protect
      const before = Array.from(document.querySelectorAll(".node")).map((n) => n.textContent);
      await userEvent.click(screen.getByRole("button", { name: "Add child of Panel 1" }));
      expect(onAddChild).toHaveBeenCalledWith(3);
      expect(localStorage.getItem(KEY)).toBeNull();
      expect(Array.from(document.querySelectorAll(".node")).map((n) => n.textContent)).toEqual(before);
      for (const name of ["Site", "Room A", "Yard"]) expect(expanded(name)).toBe("true");
    });

    describe("an empty fold in a tree that will be big", () => {
      // Nothing is folded and nothing is remembered, yet the new child can turn the default on: the + writes "nothing folded" (the text none) first.
      const flat = (n: number, extra: Asset[] = []) => buildTree([...range(1, n).map((i) => a(i, null, `Leaf ${i}`)), ...extra]);
      const siteWith = (leaves: number, extra: Asset[] = []) => buildTree([a(1, null, "Site"), ...range(2, leaves + 1).map((i) => a(i, 1, `Leaf ${i}`)), ...extra]);

      it("70 top-level leaves with nothing stored: the + remembers none, and the new child is not folded away when it arrives", async () => {
        const view = render(ui({ nodes: flat(70), onAddChild }));
        expect(localStorage.getItem(KEY)).toBeNull();
        await userEvent.click(screen.getByRole("button", { name: "Add child of Leaf 5" }));
        expect(onAddChild).toHaveBeenCalledWith(5);
        expect(localStorage.getItem(KEY)).toBe("none");
        view.rerender(ui({ nodes: flat(70, [a(300, 5, "Leaf 5 child")]), onAddChild })); // Leaf 5 is foldable now: a level-1 default would fold it
        expect(screen.getByRole("link", { name: "Leaf 5 child" }).closest("[hidden]")).toBeNull();
        expect(expanded("Leaf 5")).toBe("true");
        expect(localStorage.getItem(KEY)).toBe("none");
      });

      it("without the + the same refetch folds that child, which is what the write guards against", () => {
        const view = render(ui({ nodes: flat(70), onAddChild }));
        view.rerender(ui({ nodes: flat(70, [a(300, 5, "Leaf 5 child")]), onAddChild }));
        expect(screen.getByRole("link", { name: "Leaf 5 child", hidden: true }).closest("[hidden]")).not.toBeNull();
      });

      it("a tree of exactly 60 nodes (a Site and 59 leaves): the + on a leaf remembers none, and the child that makes it 61 is shown", async () => {
        const view = render(ui({ nodes: siteWith(59), onAddChild }));
        expect(shown("Leaf 2")).toBe(true);
        await userEvent.click(screen.getByRole("button", { name: "Add child of Leaf 2" }));
        expect(localStorage.getItem(KEY)).toBe("none");
        view.rerender(ui({ nodes: siteWith(59, [a(300, 2, "Leaf 2 child")]), onAddChild })); // 61 nodes: the size default folds every Leaf that has a child
        expect(screen.getByRole("link", { name: "Leaf 2 child" }).closest("[hidden]")).toBeNull();
      });

      it("a tree of 59 nodes stays small after the add (60), so the + stores nothing", async () => {
        render(ui({ nodes: siteWith(58), onAddChild }));
        await userEvent.click(screen.getByRole("button", { name: "Add child of Leaf 2" }));
        expect(onAddChild).toHaveBeenCalledWith(2);
        expect(localStorage.getItem(KEY)).toBeNull();
      });
    });

    it("a big tree whose remembered fold is the text none: the + changes nothing and writes nothing", async () => {
      localStorage.setItem(KEY, "none");
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      const view = render(lab());
      expect(shown("Rack 3.6.1")).toBe(true); // opened fully by the remembered none
      setItem.mockClear(); // a remembered fold is written back once when the tree mounts; only what the + does counts
      await userEvent.click(screen.getByRole("button", { name: "Add child of Lab" }));
      expect(onAddChild).toHaveBeenCalledWith(200);
      expect(setItem.mock.calls.filter(([key]) => key === KEY)).toEqual([]);
      expect(localStorage.getItem(KEY)).toBe("none");
      view.rerender(lab([a(300, 200, "Lab rack")])); // the child arrives into a tree that is open anyway
      expect(screen.getByRole("link", { name: "Lab rack" }).closest("[hidden]")).toBeNull();
    });

    it("a folded branch is opened by the + on it, so its new child is not inside it", async () => {
      localStorage.setItem(KEY, JSON.stringify(DEFAULT_FOLDED));
      render(lab());
      expect(expanded("Hall 1")).toBe("false");
      // Hall 1's own + sits on its row, which is shown (the Root is open): pressing it opens the Hall before the child arrives.
      await userEvent.click(screen.getByRole("button", { name: "Add child of Hall 1" }));
      expect(expanded("Hall 1")).toBe("true");
      expect(savedFold()).toEqual(DEFAULT_FOLDED.filter((id) => id !== 2));
    });
  });
});

describe("AssetTree scrolls the open asset into view (w17)", () => {
  const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  /** The scroll box and the open row, as a layout would report them. `seen` gets one entry per measure of the open row: was its way still hidden? */
  const mockRects = (box: [number, number], row: [number, number]) => {
    const seen: boolean[] = [];
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("tree-scroll")) return rect(...box);
      if (this.matches(".node.is-selected")) {
        seen.push(this.closest("[hidden]") !== null);
        return rect(...row);
      }
      return rect(0, 0);
    });
    return seen;
  };
  const scrollBox = () => document.querySelector<HTMLElement>(".tree-scroll")!;
  const deep = rackId(2, 3, 1);

  it("a row below the box is centred in it, measured only once its way is open", () => {
    const seen = mockRects([100, 400], [700, 730]);
    render(ui({ nodes: bigNodes(), selectedId: deep }));
    expect(scrollBox().scrollTop).toBe(715 - 250); // the row's centre minus the box's centre
    expect(seen).toEqual([false]); // never measured while it sat inside a folded branch
  });

  it("a row inside the box leaves the scroll alone", () => {
    const seen = mockRects([100, 400], [150, 180]);
    render(ui({ nodes: bigNodes(), selectedId: deep }));
    expect(scrollBox().scrollTop).toBe(0);
    expect(seen).toEqual([false]);
  });

  it("a row cut by the bottom edge scrolls by the part that is out, not to the middle", () => {
    mockRects([100, 400], [380, 412]); // 12px below the box's bottom
    render(ui({ nodes: bigNodes(), selectedId: deep }));
    expect(scrollBox().scrollTop).toBe(12);
  });

  it("a row cut by the top edge scrolls back by the part that is out, not to the middle", () => {
    mockRects([100, 400], [700, 730]);
    const view = render(ui({ nodes: bigNodes(), selectedId: deep }));
    expect(scrollBox().scrollTop).toBe(465); // far outside: centred
    mockRects([100, 400], [88, 120]); // 12px above the box's top
    view.rerender(ui({ nodes: bigNodes(), selectedId: rackId(3, 6, 1) }));
    expect(scrollBox().scrollTop).toBe(465 - 12);
  });

  it("a row that only touches the box from outside counts as outside and is centred", () => {
    mockRects([100, 400], [400, 430]); // its top is the box's bottom: none of it is in view
    render(ui({ nodes: bigNodes(), selectedId: deep }));
    expect(scrollBox().scrollTop).toBe(415 - 250);
  });

  it("a layout with no sizes (no rects) changes nothing", () => {
    render(ui({ nodes: bigNodes(), selectedId: deep }));
    expect(scrollBox().scrollTop).toBe(0);
  });

  it("it happens once: a later render does not pull the row back after the person scrolled", () => {
    mockRects([100, 400], [700, 730]);
    const view = render(ui({ nodes: bigNodes(), selectedId: deep }));
    scrollBox().scrollTop = 7;
    view.rerender(ui({ nodes: bigNodes(), selectedId: deep }));
    expect(scrollBox().scrollTop).toBe(7);
  });

  it("a new selection scrolls again", () => {
    mockRects([100, 400], [700, 730]);
    const view = render(ui({ nodes: bigNodes(), selectedId: deep }));
    scrollBox().scrollTop = 0;
    view.rerender(ui({ nodes: bigNodes(), selectedId: rackId(3, 6, 1) }));
    expect(scrollBox().scrollTop).toBe(465);
  });

  it("the mark waits for the list: a selection while the tree loads scrolls once the rows are there", () => {
    const seen = mockRects([100, 400], [700, 730]);
    const view = render(ui({ nodes: [], loading: true, selectedId: deep }));
    expect(seen).toEqual([]);
    view.rerender(ui({ nodes: bigNodes(), selectedId: deep }));
    expect(scrollBox().scrollTop).toBe(465);
    expect(seen).toEqual([false]);
  });

  it("an id that is not in the tree scrolls nothing and the mark is dropped", () => {
    const seen = mockRects([100, 400], [700, 730]);
    const view = render(ui({ nodes: bigNodes(), selectedId: 9999 }));
    expect(scrollBox().scrollTop).toBe(0);
    expect(seen).toEqual([]);
    view.rerender(ui({ nodes: bigNodes(), selectedId: 9999 }));
    expect(seen).toEqual([]);
  });

  it("while the filter hides the row nothing scrolls, and clearing the filter later does not scroll either", async () => {
    const seen = mockRects([100, 400], [700, 730]);
    const view = render(ui({ nodes: bigNodes(), selectedId: null }));
    const filter = screen.getByLabelText("Filter assets");
    await userEvent.type(filter, "Hall 3"); // shows Root > Hall 3 only
    view.rerender(ui({ nodes: bigNodes(), selectedId: deep })); // Rack 2.3.1 is not in that
    expect(shown("Rack 2.3.1")).toBe(false);
    expect(scrollBox().scrollTop).toBe(0);
    await userEvent.clear(filter);
    expect(shown("Rack 2.3.1")).toBe(true); // the row is back, on screen
    expect(scrollBox().scrollTop).toBe(0); // and the dropped mark does not pull it into view
    expect(seen).toEqual([]);
  });

  it("a filter that shows the row still scrolls to it", async () => {
    mockRects([100, 400], [700, 730]);
    const view = render(ui({ nodes: bigNodes(), selectedId: null }));
    await userEvent.type(screen.getByLabelText("Filter assets"), "Rack 2.3.1");
    view.rerender(ui({ nodes: bigNodes(), selectedId: deep }));
    expect(scrollBox().scrollTop).toBe(465);
  });

  it("a minimized column scrolls nothing and keeps the mark for when it is opened", async () => {
    localStorage.setItem("dcdash.assetTree", "minimized");
    const seen = mockRects([100, 400], [700, 730]);
    render(ui({ nodes: bigNodes(), selectedId: deep }));
    expect(seen).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Expand asset tree" }));
    expect(scrollBox().scrollTop).toBe(465);
  });
});

describe("AssetTree width", () => {
  const WIDTH_KEY = "dcdash.assetTreeWidth";
  const realViewport = window.innerWidth;
  const RealResizeObserver = globalThis.ResizeObserver; // the no-op stub of src/test/setup.ts, put back after a test that records
  const setViewport = (px: number) => { Object.defineProperty(window, "innerWidth", { value: px, configurable: true, writable: true }); };
  const max = () => Math.floor(window.innerWidth / 2);
  const rect = (left: number, width: number) => ({ left, width, right: left + width, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

  const column = () => screen.getByRole("region", { name: "Asset tree" });
  const separator = () => screen.getByRole("separator", { name: "Resize the tree column" });
  const userWidth = () => column().style.getPropertyValue("--tree-user-w");
  const stored = () => localStorage.getItem(WIDTH_KEY);
  const valueNow = () => separator().getAttribute("aria-valuenow");
  // The width right of the sidebar is the column's parent (jsdom has no layout, so it is 0 until a test gives it one).
  const layout = (px: number) => Object.defineProperty(column().parentElement!, "clientWidth", { value: px, configurable: true });
  const resized = () => fireEvent(window, new Event("resize"));

  // jsdom has no PointerEvent, so these are MouseEvents with a pointer type name: React routes by the type and reads clientX from them.
  const point = (type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", clientX: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 7 });
    fireEvent(separator(), event);
  };

  let setCapture: ReturnType<typeof vi.fn>;
  let releaseCapture: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    setViewport(1200); // half of it (600) is under what leaves the pane 560 px (640), so "half the window" below holds
    setCapture = vi.fn();
    releaseCapture = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { value: setCapture, configurable: true, writable: true });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { value: releaseCapture, configurable: true, writable: true });
  });
  afterEach(() => {
    setViewport(realViewport);
    delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture;
    delete (HTMLElement.prototype as { releasePointerCapture?: unknown }).releasePointerCapture;
  });

  describe("the handle", () => {
    it("is a vertical separator in the column that can take focus, named Resize the tree column", () => {
      render(ui());
      const handle = separator();
      expect(column()).toContainElement(handle);
      expect(handle).toHaveClass("tree-resize");
      expect(handle).toHaveAttribute("aria-orientation", "vertical");
      expect(handle).toHaveAttribute("aria-label", "Resize the tree column");
      expect(handle).toHaveAttribute("tabindex", "0");
    });

    it("reports its range and the stored width: 220 to half the window, now 300", () => {
      localStorage.setItem(WIDTH_KEY, "300");
      render(ui());
      expect(separator()).toHaveAttribute("aria-valuemin", "220");
      expect(separator()).toHaveAttribute("aria-valuemax", String(max()));
      expect(separator()).toHaveAttribute("aria-valuenow", "300");
    });

    it("with nothing stored it reports the width the column has, and sets no inline width", () => {
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect(0, 248));
      render(ui());
      expect(valueNow()).toBe("248");
      expect(userWidth()).toBe("");
      expect(column().getAttribute("style") ?? "").not.toContain("--tree-user-w");
    });

    it("still reports a number for a column that has no layout (a width of 0 is no measurement)", () => {
      render(ui());
      expect(valueNow()).toBe("280");
    });

    it("is not there while the column is minimized, and is back when it is expanded", async () => {
      localStorage.setItem("dcdash.assetTree", "minimized");
      render(ui());
      expect(screen.queryByRole("separator", { hidden: true })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Expand asset tree" }));
      expect(separator()).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Minimize asset tree" }));
      expect(screen.queryByRole("separator", { hidden: true })).not.toBeInTheDocument();
    });
  });

  describe("the stored width", () => {
    it("is applied on mount as --tree-user-w on the column", () => {
      localStorage.setItem(WIDTH_KEY, "340");
      render(ui());
      expect(userWidth()).toBe("340px");
    });

    it("is clamped when it is applied: 10 gives 220, 99999 gives half the window", () => {
      localStorage.setItem(WIDTH_KEY, "10");
      const first = render(ui());
      expect(userWidth()).toBe("220px");
      first.unmount();
      localStorage.setItem(WIDTH_KEY, "99999");
      render(ui());
      expect(userWidth()).toBe(`${max()}px`);
    });

    it.each(["wide", "", "300px", "-5"])("is ignored when it is garbage (%j): no inline width", (text) => {
      localStorage.setItem(WIDTH_KEY, text);
      render(ui());
      expect(userWidth()).toBe("");
      expect(Number(valueNow())).toBeGreaterThanOrEqual(220);
    });

    it("never raises when reading and writing storage throws, and the keys still resize the column for the visit", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
      render(ui());
      expect(userWidth()).toBe("");
      separator().focus();
      await userEvent.keyboard("{End}");
      expect(userWidth()).toBe(`${max()}px`);
    });

    it("stays on the column through a minimize and an expand", async () => {
      localStorage.setItem(WIDTH_KEY, "340");
      render(ui());
      await userEvent.click(screen.getByRole("button", { name: "Minimize asset tree" }));
      expect(userWidth()).toBe("340px"); // the minimized state has its own --w in the CSS and ignores it
      await userEvent.click(screen.getByRole("button", { name: "Expand asset tree" }));
      expect(userWidth()).toBe("340px");
      expect(valueNow()).toBe("340");
    });

    it("follows the window: a smaller window shows less, the stored width is kept, and a larger one brings it back", () => {
      setViewport(1400);
      localStorage.setItem(WIDTH_KEY, "600");
      render(ui());
      expect(valueNow()).toBe("600");
      setViewport(1000);
      resized();
      expect(userWidth()).toBe("440px"); // the pane keeps 560 of the 1000
      expect(valueNow()).toBe("440");
      expect(separator()).toHaveAttribute("aria-valuemax", "440");
      expect(stored()).toBe("600"); // a window resize is not a choice of the user
      setViewport(1400);
      resized();
      expect(userWidth()).toBe("600px");
      expect(separator()).toHaveAttribute("aria-valuemax", "700");
    });

    it("a width saved on a wide screen survives a visit at a small window: opened at 1024, enlarged to 1440, 720 is back (review M-4)", () => {
      setViewport(1024);
      localStorage.setItem(WIDTH_KEY, "720");
      render(ui());
      expect(valueNow()).toBe("464"); // 1024 - 560
      expect(stored()).toBe("720"); // reading is not choosing
      setViewport(1440);
      resized();
      expect(valueNow()).toBe("720");
      expect(userWidth()).toBe("720px");
    });

    it("follows the layout, not the window: the area right of the sidebar sets the limit, and a smaller one shows the clamped width (review I-1, M-4)", () => {
      localStorage.setItem(WIDTH_KEY, "720");
      setViewport(1600);
      render(ui());
      layout(1000); // the sidebar and whatever else takes room: 1000 px are left for the columns
      resized();
      expect(valueNow()).toBe("440");
      expect(userWidth()).toBe("440px");
      expect(separator()).toHaveAttribute("aria-valuemax", "440");
      expect(stored()).toBe("720");
      layout(1500);
      resized();
      expect(valueNow()).toBe("720");
      expect(userWidth()).toBe("720px");
      expect(separator()).toHaveAttribute("aria-valuemax", "750");
    });

    it("a layout width of 0 (no layout at all) falls back to the window", () => {
      localStorage.setItem(WIDTH_KEY, "700");
      render(ui());
      layout(0);
      resized();
      expect(valueNow()).toBe("600"); // viewport 1200
      expect(separator()).toHaveAttribute("aria-valuemax", "600");
    });

    it("watches the column's parent: when a sidebar toggle changes its width without a window resize, the limit follows", () => {
      const watched: Array<{ callback: () => void; targets: Element[] }> = [];
      vi.stubGlobal("ResizeObserver", class {
        entry = { callback: () => {}, targets: [] as Element[] };
        constructor(callback: () => void) { this.entry.callback = callback; watched.push(this.entry); }
        observe(el: Element) { this.entry.targets.push(el); }
        unobserve() {}
        disconnect() {}
      });
      try {
        localStorage.setItem(WIDTH_KEY, "700");
        render(ui());
        const watcher = watched.find((w) => w.targets.includes(column().parentElement!));
        expect(watcher, "an observer on the column's parent").toBeDefined();
        layout(960);
        act(() => watcher!.callback());
        expect(separator()).toHaveAttribute("aria-valuemax", "400");
        expect(valueNow()).toBe("400");
        expect(stored()).toBe("700");
      } finally {
        vi.stubGlobal("ResizeObserver", RealResizeObserver);
      }
    });

    it("stops listening to the window and to the parent when it unmounts", () => {
      const removed = vi.spyOn(window, "removeEventListener");
      const disconnect = vi.fn();
      vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect = disconnect; });
      try {
        render(ui()).unmount();
        expect(removed).toHaveBeenCalledWith("resize", expect.any(Function));
        expect(disconnect.mock.calls.length).toBeGreaterThanOrEqual(2); // the column's own observer and the parent's
      } finally {
        vi.stubGlobal("ResizeObserver", RealResizeObserver);
      }
    });
  });

  describe("the keyboard", () => {
    const press = async (keys: string) => { separator().focus(); await userEvent.keyboard(keys); };

    beforeEach(() => { localStorage.setItem(WIDTH_KEY, "300"); });

    it("ArrowRight widens by 16 and saves", async () => {
      render(ui());
      await press("{ArrowRight}");
      expect(valueNow()).toBe("316");
      expect(userWidth()).toBe("316px");
      expect(stored()).toBe("316");
    });

    it("ArrowLeft narrows by 16 and saves", async () => {
      render(ui());
      await press("{ArrowLeft}");
      expect(valueNow()).toBe("284");
      expect(stored()).toBe("284");
    });

    it("Shift moves by 48 either way", async () => {
      render(ui());
      await press("{Shift>}{ArrowRight}{/Shift}");
      expect(valueNow()).toBe("348");
      expect(stored()).toBe("348");
      await press("{Shift>}{ArrowLeft}{ArrowLeft}{/Shift}");
      expect(valueNow()).toBe("252");
      expect(stored()).toBe("252");
    });

    it("Home goes to the minimum and End to half the window, each saved", async () => {
      render(ui());
      await press("{Home}");
      expect(valueNow()).toBe("220");
      expect(stored()).toBe("220");
      await press("{End}");
      expect(valueNow()).toBe(String(max()));
      expect(stored()).toBe(String(max()));
    });

    it("End goes to what leaves the pane 560 px: with 960 right of the sidebar, 400 (review I-1)", async () => {
      render(ui());
      layout(960);
      resized();
      await press("{End}");
      expect(separator()).toHaveAttribute("aria-valuemax", "400");
      expect(valueNow()).toBe("400");
      expect(userWidth()).toBe("400px");
      expect(stored()).toBe("400");
      await press("{ArrowRight}");
      expect(valueNow()).toBe("400"); // at the maximum it stays
      await press("{Shift>}{ArrowRight}{/Shift}");
      expect(valueNow()).toBe("400");
      expect(stored()).toBe("400");
    });

    it("End reads the layout when it is pressed, also when no resize event came before", async () => {
      render(ui());
      layout(960);
      await press("{End}");
      expect(valueNow()).toBe("400");
      expect(stored()).toBe("400");
    });

    it("stops at both ends", async () => {
      render(ui());
      await press("{Home}{ArrowLeft}{Shift>}{ArrowLeft}{/Shift}");
      expect(valueNow()).toBe("220");
      await press("{End}{ArrowRight}{Shift>}{ArrowRight}{/Shift}");
      expect(valueNow()).toBe(String(max()));
    });

    it("steps from the width the column has when nothing is stored", async () => {
      localStorage.clear();
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect(0, 248));
      render(ui());
      await press("{ArrowRight}");
      expect(valueNow()).toBe("264");
      expect(stored()).toBe("264");
    });

    it("leaves other keys alone: no change, nothing saved, and Alt+ArrowLeft stays the browser's Back", async () => {
      localStorage.clear();
      render(ui());
      await press("{ArrowUp}{ArrowDown}a{Tab}");
      separator().focus();
      await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}{Control>}{ArrowRight}{/Control}");
      expect(userWidth()).toBe("");
      expect(stored()).toBeNull();
    });

    it("the keys it handles do not scroll the page (default prevented)", () => {
      render(ui());
      for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
        const notCancelled = fireEvent.keyDown(separator(), { key });
        expect(notCancelled, key).toBe(false);
      }
      expect(fireEvent.keyDown(separator(), { key: "ArrowUp" })).toBe(true);
    });
  });

  describe("dragging", () => {
    it("follows the pointer from the column's left edge, shows is-resizing meanwhile, and saves on release", () => {
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect(100, 280));
      render(ui());
      point("pointerdown", 380);
      expect(setCapture).toHaveBeenCalledWith(7);
      expect(column()).toHaveClass("is-resizing");
      point("pointermove", 400);
      expect(userWidth()).toBe("300px"); // 400 minus the left edge at 100
      expect(valueNow()).toBe("300");
      expect(stored()).toBeNull(); // saved on release, not on every move
      point("pointermove", 450);
      point("pointerup", 450);
      expect(releaseCapture).toHaveBeenCalledWith(7);
      expect(column()).not.toHaveClass("is-resizing");
      expect(stored()).toBe("350");
      point("pointermove", 520); // released: the column no longer follows
      expect(userWidth()).toBe("350px");
    });

    it("keeps the width between the minimum and half the window", () => {
      render(ui());
      point("pointerdown", 300);
      point("pointermove", 5000);
      expect(userWidth()).toBe(`${max()}px`);
      point("pointermove", 5);
      expect(userWidth()).toBe("220px");
      point("pointerup", 5);
      expect(stored()).toBe("220");
    });

    it("keeps the pane 560 px: with 960 right of the sidebar the column stops at 400, however far the pointer goes (review I-1)", () => {
      render(ui());
      layout(960);
      resized();
      point("pointerdown", 300);
      point("pointermove", 5000);
      expect(userWidth()).toBe("400px");
      point("pointerup", 5000);
      expect(stored()).toBe("400");
    });

    it("pointercancel releases and saves as pointerup does", () => {
      render(ui());
      point("pointerdown", 300);
      point("pointermove", 333);
      point("pointercancel", 333);
      expect(releaseCapture).toHaveBeenCalledWith(7);
      expect(column()).not.toHaveClass("is-resizing");
      expect(stored()).toBe("333");
    });

    it("a click without a move changes nothing and stores nothing (the default keeps applying)", () => {
      render(ui());
      point("pointerdown", 280);
      point("pointerup", 280);
      expect(userWidth()).toBe("");
      expect(stored()).toBeNull();
      expect(column()).not.toHaveClass("is-resizing");
    });

    it("a pointer moving over the handle without a press does nothing", () => {
      render(ui());
      point("pointermove", 400);
      expect(userWidth()).toBe("");
      expect(column()).not.toHaveClass("is-resizing");
    });

    it("ignores a press of a button other than the main one", () => {
      render(ui());
      const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 300, button: 2 });
      Object.defineProperty(event, "pointerId", { value: 7 });
      fireEvent(separator(), event);
      expect(column()).not.toHaveClass("is-resizing");
      expect(setCapture).not.toHaveBeenCalled();
    });

    it("still resizes when the pointer cannot be captured", () => {
      setCapture.mockImplementation(() => { throw new Error("InvalidPointerId"); });
      render(ui());
      point("pointerdown", 300);
      point("pointermove", 320);
      point("pointerup", 320);
      expect(stored()).toBe("320");
    });
  });

  it("a double click on the handle goes back to the default: nothing stored, no inline width", () => {
    localStorage.setItem(WIDTH_KEY, "340");
    render(ui());
    expect(userWidth()).toBe("340px");
    fireEvent.doubleClick(separator());
    expect(stored()).toBeNull();
    expect(userWidth()).toBe("");
    expect(column().getAttribute("style") ?? "").not.toContain("--tree-user-w");
  });
});

describe("AssetTree kind icons", () => {
  const kinded: Asset[] = [
    { id: 1, parent_id: null, name: "Main", kind: "Panel", sort_order: 1 },
    { id: 2, parent_id: 1, name: "Rack 1", kind: "Rack", sort_order: 2 },
    { id: 3, parent_id: 1, name: "Rack 2", kind: "rack", sort_order: 3 },
    { id: 4, parent_id: null, name: "Odd", kind: "", sort_order: 4 },
  ];
  const showKinded = () => render(<MemoryRouter><AssetTree nodes={buildTree(kinded)} selectedId={null} /></MemoryRouter>);
  const rowOf = (name: string) => screen.getByRole("link", { name }).closest(".node") as HTMLElement;
  const iconOf = (name: string) => rowOf(name).querySelector(".node-icon svg") as SVGElement;

  it("gives every row exactly one .node-icon holding one aria-hidden svg, between the twisty and the name", () => {
    showKinded();
    for (const name of ["Main", "Rack 1", "Rack 2", "Odd"]) {
      const row = rowOf(name);
      const holders = row.querySelectorAll(".node-icon");
      expect(holders).toHaveLength(1);
      expect(holders[0].querySelectorAll("svg")).toHaveLength(1);
      expect(holders[0].querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(holders[0].previousElementSibling?.className).toMatch(/twisty/);
      expect(holders[0].nextElementSibling).toBe(screen.getByRole("link", { name }));
    }
  });

  it("draws the icon of the node's kind: a Panel and a Rack differ, both spellings of Rack agree, a blank kind is the generic one", () => {
    showKinded();
    expect(iconOf("Main").innerHTML).toBe(iconHtml("kindPanel"));
    expect(iconOf("Rack 1").innerHTML).toBe(iconHtml("kindRack"));
    expect(iconOf("Rack 2").innerHTML).toBe(iconHtml("kindRack"));
    expect(iconOf("Main").innerHTML).not.toBe(iconOf("Rack 1").innerHTML);
    expect(iconOf("Odd").innerHTML).toBe(iconHtml("kindGeneric"));
  });

  it("draws the icon an asset was given over its kind, keeps the kind icon for no icon or an unknown one, and never throws", () => {
    const chosen: Asset[] = [
      { id: 1, parent_id: null, name: "Chosen", kind: "Panel", sort_order: 1, icon: "server" },
      { id: 2, parent_id: null, name: "Plain", kind: "Panel", sort_order: 2 },
      { id: 3, parent_id: null, name: "Cleared", kind: "Panel", sort_order: 3, icon: null },
      { id: 4, parent_id: null, name: "Unknown", kind: "Rack", sort_order: 4, icon: "zzz" },
      { id: 5, parent_id: null, name: "Proto", kind: "Rack", sort_order: 5, icon: "__proto__" },
      { id: 6, parent_id: null, name: "Ctor", kind: "Rack", sort_order: 6, icon: "constructor" },
      { id: 7, parent_id: null, name: "Empty", kind: "Rack", sort_order: 7, icon: "" },
    ];
    render(<MemoryRouter><AssetTree nodes={buildTree(chosen)} selectedId={null} /></MemoryRouter>);
    expect(iconOf("Chosen").innerHTML).toBe(iconHtml("kindServer"));
    expect(iconOf("Chosen").innerHTML).not.toBe(iconHtml("kindPanel"));
    expect(iconOf("Plain").innerHTML).toBe(iconHtml("kindPanel"));
    expect(iconOf("Cleared").innerHTML).toBe(iconHtml("kindPanel"));
    for (const name of ["Unknown", "Proto", "Ctor", "Empty"]) expect(iconOf(name).innerHTML).toBe(iconHtml("kindRack"));
  });

  it("draws the icon of the node's kind in the registry (kind_icon) over the keyword guess, the node's own icon over both, and generic for a registry icon this build lacks", () => {
    const registered: Asset[] = [
      { id: 1, parent_id: null, name: "Pump A", kind: "Pump", sort_order: 1, kind_icon: "server" },
      { id: 2, parent_id: null, name: "Pump B", kind: "Pump", sort_order: 2, icon: "fan", kind_icon: "server" },
      { id: 3, parent_id: null, name: "Pump C", kind: "Pump", sort_order: 3, kind_icon: null },
      { id: 4, parent_id: null, name: "Pump D", kind: "Pump", sort_order: 4 },
      { id: 5, parent_id: null, name: "Pump E", kind: "Pump", sort_order: 5, kind_icon: "zzz" },
      { id: 6, parent_id: null, name: "Pump F", kind: "Pump", sort_order: 6, kind_icon: "" },
      { id: 7, parent_id: null, name: "Pump G", kind: "Pump", sort_order: 7, kind_icon: "constructor" },
      { id: 8, parent_id: null, name: "Pump H", kind: "Pump", sort_order: 8, icon: "zzz", kind_icon: "rack" },
    ];
    render(<MemoryRouter><AssetTree nodes={buildTree(registered)} selectedId={null} /></MemoryRouter>);
    expect(iconOf("Pump A").innerHTML).toBe(iconHtml("kindServer"));
    expect(iconOf("Pump B").innerHTML).toBe(iconHtml("kindFan"));
    for (const name of ["Pump C", "Pump D"]) expect(iconOf(name).innerHTML).toBe(iconHtml("kindPump"));
    for (const name of ["Pump E", "Pump F", "Pump G"]) expect(iconOf(name).innerHTML).toBe(iconHtml("kindGeneric"));
    expect(iconOf("Pump H").innerHTML).toBe(iconHtml("kindRack"));
  });

  it("leaves the link text and the accessible name as the asset's name (the icon is decoration beside the link, not inside it)", () => {
    showKinded();
    const link = screen.getByRole("link", { name: "Main" });
    expect(link).toHaveTextContent(/^Main$/);
    expect(link.querySelector("svg")).toBeNull();
    expect(screen.getByRole("button", { name: "Children of Main" })).toBeInTheDocument();
  });
});

describe("AssetTree while the list loads", () => {
  const WIDTH_KEY = "dcdash.assetTreeWidth";
  const column = () => screen.getByRole("region", { name: "Asset tree" });
  const loadingUi = (props: Props = {}) => ui({ nodes: [], loading: true, onAddTop: vi.fn(), ...props });

  it("keeps the column and its header and shows one status region, with the filter slot and the rows as placeholders inside it", () => {
    render(loadingUi());
    expect(column()).toBeInTheDocument();
    expect(screen.getByText("Assets Tree", { selector: ".tree-title" })).toBeInTheDocument();
    const region = screen.getByText("Loading the asset tree").parentElement!;
    expect(region).toHaveAttribute("role", "status");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(column().contains(region)).toBe(true);
    expect(region.parentElement).toHaveClass("tree-body");
    expect(region.querySelector(".tree-filter .sk-block")).not.toBeNull(); // the filter's slot, inside the region so it fades in with the rows
    expect(region.querySelector(".tree-scroll .sk-tree .node")).not.toBeNull();
    expect(region.querySelector("input, a, button")).toBeNull();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("disables the header buttons that need a tree or a list (Add, Collapse all, Expand all) and leaves the toggle and the handle", () => {
    render(loadingUi({ disabled: true }));
    expect(screen.getByRole("button", { name: "Add a top-level asset" })).toBeDisabled();
    expect(collapseAll()).toBeDisabled();
    expect(expandAll()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Minimize asset tree" })).toBeEnabled();
    expect(screen.getByRole("separator", { name: "Resize the tree column" })).toBeInTheDocument();
  });

  it("is the very column the tree then fills: the stored width is on it while loading, and the section is the same element after", () => {
    localStorage.setItem(WIDTH_KEY, "340");
    const { rerender } = render(loadingUi());
    const before = column();
    expect(before.style.getPropertyValue("--tree-user-w")).toBe("340px");
    rerender(ui());
    expect(column()).toBe(before);
    expect(column().style.getPropertyValue("--tree-user-w")).toBe("340px");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(link("Site")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Filter assets" })).toBeInTheDocument();
  });

  it("keeps the minimized state: a minimized column hides its body, the skeleton included", () => {
    localStorage.setItem("dcdash.assetTree", "minimized");
    render(loadingUi());
    expect(column()).toHaveAttribute("data-state", "minimized");
    expect(screen.queryByRole("status")).not.toBeInTheDocument(); // hidden from the accessibility tree with the rest of the body
    expect(screen.getByRole("button", { name: "Expand asset tree" })).toBeInTheDocument();
  });

  it("shows no status and the real filter when it is not loading", () => {
    render(ui());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Filter assets" })).toBeInTheDocument();
  });
});

describe("AssetTree skip link", () => {
  const skip = () => screen.getByRole("link", { name: "Skip the tree" });

  it("is the first tab stop in the column, before the header buttons and the rows", async () => {
    render(ui());
    await userEvent.tab();
    expect(skip()).toHaveFocus();
    expect(skip().closest(".tree-col")).toBe(screen.getByRole("region", { name: "Asset tree" }));
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Collapse all" })).toHaveFocus();
  });

  it("moves focus to the asset pane (#asset-detail) on Enter without changing the address", async () => {
    render(<MemoryRouter><AssetTree nodes={nodes()} selectedId={null} /><div id="asset-detail" tabIndex={-1} /></MemoryRouter>);
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(document.getElementById("asset-detail")).toHaveFocus();
    expect(window.location.hash).toBe("");
  });

  it("is not offered while the column is minimized (there is no tree to skip)", () => {
    localStorage.setItem("dcdash.assetTree", "minimized");
    render(ui());
    expect(screen.queryByRole("link", { name: "Skip the tree" })).not.toBeInTheDocument();
  });
});

describe("AssetTree names", () => {
  it("sets each name's direction from its own text (dir=auto), so a right-to-left name is cut at its logical end", () => {
    const arabic = "\u0645\u0631\u0643\u0632 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a";
    render(<MemoryRouter><AssetTree nodes={buildTree([a(1, null, "Site"), a(2, 1, arabic)])} selectedId={null} /></MemoryRouter>);
    for (const name of ["Site", arabic]) expect(link(name)).toHaveAttribute("dir", "auto");
  });
});

describe("AssetTree Asset kinds link", () => {
  const kinds = () => screen.getByRole("link", { name: "Asset kinds" });
  const head = () => screen.getByText("Assets Tree", { selector: ".tree-title" }).closest(".tree-head") as HTMLElement;

  it("is a link in the header to /assets/kinds, named and titled Asset kinds, with a decorative icon", () => {
    render(ui());
    expect(kinds()).toHaveAttribute("href", "/assets/kinds");
    expect(kinds()).toHaveAttribute("title", "Asset kinds");
    expect(kinds()).toHaveClass("icon-btn");
    expect(kinds().closest(".tree-head")).toBe(head());
    expect(kinds().querySelector("svg.i")).toHaveAttribute("aria-hidden", "true");
  });

  it("sits after Expand all and before the column toggle, so the tree's own controls keep their tab order", async () => {
    render(ui({ onAddTop: vi.fn() }));
    const order = Array.from(head().querySelectorAll("button, a")).map((el) => el.getAttribute("aria-label"));
    expect(order).toEqual(["Add a top-level asset", "Collapse all", "Expand all", "Asset kinds", "Minimize asset tree"]);
    for (let i = 0; i < 4; i++) await userEvent.tab(); // the skip link, Add, Collapse all, Expand all
    expect(expandAll()).toHaveFocus();
    await userEvent.tab();
    expect(kinds()).toHaveFocus();
  });

  it("is there while the list loads, and is not a node of the tree", () => {
    render(ui({ nodes: [], loading: true }));
    expect(kinds()).toBeInTheDocument();
    expect(kinds().closest("ul.tree")).toBeNull();
  });

  it("goes away with the other header controls when the column is minimized", () => {
    localStorage.setItem("dcdash.assetTree", "minimized");
    render(ui());
    expect(screen.queryByRole("link", { name: "Asset kinds" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand asset tree" })).toBeInTheDocument();
  });

  it("marks itself as the current page on /assets/kinds, and not on an asset's page", () => {
    const at = (route: string) => <MemoryRouter initialEntries={[route]}><AssetTree nodes={nodes()} selectedId={null} /></MemoryRouter>;
    const { unmount } = render(at("/assets/kinds"));
    expect(kinds()).toHaveAttribute("aria-current", "page");
    unmount();
    render(at("/assets/1"));
    expect(kinds()).not.toHaveAttribute("aria-current");
  });

  it("stays when the filter matches no asset (it is not a row of the tree)", async () => {
    render(ui());
    await userEvent.type(screen.getByLabelText("Filter assets"), "kinds");
    expect(screen.getByText("No assets match the filter.")).toBeInTheDocument();
    expect(kinds()).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// W7p: picking rows and dragging them. The tree reports raw ids and a place; the page does the moving.
// Rows: Site 1, Room A 2, Panel 1 3, Room B 4, Yard 5, Shed 6 (see `flat`).

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
const where = () => screen.getByTestId("where").textContent;
const moveApi = (over: Partial<AssetTreeMove> = {}): AssetTreeMove => ({ onDrop: vi.fn(), onMoveTo: vi.fn(), moved: null, ...over });
/** A move signal for these roots; the first of them is the one the tree reveals and focuses. */
const signal = (...ids: number[]) => ({ firstId: ids[0], ids });
const withMove = (props: Props = {}) => (
  <MemoryRouter>
    <AssetTree nodes={nodes()} selectedId={null} move={moveApi()} {...props} />
    <Where />
  </MemoryRouter>
);
const hLink = (name: string) => screen.getByRole("link", { name, hidden: true });
const rowEl = (name: string) => hLink(name).closest(".node") as HTMLElement;
const pickedNames = () => [...document.querySelectorAll(".node[data-picked] a")].map((a) => a.textContent);
const slot = () => screen.getByRole("group", { name: "Selection" });
const liveText = () => document.querySelector("[aria-live]")!.textContent;

/** A click on `el`. The result is whether the tree itself prevented the default (picking does, and so must not open the asset). */
function clickPrevented(el: Element, init: MouseEventInit = {}) {
  let prevented = false;
  const spy = (e: Event) => { prevented = e.defaultPrevented; e.preventDefault(); }; // also keeps jsdom from "navigating" on a click nobody handled
  document.addEventListener("click", spy);
  fireEvent.click(el, init);
  document.removeEventListener("click", spy);
  return prevented;
}
const ctrlClick = (name: string) => clickPrevented(hLink(name), { ctrlKey: true });
const shiftClick = (name: string) => clickPrevented(hLink(name), { shiftKey: true });

describe("AssetTree without move (a role that may not change assets)", () => {
  it("draws no slot, no draggable row, no filler and no live line, and a Ctrl-click is left to the browser", () => {
    render(ui());
    expect(screen.queryByRole("group", { name: "Selection" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-asset-id]")).toBeNull();
    expect(document.querySelector("[draggable]")).toBeNull();
    expect(document.querySelector(".tree-root-drop")).toBeNull();
    expect(document.querySelector("[aria-live]")).toBeNull();
    expect(document.querySelector(".tree-scroll-move")).toBeNull();
    expect(clickPrevented(hLink("Room A"), { ctrlKey: true })).toBe(false);
    expect(document.querySelector(".node[data-picked]")).toBeNull();
  });

  it("ignores Space, M and the arrow keys on a row", () => {
    render(ui());
    hLink("Room A").focus();
    for (const key of [" ", "m", "ArrowDown"]) expect(fireEvent.keyDown(hLink("Room A"), { key })).toBe(true); // true: not prevented
    expect(document.querySelector(".node[data-picked]")).toBeNull();
    expect(hLink("Room A")).toHaveFocus();
  });
});

describe("AssetTree picked slot", () => {
  it("is a group named Selection between the filter and the rows, with a hint when nothing is picked", () => {
    render(withMove());
    expect(slot()).toHaveTextContent("Ctrl-click to pick several");
    const body = slot().parentElement!;
    const kids = [...body.children];
    expect(kids.indexOf(body.querySelector(".tree-filter")!)).toBeLessThan(kids.indexOf(slot()));
    expect(kids.indexOf(slot())).toBeLessThan(kids.indexOf(body.querySelector(".tree-scroll")!));
    expect(within(slot()).queryByRole("button")).not.toBeInTheDocument(); // no open asset, nothing picked: nothing to move
  });

  it("W7t: the hint is a long and a short span (the narrow bar with Delete shows the short one), the full hint is the text's title, and the count has neither", () => {
    render(withMove());
    const text = slot().querySelector(".tree-slot-text")!;
    expect(text.querySelector(".tree-slot-long")).toHaveTextContent(/^Ctrl-click to pick several$/);
    expect(text.querySelector(".tree-slot-short")).toHaveTextContent(/^Ctrl-click to pick$/);
    expect(text).toHaveAttribute("title", "Ctrl-click to pick several");
    ctrlClick("Room A");
    const count = slot().querySelector(".tree-slot-text")!;
    expect(count).toHaveTextContent(/^1 picked$/);
    expect(count.querySelector(".tree-slot-long, .tree-slot-short")).toBeNull();
    expect(count).not.toHaveAttribute("title");
    expect(within(slot()).getByRole("button", { name: "Clear" })).toHaveClass("tree-slot-btn", "tree-slot-clear");
  });

  it("offers to move the open asset when nothing is picked, and hands the page that asset and the button", async () => {
    const move = moveApi();
    render(withMove({ move, selectedId: 4 }));
    const button = within(slot()).getByRole("button", { name: "Move to..." });
    expect(button).toHaveAttribute("title", "Move Room B to another place");
    await userEvent.click(button);
    expect(move.onMoveTo).toHaveBeenCalledWith([4], button);
  });

  it("shows how many are picked with Move to... and Clear, and Move to... takes the picks (not the open asset)", async () => {
    const move = moveApi();
    render(withMove({ move, selectedId: 4 }));
    ctrlClick("Room A");
    ctrlClick("Shed");
    expect(slot()).toHaveTextContent("2 picked");
    expect(slot()).not.toHaveTextContent("Ctrl-click");
    const button = within(slot()).getByRole("button", { name: "Move to..." });
    await userEvent.click(button);
    expect(move.onMoveTo).toHaveBeenCalledTimes(1);
    const [ids, opener] = vi.mocked(move.onMoveTo).mock.calls[0];
    expect([...ids].sort()).toEqual([2, 6]);
    expect(opener).toBe(button);
  });

  it("Clear ends the picks and puts the focus on the row the person touched last", async () => {
    render(withMove());
    ctrlClick("Room A");
    ctrlClick("Room B");
    await userEvent.click(within(slot()).getByRole("button", { name: "Clear" }));
    expect(pickedNames()).toEqual([]);
    expect(slot()).toHaveTextContent("Ctrl-click to pick several");
    expect(hLink("Room B")).toHaveFocus();
  });

  it("while the page is busy Move to... keeps its focus and does nothing (aria-disabled, not disabled)", async () => {
    const move = moveApi();
    render(withMove({ move, selectedId: 4, disabled: true }));
    const button = within(slot()).getByRole("button", { name: "Move to..." });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(move.onMoveTo).not.toHaveBeenCalled();
  });

  it("is drawn empty and hidden from assistive technology in the loading skeleton, where the filter and the rows will be", () => {
    render(withMove({ nodes: [], loading: true }));
    const region = screen.getByRole("status");
    const placeholder = region.querySelector(".tree-slot")!;
    expect(placeholder).toBeEmptyDOMElement();
    expect(placeholder).toHaveAttribute("aria-hidden", "true");
    const kids = [...region.children];
    expect(kids.indexOf(region.querySelector(".tree-filter")!)).toBeLessThan(kids.indexOf(placeholder));
    expect(kids.indexOf(placeholder)).toBeLessThan(kids.indexOf(region.querySelector(".tree-scroll")!));
    expect(screen.queryByRole("group", { name: "Selection" })).not.toBeInTheDocument();
  });

  it("is not drawn for an empty tree, and stays above the rows when the filter matches nothing", async () => {
    const view = render(withMove({ nodes: [] }));
    expect(screen.queryByRole("group", { name: "Selection" })).not.toBeInTheDocument();
    view.rerender(withMove());
    await userEvent.type(screen.getByLabelText("Filter assets"), "zzz");
    expect(slot()).toBeInTheDocument();
  });
});

describe("AssetTree picking with the mouse", () => {
  it("Ctrl-click picks a row without opening it and a second Ctrl-click takes it off", () => {
    render(withMove());
    expect(ctrlClick("Room A")).toBe(true);
    expect(where()).toBe("/");
    expect(pickedNames()).toEqual(["Room A"]);
    expect(rowEl("Room A")).toHaveAttribute("data-picked", "true");
    expect(rowEl("Room A").className).not.toContain("is-selected");
    ctrlClick("Room A");
    expect(pickedNames()).toEqual([]);
  });

  it("Cmd-click (the Mac's key) does the same", () => {
    render(withMove());
    expect(clickPrevented(hLink("Room A"), { metaKey: true })).toBe(true);
    expect(pickedNames()).toEqual(["Room A"]);
    expect(where()).toBe("/");
  });

  it("a picked row says so to assistive technology without changing the link's name", () => {
    render(withMove());
    ctrlClick("Room A");
    const link = screen.getByRole("link", { name: "Room A" }); // a string name is matched in full: the name is still just the asset's
    expect(link).toHaveAccessibleDescription("picked");
    expect(screen.getByRole("link", { name: "Room B" })).not.toHaveAttribute("aria-describedby");
  });

  it("a plain click opens the asset and clears the picks", () => {
    render(withMove());
    ctrlClick("Room A");
    ctrlClick("Yard");
    expect(clickPrevented(hLink("Room B"))).toBe(true); // react-router navigated
    expect(where()).toBe("/assets/4");
    expect(pickedNames()).toEqual([]);
  });

  it("Shift-click picks the rows from the anchor to the clicked row, in tree order, and replaces the earlier picks", () => {
    render(withMove());
    ctrlClick("Shed");
    ctrlClick("Room A"); // the anchor is now Room A
    expect(shiftClick("Yard")).toBe(true);
    expect(pickedNames()).toEqual(["Room A", "Panel 1", "Room B", "Yard"]);
    expect(where()).toBe("/");
    shiftClick("Room B"); // the same anchor
    expect(pickedNames()).toEqual(["Room A", "Panel 1", "Room B"]);
  });

  it("the mousedown of a Shift-click is prevented (it would extend a text selection across the rows)", () => {
    render(withMove());
    expect(fireEvent.mouseDown(hLink("Room A"), { shiftKey: true })).toBe(false);
    expect(fireEvent.mouseDown(hLink("Room A"))).toBe(true);
  });

  it("a range leaves out the rows of a folded branch", async () => {
    render(withMove());
    await userEvent.click(twisty("Room A")); // Panel 1 is hidden
    ctrlClick("Site");
    shiftClick("Yard");
    expect(pickedNames()).toEqual(["Site", "Room A", "Room B", "Yard"]);
  });

  it("a range leaves out the rows a filter hides", async () => {
    render(withMove());
    await userEvent.type(screen.getByLabelText("Filter assets"), "room");
    ctrlClick("Site");
    shiftClick("Room B");
    expect(pickedNames()).toEqual(["Site", "Room A", "Room B"]); // Panel 1, Yard and Shed do not match
  });

  it("after a plain click on a row the next Shift-click ranges from that row", () => {
    render(withMove());
    clickPrevented(hLink("Room A"));
    shiftClick("Yard");
    expect(pickedNames()).toEqual(["Room A", "Panel 1", "Room B", "Yard"]);
  });

  it("a pick that disappears from the list is forgotten", () => {
    const move = moveApi();
    const view = render(withMove({ move }));
    ctrlClick("Room A");
    ctrlClick("Shed");
    expect(slot()).toHaveTextContent("2 picked");
    view.rerender(withMove({ move, nodes: buildTree(flat.filter((x) => x.id !== 6)) }));
    expect(slot()).toHaveTextContent("1 picked");
    expect(pickedNames()).toEqual(["Room A"]);
  });
});

describe("AssetTree picking with the keyboard", () => {
  it("Space picks the focused row and Space again takes it off", async () => {
    render(withMove());
    hLink("Room A").focus();
    await userEvent.keyboard(" ");
    expect(pickedNames()).toEqual(["Room A"]);
    await userEvent.keyboard(" ");
    expect(pickedNames()).toEqual([]);
    expect(where()).toBe("/");
  });

  it("ArrowDown and ArrowUp move the focus between the rows that are on screen", async () => {
    render(withMove());
    hLink("Room B").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(hLink("Yard")).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(hLink("Panel 1")).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(hLink("Site")).toHaveFocus(); // the first row stays the first
    await userEvent.click(twisty("Site")); // fold the whole branch
    hLink("Site").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(hLink("Yard")).toHaveFocus(); // the folded children are skipped
  });

  it("Shift+ArrowDown extends a range from the row the key was pressed on", async () => {
    render(withMove());
    hLink("Site").focus();
    await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect(pickedNames()).toEqual(["Site", "Room A", "Panel 1"]);
    expect(hLink("Panel 1")).toHaveFocus();
    await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
    expect(pickedNames()).toEqual(["Site", "Room A"]);
  });

  it("M opens Move to... for the picked rows, handing over the focused link; with nothing picked it moves the row it was pressed on", async () => {
    const move = moveApi();
    render(withMove({ move }));
    hLink("Panel 1").focus();
    await userEvent.keyboard("m");
    expect(move.onMoveTo).toHaveBeenLastCalledWith([3], hLink("Panel 1"));
    ctrlClick("Room A");
    ctrlClick("Yard");
    hLink("Room B").focus();
    await userEvent.keyboard("M");
    const [ids, opener] = vi.mocked(move.onMoveTo).mock.calls.at(-1)!;
    expect([...ids].sort()).toEqual([2, 5]);
    expect(opener).toBe(hLink("Room B"));
  });

  it("Shift+F10 and the context-menu key do the same, and Ctrl+M is the browser's", () => {
    const move = moveApi();
    render(withMove({ move }));
    hLink("Room A").focus();
    expect(fireEvent.keyDown(hLink("Room A"), { key: "F10", shiftKey: true })).toBe(false);
    expect(fireEvent.keyDown(hLink("Room A"), { key: "ContextMenu" })).toBe(false);
    expect(move.onMoveTo).toHaveBeenCalledTimes(2);
    expect(fireEvent.keyDown(hLink("Room A"), { key: "m", ctrlKey: true })).toBe(true);
    expect(move.onMoveTo).toHaveBeenCalledTimes(2);
  });

  it("M does nothing while the page is busy", async () => {
    const move = moveApi();
    render(withMove({ move, disabled: true }));
    hLink("Room A").focus();
    await userEvent.keyboard("m");
    expect(move.onMoveTo).not.toHaveBeenCalled();
  });

  it("Escape clears the picks, and does nothing (not even a preventDefault) when nothing is picked", () => {
    render(withMove());
    hLink("Room A").focus();
    expect(fireEvent.keyDown(hLink("Room A"), { key: "Escape" })).toBe(true);
    ctrlClick("Room A");
    expect(fireEvent.keyDown(hLink("Room A"), { key: "Escape" })).toBe(false);
    expect(pickedNames()).toEqual([]);
  });

  describe("Ctrl+Z (Cmd+Z)", () => {
    const press = (init: KeyboardEventInit, name = "Room A") => fireEvent.keyDown(hLink(name), init);

    it("asks the page to undo its latest move, and keeps the browser's default away only when it did", () => {
      const onUndo = vi.fn(() => true);
      render(withMove({ move: moveApi({ onUndo }) }));
      hLink("Room A").focus();
      expect(press({ key: "z", ctrlKey: true })).toBe(false); // false: preventDefault was called
      expect(onUndo).toHaveBeenCalledTimes(1);
      expect(press({ key: "Z", metaKey: true })).toBe(false); // Cmd+Z, and a capital from Caps Lock
      expect(onUndo).toHaveBeenCalledTimes(2);
      onUndo.mockReturnValue(false); // nothing to undo (the toast is gone, or another move is running)
      expect(press({ key: "z", ctrlKey: true })).toBe(true);
      expect(onUndo).toHaveBeenCalledTimes(3);
    });

    it("works on a layout where the key is not a Latin z (the physical key is KeyZ)", () => {
      const onUndo = vi.fn(() => true);
      render(withMove({ move: moveApi({ onUndo }) }));
      expect(press({ key: "\u0632", code: "KeyZ", ctrlKey: true })).toBe(false);
      expect(onUndo).toHaveBeenCalledTimes(1);
      expect(press({ key: "y", code: "KeyZ", ctrlKey: true })).toBe(true); // a Latin layout where that key is another letter
      expect(onUndo).toHaveBeenCalledTimes(1);
    });

    it("is not Redo, not Alt+Z and not a bare z", () => {
      const onUndo = vi.fn(() => true);
      render(withMove({ move: moveApi({ onUndo }) }));
      expect(press({ key: "Z", ctrlKey: true, shiftKey: true })).toBe(true);
      expect(press({ key: "z", ctrlKey: true, altKey: true })).toBe(true);
      expect(press({ key: "z" })).toBe(true);
      expect(onUndo).not.toHaveBeenCalled();
    });

    it("does nothing while the page is busy (the tree is disabled)", () => {
      const onUndo = vi.fn(() => true);
      render(withMove({ move: moveApi({ onUndo }), disabled: true }));
      expect(press({ key: "z", ctrlKey: true })).toBe(true);
      expect(onUndo).not.toHaveBeenCalled();
    });

    it("is ignored without a way to undo, and without move at all (the browser keeps the key)", () => {
      const view = render(withMove({ move: moveApi() })); // an older page: no onUndo
      expect(press({ key: "z", ctrlKey: true })).toBe(true);
      view.unmount();
      render(ui());
      expect(fireEvent.keyDown(hLink("Room A"), { key: "z", ctrlKey: true })).toBe(true);
    });

    it("is not the tree's when pressed on a twisty, a + or in the filter", async () => {
      const onUndo = vi.fn(() => true);
      render(withMove({ move: moveApi({ onUndo }), onAddChild: vi.fn() }));
      expect(fireEvent.keyDown(twisty("Site"), { key: "z", ctrlKey: true })).toBe(true);
      expect(fireEvent.keyDown(screen.getByRole("button", { name: "Add child of Site" }), { key: "z", ctrlKey: true })).toBe(true);
      expect(fireEvent.keyDown(screen.getByLabelText("Filter assets"), { key: "z", ctrlKey: true })).toBe(true);
      expect(onUndo).not.toHaveBeenCalled();
    });
  });

  it("keys pressed in the filter, on a twisty or on a + are not the tree's", async () => {
    const move = moveApi();
    render(withMove({ move, onAddChild: vi.fn() }));
    await userEvent.type(screen.getByLabelText("Filter assets"), "m");
    await userEvent.clear(screen.getByLabelText("Filter assets"));
    expect(move.onMoveTo).not.toHaveBeenCalled();
    twisty("Site").focus();
    await userEvent.keyboard("m");
    screen.getByRole("button", { name: "Add child of Site" }).focus();
    await userEvent.keyboard("m");
    expect(move.onMoveTo).not.toHaveBeenCalled();
    expect(document.querySelector(".node[data-picked]")).toBeNull();
  });
});

describe("AssetTree live line", () => {
  it("is one role-less polite region; the first pick says Press M to move, later ones do not", () => {
    render(withMove());
    const line = document.querySelector("[aria-live]")!;
    expect(line).toHaveAttribute("aria-live", "polite");
    expect(line).not.toHaveAttribute("role");
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(liveText()).toBe("");
    ctrlClick("Room A");
    expect(liveText()).toBe("Room A picked. Press M to move");
    ctrlClick("Room B");
    expect(liveText()).toBe("Room B picked, 2 picked in all");
    ctrlClick("Room B");
    expect(liveText()).toBe("Room B unpicked, 1 picked");
    shiftClick("Yard"); // from Room B, the row last touched, to Yard
    expect(liveText()).toBe("2 picked");
    fireEvent.keyDown(hLink("Yard"), { key: "Escape" });
    expect(liveText()).toBe("Picks cleared");
  });
});

describe("AssetTree renders", () => {
  afterEach(() => { rowRenderProbe.current = null; });

  it("picking a grandchild renders that row and no other; picking a parent renders that row, not its children", () => {
    const seen: number[] = [];
    render(withMove());
    rowRenderProbe.current = (id) => seen.push(id);
    ctrlClick("Panel 1");
    expect(seen).toEqual([3]);
    seen.length = 0;
    ctrlClick("Room A");
    expect(seen).toEqual([2]);
    seen.length = 0;
    shiftClick("Yard"); // a range replaces the set once: only the rows whose flag flips render
    expect(seen.sort()).toEqual([4, 5].sort()); // Room A and Panel 1 stay picked; Room B and Yard join
  });

  it("folding a branch renders the rows again (the view changed), the picks do not", async () => {
    render(withMove());
    ctrlClick("Yard");
    const seen: number[] = [];
    rowRenderProbe.current = (id) => seen.push(id);
    await userEvent.click(twisty("Room A"));
    expect(seen).toContain(2);
  });
});

describe("AssetTree after a move", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("unpicks the moved rows, unfolds the way to the first moved asset and focuses its link once the new tree has arrived", () => {
    localStorage.setItem(KEY, "[1,2]");
    const before = nodes();
    const view = render(withMove({ nodes: before }));
    ctrlClick("Yard");
    expect(pickedNames()).toEqual(["Yard"]);
    const moved = signal(3, 5); // Panel 1 (inside the folded Site) and Yard were the moved roots
    view.rerender(withMove({ nodes: before, move: moveApi({ moved }) }));
    expect(pickedNames()).toEqual([]); // the moved rows are no longer picked, at once
    expect(link("Panel 1")).not.toBeInTheDocument(); // the tree has not changed yet: nothing is revealed (it would be the old place)
    view.rerender(withMove({ nodes: buildTree(flat), move: moveApi({ moved }) })); // the refetched tree
    expect(expanded("Site")).toBe("true");
    expect(expanded("Room A")).toBe("true");
    expect(link("Panel 1")).toHaveFocus();
  });

  it("takes a tree that was current already: after a short wait it still unfolds and focuses", () => {
    vi.useFakeTimers();
    localStorage.setItem(KEY, "[1,2]");
    const tree1 = nodes();
    const view = render(withMove({ nodes: tree1 }));
    view.rerender(withMove({ nodes: tree1, move: moveApi({ moved: signal(3) }) }));
    expect(link("Panel 1")).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(260); });
    expect(link("Panel 1")).toHaveFocus();
    expect(expanded("Site")).toBe("true");
  });

  it("shows a moved asset the filter hides, by clearing the filter", async () => {
    const tree1 = nodes();
    const view = render(withMove({ nodes: tree1 }));
    await userEvent.type(screen.getByLabelText("Filter assets"), "yard");
    expect(link("Room B")).not.toBeInTheDocument();
    const moved = signal(4);
    view.rerender(withMove({ nodes: tree1, move: moveApi({ moved }) }));
    view.rerender(withMove({ nodes: nodes(), move: moveApi({ moved }) }));
    expect(screen.getByLabelText("Filter assets")).toHaveValue("");
    expect(link("Room B")).toHaveFocus();
  });

  it("a moved object that was there when the tree mounted is not a move", () => {
    render(withMove({ move: moveApi({ moved: signal(3) }) }));
    expect(document.body).toHaveFocus();
  });

  it("leaves the picks that did not move: dragging one unpicked row must not end the picking of the rest", () => {
    const tree1 = nodes();
    const view = render(withMove({ nodes: tree1 }));
    ctrlClick("Room A");
    ctrlClick("Yard");
    view.rerender(withMove({ nodes: tree1, move: moveApi({ moved: signal(4) }) })); // Room B, which was never picked
    expect(pickedNames()).toEqual(["Room A", "Yard"]);
  });

  it("unpicks every moved root, and the picked rows inside a moved root, which travelled with it", () => {
    const tree1 = nodes();
    const view = render(withMove({ nodes: tree1 }));
    ctrlClick("Site");
    ctrlClick("Panel 1"); // inside Site: the page sends only the root, Site
    ctrlClick("Yard");
    ctrlClick("Shed");
    expect(pickedNames()).toEqual(["Site", "Panel 1", "Yard", "Shed"]);
    view.rerender(withMove({ nodes: tree1, move: moveApi({ moved: signal(1, 5) }) }));
    expect(pickedNames()).toEqual([]); // Site and its Panel 1, Yard and its Shed
  });

  it("unpicks the restored roots of an Undo the same way, and keeps the others", () => {
    const tree1 = nodes();
    const view = render(withMove({ nodes: tree1 }));
    ctrlClick("Room B");
    ctrlClick("Yard");
    view.rerender(withMove({ nodes: tree1, move: moveApi({ moved: signal(2) }) }));
    expect(pickedNames()).toEqual(["Room B", "Yard"]);
    view.rerender(withMove({ nodes: tree1, move: moveApi({ moved: signal(4) }) }));
    expect(pickedNames()).toEqual(["Yard"]);
  });

  it("says the page's own words on the live line, and a later signal without words (an Undo) clears them", () => {
    const tree1 = nodes();
    const view = render(withMove({ nodes: tree1 }));
    const line = "Moved Room B to Yard. Press Ctrl+Z to undo.";
    view.rerender(withMove({ nodes: tree1, move: moveApi({ moved: { ...signal(4), line } }) }));
    expect(liveText()).toBe(line);
    view.rerender(withMove({ nodes: tree1, move: moveApi({ moved: signal(4) }) }));
    expect(liveText()).toBe("");
  });
});

describe("AssetTree dragging", () => {
  const dtOf = () => {
    const data: Record<string, string> = {};
    return { data, dropEffect: "none", effectAllowed: "uninitialized", types: [] as string[], setData: vi.fn((kind: string, value: string) => { data[kind] = value; }), setDragImage: vi.fn() };
  };
  type Dt = ReturnType<typeof dtOf>;
  function drag(type: string, el: Element, init: { y?: number; dt?: Dt; related?: Element | null } = {}) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: init.y ?? 0, relatedTarget: init.related ?? null });
    Object.defineProperty(event, "dataTransfer", { value: init.dt ?? null });
    fireEvent(el, event);
    return event;
  }
  /** Every .node gets a rectangle, 32px rows stacked from the top in document order (jsdom has no layout). */
  function layout() {
    document.querySelectorAll<HTMLElement>(".node").forEach((el, i) => {
      el.getBoundingClientRect = () => ({ top: i * 32, bottom: i * 32 + 32, height: 32, left: 0, right: 200, width: 200, x: 0, y: i * 32, toJSON() { return {}; } }) as DOMRect;
    });
  }
  const OFFSET = { before: 4, inside: 16, after: 28 };
  const at = (name: string, zone: keyof typeof OFFSET) => [...document.querySelectorAll(".node")].indexOf(rowEl(name)) * 32 + OFFSET[zone];
  const filler = () => document.querySelector(".tree-root-drop")!;

  /** Starts dragging `name` and returns the transfer; `layout()` has run. */
  function start(name: string) {
    layout();
    const dt = dtOf();
    drag("dragstart", rowEl(name), { dt });
    return dt;
  }

  it("makes the row draggable and its link and buttons not", () => {
    render(withMove({ onAddChild: vi.fn() }));
    expect(rowEl("Room A")).toHaveAttribute("draggable", "true");
    expect(hLink("Room A")).toHaveAttribute("draggable", "false");
    expect(twisty("Site")).toHaveAttribute("draggable", "false");
    expect(screen.getByRole("button", { name: "Add child of Site" })).toHaveAttribute("draggable", "false");
  });

  it("a page that is busy makes no row draggable and starts no drag", () => {
    render(withMove({ disabled: true }));
    expect(document.querySelector("[draggable]")).toBeNull();
    const dt = start("Shed");
    expect(dt.setData).not.toHaveBeenCalled();
    expect(drag("dragover", rowEl("Room B"), { y: at("Room B", "inside"), dt }).defaultPrevented).toBe(false);
  });

  it("starts with the names as text, the move effect and a badge that is gone again right after", async () => {
    render(withMove());
    const before = document.querySelectorAll(".node").length;
    const dt = start("Shed");
    expect(dt.data["text/plain"]).toBe("Shed");
    expect(dt.effectAllowed).toBe("move");
    expect(dt.setDragImage).toHaveBeenCalledTimes(1);
    const badge = dt.setDragImage.mock.calls[0][0] as HTMLElement;
    expect(badge.className).toBe("tree-drag-badge");
    expect(badge).toHaveTextContent("Shed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(badge.isConnected).toBe(false);
    expect(document.querySelectorAll(".node")).toHaveLength(before);
    expect(document.querySelector(".tree-drag-badge")).toBeNull();
  });

  it("drags every picked row when a picked row is dragged, and only the row itself when it is not picked", () => {
    const move = moveApi();
    render(withMove({ move }));
    ctrlClick("Room A");
    ctrlClick("Room B");
    const dt = start("Room B");
    expect(dt.data["text/plain"]).toBe("Room A\nRoom B");
    expect(dt.setDragImage.mock.calls[0][0]).toHaveTextContent("2 assets");
    drag("dragover", rowEl("Yard"), { y: at("Yard", "inside"), dt });
    drag("drop", rowEl("Yard"), { y: at("Yard", "inside"), dt });
    expect(move.onDrop).toHaveBeenLastCalledWith([2, 4], { parent_id: 5, before_id: null });
    expect(pickedNames()).toEqual(["Room A", "Room B"]); // the page clears them when the move is done

    const dt2 = start("Shed"); // not picked
    expect(dt2.data["text/plain"]).toBe("Shed");
    drag("dragover", rowEl("Room B"), { y: at("Room B", "inside"), dt: dt2 });
    drag("drop", rowEl("Room B"), { y: at("Room B", "inside"), dt: dt2 });
    expect(move.onDrop).toHaveBeenLastCalledWith([6], { parent_id: 4, before_id: null });
    expect(pickedNames()).toEqual(["Room A", "Room B"]);
  });

  it("the middle of a row is inside: the row is marked, the drop is accepted as a move and lands as its last child", () => {
    const move = moveApi();
    render(withMove({ move }));
    const dt = start("Shed");
    const over = drag("dragover", rowEl("Room B"), { y: at("Room B", "inside"), dt });
    expect(over.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe("move");
    expect(rowEl("Room B")).toHaveAttribute("data-drop", "inside");
    drag("drop", rowEl("Room B"), { y: at("Room B", "inside"), dt });
    expect(move.onDrop).toHaveBeenCalledTimes(1);
    expect(move.onDrop).toHaveBeenCalledWith([6], { parent_id: 4, before_id: null });
    expect(rowEl("Room B")).not.toHaveAttribute("data-drop");
  });

  it.each([
    ["the top quarter is before the row", "Room B", "before", "before", { parent_id: 1, before_id: 4 }],
    ["the bottom quarter of a closed row is after it", "Room B", "after", "after", { parent_id: 1, before_id: null }],
    ["the bottom quarter of an open row with children is its first child", "Site", "after", "first", { parent_id: 1, before_id: 2 }],
  ] as const)("%s", (_title, row, zone, mark, expected) => {
    const move = moveApi();
    render(withMove({ move }));
    const dt = start("Shed");
    const over = drag("dragover", rowEl(row), { y: at(row, zone), dt });
    expect(over.defaultPrevented).toBe(true);
    expect(rowEl(row)).toHaveAttribute("data-drop", mark);
    drag("drop", rowEl(row), { y: at(row, zone), dt });
    expect(move.onDrop).toHaveBeenCalledWith([6], expected);
  });

  it("the first child dropped on its own parent's bottom edge (the first-child place) would change nothing: invalid, and nothing is called", () => {
    const move = moveApi();
    render(withMove({ move }));
    const dt = start("Room A"); // Site's first child, dragged onto Site's own bottom edge: it would stay first
    expect(drag("dragover", rowEl("Site"), { y: at("Site", "after"), dt }).defaultPrevented).toBe(false);
    expect(rowEl("Site")).toHaveAttribute("data-drop", "invalid");
    expect(rowEl("Site").title).toBe('"Room A" is already there.');
    drag("drop", rowEl("Site"), { y: at("Site", "after"), dt });
    expect(move.onDrop).not.toHaveBeenCalled();
  });

  it("the sibling rule is on the whole tree: a filter that hides the next sibling does not change before_id", async () => {
    const move = moveApi();
    const pumps = buildTree([a(1, null, "Site"), a(2, 1, "Pump 1"), a(3, 1, "Fan"), a(4, 1, "Pump 2"), a(5, null, "Pump X")]);
    render(withMove({ move, nodes: pumps }));
    await userEvent.type(screen.getByLabelText("Filter assets"), "pump"); // shows Site, Pump 1, Pump 2, Pump X; the Fan between them is hidden
    expect(link("Fan")).not.toBeInTheDocument();
    const dt = start("Pump X");
    drag("dragover", rowEl("Pump 1"), { y: at("Pump 1", "after"), dt });
    drag("drop", rowEl("Pump 1"), { y: at("Pump 1", "after"), dt });
    expect(move.onDrop).toHaveBeenCalledWith([5], { parent_id: 1, before_id: 3 }); // before the Fan, not before Pump 2
  });

  it("the area below the last row is the top level, last", () => {
    const move = moveApi();
    render(withMove({ move }));
    const dt = start("Shed");
    const over = drag("dragover", filler(), { dt });
    expect(over.defaultPrevented).toBe(true);
    expect(filler()).toHaveAttribute("data-drop", "inside");
    drag("drop", filler(), { dt });
    expect(move.onDrop).toHaveBeenCalledWith([6], { parent_id: null, before_id: null });
    expect(filler()).not.toHaveAttribute("data-drop");
  });

  it("a top-level asset dropped on the area below the last row that is already last there is marked invalid", () => {
    const move = moveApi();
    render(withMove({ move }));
    const dt = start("Yard");
    expect(drag("dragover", filler(), { dt }).defaultPrevented).toBe(false);
    expect(filler()).toHaveAttribute("data-drop", "invalid");
    expect(filler().getAttribute("title")).toBe('"Yard" is already there.');
    drag("drop", filler(), { dt });
    expect(move.onDrop).not.toHaveBeenCalled();
  });

  it("a drop onto the asset's own descendant or itself is not accepted: the reason is the title and the live line, and nothing is moved", () => {
    const move = moveApi();
    render(withMove({ move }));
    const dt = start("Site");
    const over = drag("dragover", rowEl("Panel 1"), { y: at("Panel 1", "inside"), dt });
    expect(over.defaultPrevented).toBe(false);
    expect(dt.dropEffect).toBe("none");
    expect(rowEl("Panel 1")).toHaveAttribute("data-drop", "invalid");
    expect(rowEl("Panel 1").title).toBe('"Site" cannot be moved into "Panel 1", which is inside it.');
    expect(liveText()).toBe('"Site" cannot be moved into "Panel 1", which is inside it.');
    drag("dragover", rowEl("Site"), { y: at("Site", "inside"), dt });
    expect(rowEl("Site").title).toBe('"Site" cannot be moved into itself.');
    expect(rowEl("Panel 1")).not.toHaveAttribute("data-drop"); // the marker follows the pointer
    expect(rowEl("Panel 1")).not.toHaveAttribute("title");
    drag("drop", rowEl("Site"), { y: at("Site", "inside"), dt });
    expect(move.onDrop).not.toHaveBeenCalled();
    expect(rowEl("Site")).not.toHaveAttribute("data-drop");
  });

  it("writes the marker once per (row, zone): staying in the zone writes nothing, a new zone moves the marker", () => {
    render(withMove());
    const dt = start("Shed");
    const row = rowEl("Room B");
    const set = vi.spyOn(row, "setAttribute");
    drag("dragover", row, { y: at("Room B", "inside"), dt });
    drag("dragover", row, { y: at("Room B", "inside") + 3, dt });
    drag("dragover", row, { y: at("Room B", "inside") - 3, dt });
    expect(set.mock.calls.filter(([name]) => name === "data-drop")).toHaveLength(1);
    drag("dragover", row, { y: at("Room B", "before"), dt });
    expect(row).toHaveAttribute("data-drop", "before");
    expect(document.querySelectorAll("[data-drop]")).toHaveLength(1);
  });

  it("a dragover causes no render", () => {
    render(withMove());
    const dt = start("Shed");
    const seen: number[] = [];
    rowRenderProbe.current = (id) => seen.push(id);
    try {
      for (const name of ["Room A", "Panel 1", "Room B", "Yard", "Site"]) drag("dragover", rowEl(name), { y: at(name, "inside"), dt });
      drag("dragover", filler(), { dt });
    } finally {
      rowRenderProbe.current = null;
    }
    expect(seen).toEqual([]);
  });

  it("markers go when the pointer leaves the tree, not when it moves to another element inside it", () => {
    render(withMove());
    const dt = start("Shed");
    drag("dragover", rowEl("Room B"), { y: at("Room B", "inside"), dt });
    const list = document.querySelector("ul.tree")!;
    drag("dragleave", rowEl("Room B"), { related: rowEl("Yard") });
    expect(rowEl("Room B")).toHaveAttribute("data-drop", "inside");
    drag("dragleave", list, { related: filler() });
    expect(document.querySelector("[data-drop]")).toBeNull();
  });

  it("markers and the dragging state go at dragend (a drop outside the tree), and a new drag starts clean", () => {
    render(withMove());
    const dt = start("Shed");
    const scroll = document.querySelector(".tree-scroll")!;
    expect(scroll).toHaveAttribute("data-dragging");
    drag("dragover", rowEl("Room B"), { y: at("Room B", "inside"), dt });
    fireEvent(window, new Event("dragend"));
    expect(document.querySelector("[data-drop]")).toBeNull();
    expect(scroll).not.toHaveAttribute("data-dragging");
    expect(drag("dragover", rowEl("Room B"), { y: at("Room B", "inside"), dt }).defaultPrevented).toBe(false); // nothing is being dragged now
  });

  it("a drag that did not start in the tree (a file, text) is left alone", () => {
    render(withMove());
    layout();
    const over = drag("dragover", rowEl("Room B"), { y: at("Room B", "inside"), dt: dtOf() });
    expect(over.defaultPrevented).toBe(false);
    expect(document.querySelector("[data-drop]")).toBeNull();
    expect(drag("drop", rowEl("Room B"), { dt: dtOf() }).defaultPrevented).toBe(false);
  });

  it("a drop that the pointer makes on an element between rows is no place", () => {
    const move = moveApi();
    render(withMove({ move }));
    const dt = start("Shed");
    const over = drag("dragover", document.querySelector("ul.tree")!, { dt });
    expect(over.defaultPrevented).toBe(false);
    drag("drop", document.querySelector("ul.tree")!, { dt });
    expect(move.onDrop).not.toHaveBeenCalled();
  });

  it("hovering on the middle of a folded row opens it after 600 ms; moving on first cancels that", () => {
    localStorage.setItem(KEY, "[1]");
    vi.useFakeTimers();
    try {
      render(withMove());
      const dt = start("Shed");
      drag("dragover", rowEl("Site"), { y: at("Site", "inside"), dt });
      act(() => { vi.advanceTimersByTime(599); });
      expect(expanded("Site")).toBe("false");
      act(() => { vi.advanceTimersByTime(1); });
      expect(expanded("Site")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("moving off a folded row before the 600 ms are over keeps it closed", () => {
    localStorage.setItem(KEY, "[1]");
    vi.useFakeTimers();
    try {
      render(withMove());
      const dt = start("Shed");
      drag("dragover", rowEl("Site"), { y: at("Site", "inside"), dt });
      act(() => { vi.advanceTimersByTime(400); });
      drag("dragover", rowEl("Site"), { y: at("Site", "before"), dt }); // another zone of the same row also restarts
      act(() => { vi.advanceTimersByTime(400); });
      expect(expanded("Site")).toBe("false");
      drag("dragover", rowEl("Room B"), { y: at("Room B", "inside"), dt });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(expanded("Site")).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a folded row that is not a valid place (the dragged row itself) does not open under the pointer", () => {
    localStorage.setItem(KEY, "[1]");
    vi.useFakeTimers();
    try {
      render(withMove());
      const dt = start("Site"); // dragging the folded row itself over itself: invalid
      drag("dragover", rowEl("Site"), { y: at("Site", "inside"), dt });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(expanded("Site")).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });
});
