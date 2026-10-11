import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { Asset } from "../api/types";
import { buildTree } from "../lib/tree";
import { AssetTree } from "./AssetTree";

const KEY = "dcdash.assetTreeFolded";
const a = (id: number, parent_id: number | null, name: string): Asset => ({ id, parent_id, name, kind: "generic", sort_order: id });

// Site > (Room A > Panel 1, Room B); Yard > Shed. Foldable: Site (1), Room A (2), Yard (5).
const flat: Asset[] = [a(1, null, "Site"), a(2, 1, "Room A"), a(3, 2, "Panel 1"), a(4, 1, "Room B"), a(5, null, "Yard"), a(6, 5, "Shed")];
const nodes = () => buildTree(flat);

type Props = Partial<Parameters<typeof AssetTree>[0]>;
const ui = (props: Props = {}) => (
  <MemoryRouter>
    <AssetTree nodes={nodes()} selectedId={null} onSelect={() => {}} {...props} />
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
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([]);
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
      expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([]);
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
