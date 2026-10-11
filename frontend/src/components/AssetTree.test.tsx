import { fireEvent, render, screen, within } from "@testing-library/react";
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

describe("AssetTree width", () => {
  const WIDTH_KEY = "dcdash.assetTreeWidth";
  const realViewport = window.innerWidth;
  const setViewport = (px: number) => { Object.defineProperty(window, "innerWidth", { value: px, configurable: true, writable: true }); };
  const max = () => Math.floor(window.innerWidth / 2);
  const rect = (left: number, width: number) => ({ left, width, right: left + width, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

  const column = () => screen.getByRole("region", { name: "Asset tree" });
  const separator = () => screen.getByRole("separator", { name: "Resize the tree column" });
  const userWidth = () => column().style.getPropertyValue("--tree-user-w");
  const stored = () => localStorage.getItem(WIDTH_KEY);
  const valueNow = () => separator().getAttribute("aria-valuenow");

  // jsdom has no PointerEvent, so these are MouseEvents with a pointer type name: React routes by the type and reads clientX from them.
  const point = (type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", clientX: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 7 });
    fireEvent(separator(), event);
  };

  let setCapture: ReturnType<typeof vi.fn>;
  let releaseCapture: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    setViewport(1000);
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
      setViewport(1000);
      localStorage.setItem(WIDTH_KEY, "400");
      render(ui());
      expect(valueNow()).toBe("400");
      setViewport(600);
      fireEvent(window, new Event("resize"));
      expect(userWidth()).toBe("300px");
      expect(valueNow()).toBe("300");
      expect(separator()).toHaveAttribute("aria-valuemax", "300");
      expect(stored()).toBe("400"); // a window resize is not a choice of the user
      setViewport(1000);
      fireEvent(window, new Event("resize"));
      expect(userWidth()).toBe("400px");
      expect(separator()).toHaveAttribute("aria-valuemax", "500");
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
