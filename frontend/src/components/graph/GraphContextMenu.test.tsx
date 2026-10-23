import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RowAction } from "../RowActions";
import { GraphContextMenu, placeAtPoint, placeBelowBox } from "./GraphContextMenu";

const items = (over: Partial<Record<string, Partial<RowAction>>> = {}): RowAction[] => [
  { label: "Details", onSelect: vi.fn(), ...over.Details },
  { label: "Collapse", onSelect: vi.fn(), ...over.Collapse },
  { label: "Create assets…", onSelect: vi.fn(), ...over.Create },
  { label: "Remove", onSelect: vi.fn(), tone: "danger", ...over.Remove },
];

function open(props: Partial<React.ComponentProps<typeof GraphContextMenu>> = {}) {
  const returnTo = document.createElement("div");
  returnTo.tabIndex = 0;
  returnTo.setAttribute("data-testid", "node");
  document.body.append(returnTo);
  const onClose = vi.fn();
  const list = items();
  const view = render(
    <GraphContextMenu at={{ x: 100, y: 50 }} items={list} label="Plant OPC actions" returnFocus={() => returnTo} onClose={onClose} {...props} />,
  );
  return { returnTo, onClose, list, ...view };
}
const menuItems = () => screen.getAllByRole("menuitem");
afterEach(() => document.querySelectorAll('[data-testid="node"]').forEach((el) => el.remove()));

describe("GraphContextMenu", () => {
  it("is a role=menu named by its label, in a portal on the body, with the row menu's look", () => {
    const { container } = open();
    const menu = screen.getByRole("menu", { name: "Plant OPC actions" });
    expect(menu).toHaveClass("row-menu-panel", "graph-menu");
    expect(menu.parentElement).toBe(document.body);
    expect(container).not.toContainElement(menu);
    expect(menuItems().map((i) => i.textContent)).toEqual(["Details", "Collapse", "Create assets…", "Remove"]);
    expect(menuItems().every((i) => i.getAttribute("type") === "button")).toBe(true);
    expect(screen.getByRole("menuitem", { name: "Remove" })).toHaveClass("danger-item");
  });

  it("opens with the focus on the first ENABLED item", () => {
    open();
    expect(menuItems()[0]).toHaveFocus();
  });

  it("a disabled item uses aria-disabled (never native disabled), is skipped by the focus and by the arrows, and does nothing when clicked", async () => {
    const list = items({ Details: { disabled: true }, Collapse: { disabled: true } });
    const { onClose } = open({ items: list });
    expect(menuItems()[0]).toHaveAttribute("aria-disabled", "true");
    expect(menuItems()[0]).not.toBeDisabled();
    expect(menuItems()[2]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(menuItems()[3]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(menuItems()[2]).toHaveFocus(); // wrapped past the two disabled ones
    await userEvent.click(menuItems()[0]);
    expect(list[0].onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a menu whose items are all disabled takes the focus itself (it is named), arrows do nothing, and Escape closes it and returns the focus", async () => {
    const list = items({ Details: { disabled: true, reason: "Already mapped as p1" } }).slice(0, 1);
    const { returnTo, onClose } = open({ items: list });
    const menu = screen.getByRole("menu", { name: "Plant OPC actions" });
    expect(menu).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{End}{Home}");
    expect(menu).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(returnTo).toHaveFocus();
  });

  it("a disabled item's reason is a muted second line INSIDE the item (read with it) and its title; an enabled item, or a disabled one with no reason, shows plain text", async () => {
    const reason = "Select a source, group or asset first.";
    const list = items({ Details: { disabled: true, reason }, Collapse: { reason: "ignored while enabled" }, Create: { disabled: true } });
    open({ items: list });
    const [details, collapse, create] = menuItems();
    expect(details).toHaveAttribute("aria-disabled", "true");
    expect(details).toHaveAttribute("title", reason);
    const line = details.querySelector(".graph-menu-reason") as HTMLElement;
    expect(line).toHaveTextContent(reason);
    expect(details).toHaveTextContent(`Details ${reason}`);
    expect(screen.getByRole("menuitem", { name: `Details ${reason}` })).toBe(details); // the reason is part of the item's name
    expect(collapse.querySelector(".graph-menu-reason")).toBeNull();
    expect(collapse).not.toHaveAttribute("title");
    expect(collapse.textContent).toBe("Collapse");
    expect(create.querySelector(".graph-menu-reason")).toBeNull();
    expect(create.textContent).toBe("Create assets…");
    expect(details).not.toHaveFocus(); // arrows and the first focus still skip it
    expect(collapse).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(menuItems()[3]).toHaveFocus();
  });

  it("ArrowDown and ArrowUp wrap; Home and End jump", async () => {
    open();
    await userEvent.keyboard("{ArrowUp}");
    expect(menuItems()[3]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(menuItems()[0]).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(menuItems()[3]).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(menuItems()[0]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(menuItems()[2]).toHaveFocus();
  });

  it("Enter and Space activate the focused item", async () => {
    const { list } = open();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(list[1].onSelect).toHaveBeenCalledTimes(1);
  });

  it("choosing an item closes the menu and puts the focus on returnFocus() BEFORE onSelect runs (a dialog it opens records that place)", async () => {
    let focusInSelect: Element | null = null;
    let closedBefore = false;
    const onClose = vi.fn();
    const list = items({ Details: { onSelect: vi.fn(() => { focusInSelect = document.activeElement; closedBefore = onClose.mock.calls.length === 1; }) } });
    const { returnTo } = open({ items: list, onClose });
    await userEvent.click(menuItems()[0]);
    expect(focusInSelect).toBe(returnTo);
    expect(closedBefore).toBe(true);
  });

  it("Tab closes it and the focus goes to returnFocus(); the key is not prevented, so the browser moves on from there", () => {
    const { returnTo, onClose } = open();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    menuItems()[0].dispatchEvent(tab);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(returnTo).toHaveFocus();
    expect(tab.defaultPrevented).toBe(false);
  });

  it("Escape closes only itself: returns the focus, and neither a React parent nor a document listener hears it", async () => {
    const heard = vi.fn();
    const onDocument = (event: KeyboardEvent) => heard(event.key);
    document.addEventListener("keydown", onDocument);
    const parent = vi.fn();
    const { returnTo, onClose } = open();
    render(<div onKeyDown={parent}><GraphContextMenu at={{ x: 1, y: 1 }} items={items()} label="Second" returnFocus={() => returnTo} onClose={onClose} /></div>);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    expect(returnTo).toHaveFocus();
    expect(parent).not.toHaveBeenCalled();
    expect(heard).not.toHaveBeenCalled();
    document.removeEventListener("keydown", onDocument);
  });

  it("a press outside closes it (and leaves the focus where the user clicked); a press inside does not", () => {
    const { onClose } = open();
    fireEvent.pointerDown(menuItems()[1]);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a scroll inside the menu does not close it", () => {
    const { onClose } = open();
    fireEvent.scroll(screen.getByRole("menu"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    ["a scroll outside", () => fireEvent.scroll(document.body)],
    ["a resize", () => fireEvent(window, new Event("resize"))],
    ["the focus leaving for something else", () => {
      const outside = document.createElement("button");
      document.body.append(outside);
      outside.focus();
      outside.remove();
    }],
  ])("%s closes it", (_name, trigger) => {
    const { onClose } = open();
    trigger();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("onClose is called once however many things close it (Escape moves the focus back to the node, which also leaves the menu)", async () => {
    const { onClose } = open();
    await userEvent.keyboard("{Escape}");
    fireEvent.pointerDown(document.body);
    fireEvent.scroll(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a right-click on the menu gets no browser menu, and a click in it reaches nobody above it", () => {
    const above = vi.fn();
    render(<div onClick={above} onContextMenu={above}><GraphContextMenu at={{ x: 1, y: 1 }} items={items()} label="Inner" returnFocus={() => null} onClose={vi.fn()} /></div>);
    const menu = screen.getByRole("menu", { name: "Inner" });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    menu.dispatchEvent(event);
    fireEvent.click(menu);
    expect(event.defaultPrevented).toBe(true);
    expect(above).not.toHaveBeenCalled();
  });

  it("renders nothing, and closes, when there are no items", () => {
    const { onClose } = open({ items: [] });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });

  it("at a point it sits at the point (jsdom measures the panel as 0x0); next to a box it goes through the row menu's placement", () => {
    const view = open();
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe("100px");
    expect(menu.style.top).toBe("50px");
    view.unmount();
    open({ at: { box: { top: 300, left: 500, right: 700, bottom: 380 } } });
    // placePanel: beside the box at the left, on its top edge
    expect(screen.getByRole("menu").style.top).toBe("300px");
  });

  it("with `below`, a menu hangs from the box: under it with a 4px gap, its left edge on the box's ('start') or its right edge on the box's ('end')", () => {
    const box = { top: 300, left: 500, right: 700, bottom: 380 };
    const view = open({ at: { box, below: "start" } });
    expect(screen.getByRole("menu").style.top).toBe("384px"); // jsdom measures the panel as 0x0
    expect(screen.getByRole("menu").style.left).toBe("500px");
    view.unmount();
    open({ at: { box, below: "end" } });
    expect(screen.getByRole("menu").style.top).toBe("384px");
    expect(screen.getByRole("menu").style.left).toBe("700px");
  });
});

describe("placeBelowBox (a menu that hangs from a horizontal bar opens under its button)", () => {
  const viewport = { width: 1000, height: 700 };
  const panel = { width: 200, height: 160 };
  const button = { top: 100, left: 300, right: 340, bottom: 130 };
  it.each([
    ["start: under the box, left edges aligned", button, "start", { left: 300, top: 134, placement: "down", maxHeight: 558 }],
    ["end: under the box, right edges aligned", button, "end", { left: 140, top: 134, placement: "down", maxHeight: 558 }],
    ["end at the left edge of the window: kept 8px from it", { ...button, left: 10, right: 50 }, "end", { left: 8, top: 134, placement: "down" }],
    ["start at the right edge of the window: kept 8px from it", { ...button, left: 950, right: 990 }, "start", { left: 792, top: 134, placement: "down" }],
    ["no room below: flipped above the box, 4px clear of it", { ...button, top: 600, bottom: 630 }, "start", { left: 300, top: 436, placement: "up", maxHeight: 256 }],
    ["room below to exactly the bottom margin: stays below", { ...button, top: 498, bottom: 528 }, "start", { top: 532, placement: "down", maxHeight: 160 }],
  ] as const)("%s", (_name, box, align, expected) => {
    expect(placeBelowBox(box, panel, viewport, align, 4, 52)).toMatchObject(expected);
  });

  it("a box right under the top bar still gives a menu that starts under the bar", () => {
    expect(placeBelowBox({ ...button, top: 0, bottom: 20 }, panel, viewport, "start", 4, 52).top).toBe(52);
  });

  it("a panel that fits neither below nor above stays below, clamped to the window and scrolling inside its maxHeight", () => {
    const tall = { width: 200, height: 700 };
    const placed = placeBelowBox(button, tall, viewport, "start", 4, 52);
    expect(placed).toMatchObject({ top: 134, placement: "down", maxHeight: 700 - 134 - 8 });
    expect(placed.top + placed.maxHeight).toBeLessThanOrEqual(700 - 8);
  });

  it("a window narrower than the panel keeps the left margin, for either alignment", () => {
    const narrow = { width: 300, height: 700 };
    const wide = { width: 400, height: 100 };
    expect(placeBelowBox(button, wide, narrow, "start", 4, 52).left).toBe(8);
    expect(placeBelowBox(button, wide, narrow, "end", 4, 52).left).toBe(8);
  });
});

describe("placeAtPoint (a context menu opens at the pointer, not beside it)", () => {
  const viewport = { width: 1000, height: 700 };
  const panel = { width: 200, height: 160 };
  it.each([
    ["room on the right and below: the pointer is the top-left corner", { x: 100, y: 100 }, { left: 100, top: 100, placement: "down" }],
    ["no room on the right: it opens to the left of the pointer", { x: 900, y: 100 }, { left: 700, top: 100, placement: "down" }],
    ["no room below: it opens above the pointer", { x: 100, y: 650 }, { left: 100, top: 490, placement: "up" }],
    ["no room right or below: the corner opposite", { x: 900, y: 650 }, { left: 700, top: 490, placement: "up" }],
    ["room exactly to the edge margin on the right", { x: 792, y: 100 }, { left: 792, top: 100, placement: "down" }],
  ])("%s", (_name, at, expected) => {
    expect(placeAtPoint(at, panel, viewport, 52)).toMatchObject(expected);
  });

  it("never runs under the top bar: above the pointer only when the whole panel fits below the inset, else clamped to it with a scroll", () => {
    const tall = { width: 200, height: 600 };
    const placed = placeAtPoint({ x: 100, y: 400 }, tall, { width: 1000, height: 700 }, 52);
    expect(placed.top).toBeGreaterThanOrEqual(52);
    expect(placed.top + placed.maxHeight).toBeLessThanOrEqual(700);
    expect(placed.maxHeight).toBe(700 - placed.top - 8);
  });

  it("stays inside a viewport narrower than the panel (left clamped to the margin)", () => {
    expect(placeAtPoint({ x: 50, y: 50 }, { width: 400, height: 100 }, { width: 300, height: 700 }, 52).left).toBe(8);
  });
});
