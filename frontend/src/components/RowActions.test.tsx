import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { Modal } from "./Modal";
import { RowActions, type RowAction } from "./RowActions";

const ITEMS: RowAction[] = [
  { label: "Edit", onSelect: () => {} },
  { label: "Check connection", onSelect: () => {} },
  { label: "Deactivate", onSelect: () => {}, disabled: true },
  { label: "Points", to: "/sources/3/points" },
  { label: "Unmap", onSelect: () => {}, tone: "danger" },
];

function Where() {
  return <output aria-label="where">{useLocation().pathname}</output>;
}
/** A table inside .table-wrap with one menu per row, and a button after it (where Tab goes when it leaves the menu). */
function page(rows: { name: string; items: RowAction[] }[], extra?: ReactNode) {
  return (
    <MemoryRouter>
      <div className="table-wrap">
        <table>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name}>
                <td>{row.name}</td>
                <td><RowActions label={`Actions for ${row.name}`} items={row.items} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button">after</button>
      <Where />
      {extra}
    </MemoryRouter>
  );
}
const mount = (items: RowAction[] = ITEMS) => {
  const view = render(page([{ name: "Boiler", items }]));
  return { ...view, trigger: screen.getByRole("button", { name: "Actions for Boiler" }) };
};
const menu = () => screen.queryByRole("menu");
const item = (name: string) => screen.getByRole("menuitem", { name });
const names = () => screen.queryAllByRole("menuitem").map((el) => el.textContent);

// jsdom 26 has no PointerEvent: without a stand-in pointerType is undefined and a mouse cannot be told from a touch.
const RealPointerEvent = (globalThis as { PointerEvent?: unknown }).PointerEvent;
beforeAll(() => {
  (globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerType = init.pointerType ?? ""; }
  };
});
afterAll(() => { (globalThis as { PointerEvent?: unknown }).PointerEvent = RealPointerEvent; });

describe("RowActions: the trigger and the panel", () => {
  it("renders nothing without items", () => {
    const { container } = render(<RowActions label="Actions for x" items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is a closed menu button named by the label, with no menu items in the page", () => {
    const { trigger } = mount();
    expect(trigger).toHaveAttribute("type", "button");
    expect(trigger).toHaveClass("icon-btn", "row-menu-btn");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("aria-controls"); // the panel is not in the page yet
    expect(trigger.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(menu()).toBeNull();
    expect(screen.queryAllByRole("menuitem")).toEqual([]);
  });

  it("opens on a click into a portal on document.body, outside the table, named by the trigger", async () => {
    const { trigger, container } = mount();
    await userEvent.click(trigger);
    const panel = screen.getByRole("menu", { name: "Actions for Boiler" });
    expect(panel.parentElement).toBe(document.body);
    expect(container.contains(panel)).toBe(false);
    expect(panel).toHaveClass("row-menu-panel");
    expect(panel).toHaveAttribute("aria-labelledby", trigger.id);
    expect(panel).not.toHaveAttribute("aria-label"); // the name comes from the trigger, not a copy
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", panel.id);
    expect(names()).toEqual(["Edit", "Check connection", "Deactivate", "Points", "Unmap"]);
    for (const el of screen.getAllByRole("menuitem")) expect(el).toHaveAttribute("tabindex", "-1");
    expect(trigger).toHaveFocus(); // a mouse click does not move the focus into the menu
  });

  it("a second click closes it", async () => {
    const { trigger } = mount();
    await userEvent.click(trigger);
    await userEvent.click(trigger);
    expect(menu()).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("marks a danger item and renders a disabled item as a disabled button", async () => {
    const { trigger } = mount([...ITEMS, { label: "Open", to: "/x", disabled: true }]);
    await userEvent.click(trigger);
    expect(item("Unmap")).toHaveClass("danger-item");
    expect(item("Edit")).not.toHaveClass("danger-item");
    expect(item("Deactivate")).toBeDisabled();
    expect(item("Open").tagName).toBe("BUTTON"); // a disabled link would still navigate
    expect(item("Open")).toBeDisabled();
  });

  it("renders a `to` item as a link to that address", async () => {
    const { trigger } = mount();
    await userEvent.click(trigger);
    const link = item("Points");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/sources/3/points");
    await userEvent.click(link);
    expect(screen.getByLabelText("where")).toHaveTextContent("/sources/3/points");
    expect(menu()).toBeNull();
  });

  it("a click inside the menu does not reach a handler of the row around it", async () => {
    const row = vi.fn();
    render(<MemoryRouter><div onClick={row}><RowActions label="Actions for X" items={ITEMS} /></div></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: "Actions for X" }));
    row.mockClear();
    await userEvent.click(item("Edit"));
    expect(row).not.toHaveBeenCalled();
  });
});

describe("RowActions: placement", () => {
  const rects = (trigger: object, panel: object) =>
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { x: 0, y: 0, toJSON: () => ({}), ...(this.getAttribute("role") === "menu" ? panel : trigger) } as DOMRect;
    });

  it("puts the panel beside the trigger, to its left, at the place placePanel gives", async () => {
    rects({ top: 100, bottom: 128, left: 972, right: 1000, width: 28, height: 28 }, { top: 0, bottom: 200, left: 0, right: 180, width: 180, height: 200 });
    const { trigger } = mount();
    await userEvent.click(trigger);
    expect(menu()).toHaveStyle({ top: "100px", left: "788px", "max-height": "660px" }); // jsdom's window is 1024 x 768: 768 - 100 - 8; 972 - 4 - 180
  });

  it("puts its bottom edge on the trigger's bottom when the row is near the bottom of the window", async () => {
    rects({ top: 700, bottom: 728, left: 972, right: 1000, width: 28, height: 28 }, { top: 0, bottom: 200, left: 0, right: 180, width: 180, height: 200 });
    const { trigger } = mount();
    await userEvent.click(trigger);
    expect(menu()).toHaveStyle({ top: "528px", left: "788px" }); // 728 - 200
  });

  it("falls back to below the trigger when there is no room at its left", async () => {
    rects({ top: 100, bottom: 128, left: 20, right: 48, width: 28, height: 28 }, { top: 0, bottom: 200, left: 0, right: 180, width: 180, height: 200 });
    const { trigger } = mount();
    await userEvent.click(trigger);
    expect(menu()).toHaveStyle({ top: "132px", left: "8px" });
  });
});

describe("RowActions: the keyboard", () => {
  it("Enter opens it and focuses the first enabled item; Space does too", async () => {
    const { trigger } = mount();
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    expect(menu()).not.toBeNull();
    expect(item("Edit")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(item("Edit")).toHaveFocus();
  });

  it("ArrowDown opens and focuses the first item, ArrowUp the last", async () => {
    const { trigger } = mount();
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(item("Edit")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{ArrowUp}");
    expect(item("Unmap")).toHaveFocus();
  });

  it("the arrows walk the enabled items and wrap; the disabled one is skipped; Home and End jump", async () => {
    const { trigger } = mount();
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      seen.push(document.activeElement!.textContent!);
      await userEvent.keyboard("{ArrowDown}");
    }
    expect(seen).toEqual(["Edit", "Check connection", "Points", "Unmap", "Edit"]);
    await userEvent.keyboard("{ArrowUp}");
    expect(item("Edit")).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(item("Unmap")).toHaveFocus(); // wrapped from the first to the last
    await userEvent.keyboard("{Home}");
    expect(item("Edit")).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(item("Unmap")).toHaveFocus();
  });

  it("Escape closes and gives the focus back to the trigger", async () => {
    const { trigger } = mount();
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await userEvent.keyboard("{Escape}");
    expect(menu()).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("Tab closes it with the focus on the trigger, so the next stop is the element after the trigger", async () => {
    const { trigger } = mount();
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.tab();
    expect(menu()).toBeNull();
    expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
    expect(trigger).not.toHaveFocus();
  });

  it("Shift+Tab from the menu lands before the trigger, not on it", async () => {
    const { trigger } = mount();
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.tab({ shift: true });
    expect(menu()).toBeNull();
    expect(document.activeElement).not.toBe(trigger);
    expect(document.activeElement).toBe(document.body); // nothing tabbable precedes it here
  });

  it("Enter on an item selects it once, closes the menu and leaves the focus on the trigger", async () => {
    const onSelect = vi.fn();
    const { trigger } = mount([{ label: "Edit", onSelect }, { label: "Other", onSelect: () => {} }]);
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("the trigger already has the focus when onSelect runs (a dialog it opens records the trigger)", async () => {
    let focusedInSelect: Element | null = null;
    const { trigger } = mount([{ label: "Edit", onSelect: () => { focusedInSelect = document.activeElement; } }]);
    await userEvent.click(trigger);
    await userEvent.click(item("Edit"));
    expect(focusedInSelect).toBe(trigger);
  });

  it("a dialog opened from an item gives the focus back to the trigger when Escape closes it", async () => {
    function Host() {
      const [editing, setEditing] = useState(false);
      return (
        <MemoryRouter>
          <RowActions label="Actions for Boiler" items={[{ label: "Edit", onSelect: () => setEditing(true) }]} />
          {editing && <Modal title="Edit Boiler" onClose={() => setEditing(false)}><input aria-label="field" /></Modal>}
        </MemoryRouter>
      );
    }
    render(<Host />);
    const trigger = screen.getByRole("button", { name: "Actions for Boiler" });
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByRole("dialog", { name: "Edit Boiler" })).toBeInTheDocument();
    expect(screen.getByLabelText("field")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("Space on a link item follows it", async () => {
    const { trigger } = mount();
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}"); // Edit, Check connection, Points
    expect(item("Points")).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(screen.getByLabelText("where")).toHaveTextContent("/sources/3/points");
  });

  it("a disabled item cannot be activated by the mouse and the menu stays open", async () => {
    const onSelect = vi.fn();
    const { trigger } = mount([{ label: "Edit", onSelect: () => {} }, { label: "Deactivate", onSelect, disabled: true }]);
    await userEvent.click(trigger);
    await userEvent.click(item("Deactivate"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it("a menu whose only item is disabled opens, and the keys do not throw", async () => {
    const { trigger } = mount([{ label: "Deactivate", disabled: true }]);
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}{ArrowUp}{Home}{End}");
    expect(menu()).not.toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe("RowActions: closing", () => {
  it("a press outside closes it, a press on the trigger is not outside", async () => {
    const { trigger } = mount();
    await userEvent.click(trigger);
    fireEvent.pointerDown(trigger);
    expect(menu()).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(menu()).toBeNull();
  });

  it("a press inside the panel does not close it", async () => {
    const { trigger } = mount();
    await userEvent.click(trigger);
    fireEvent.pointerDown(item("Edit"));
    expect(menu()).not.toBeNull();
  });

  it("a focus that moves outside closes it without taking the focus back", async () => {
    const { trigger } = mount();
    await userEvent.click(trigger);
    const after = screen.getByRole("button", { name: "after" });
    act(() => after.focus());
    expect(menu()).toBeNull();
    expect(after).toHaveFocus();
  });

  describe("scrolling", () => {
    let clock = 10_000;
    beforeEach(() => { clock = 10_000; vi.spyOn(performance, "now").mockImplementation(() => clock); });
    afterEach(() => { vi.restoreAllMocks(); });

    it("a scroll anywhere outside the panel closes it, a scroll inside the panel does not", async () => {
      const { trigger } = mount();
      await userEvent.click(trigger);
      clock += 500;
      fireEvent.scroll(menu()!);
      expect(menu()).not.toBeNull();
      fireEvent.scroll(document.querySelector(".table-wrap")!);
      expect(menu()).toBeNull();
      await userEvent.click(trigger);
      clock += 500;
      fireEvent.scroll(window);
      expect(menu()).toBeNull();
    });

    it("a scroll that arrives right after it opened does not close it (a row scrolled into view, then clicked)", async () => {
      const { trigger } = mount();
      await userEvent.click(trigger);
      clock += 120;
      fireEvent.scroll(window);
      expect(menu()).not.toBeNull();
      clock += 400;
      fireEvent.scroll(window);
      expect(menu()).toBeNull();
    });
  });

  it("a resize closes it", async () => {
    const { trigger } = mount();
    await userEvent.click(trigger);
    fireEvent(window, new Event("resize"));
    expect(menu()).toBeNull();
  });

  it("only one menu is open at a time", async () => {
    render(page([{ name: "A", items: ITEMS }, { name: "B", items: ITEMS }]));
    const a = screen.getByRole("button", { name: "Actions for A" });
    const b = screen.getByRole("button", { name: "Actions for B" });
    await userEvent.click(a);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    await userEvent.click(b);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu", { name: "Actions for B" })).toBeInTheDocument();
    expect(a).toHaveAttribute("aria-expanded", "false");
  });

  it("goes away with the component, and the next menu opens", async () => {
    const view = render(page([{ name: "A", items: ITEMS }]));
    await userEvent.click(screen.getByRole("button", { name: "Actions for A" }));
    view.unmount();
    expect(menu()).toBeNull();
    render(page([{ name: "B", items: ITEMS }]));
    await userEvent.click(screen.getByRole("button", { name: "Actions for B" }));
    expect(menu()).not.toBeNull();
  });
});

describe("RowActions: the mouse", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  const move = (el: Element, pointerType = "mouse") => fireEvent.pointerMove(el, { pointerType });
  const enter = (el: Element, pointerType = "mouse") => fireEvent.pointerEnter(el, { pointerType });
  const leave = (el: Element, pointerType = "mouse") => fireEvent.pointerLeave(el, { pointerType });
  const click = (el: Element) => fireEvent.click(el, { detail: 1 });
  /** The mouse arrives, moves and rests long enough to open the menu. */
  const hoverOpen = (trigger: Element) => { enter(trigger); move(trigger); advance(200); };

  it("opens after a mouse has moved over the trigger and rested 200 ms", () => {
    const { trigger } = mount();
    enter(trigger);
    move(trigger);
    advance(199);
    expect(menu()).toBeNull();
    advance(1);
    expect(menu()).not.toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).not.toHaveFocus(); // hover does not move the focus
  });

  it("does not open when the pointer only arrived (a pointer resting under a dialog that closed)", () => {
    const { trigger } = mount();
    enter(trigger);
    advance(1000);
    expect(menu()).toBeNull();
  });

  it("a touch or a pen never hover-opens", () => {
    const { trigger } = mount();
    for (const kind of ["touch", "pen"]) {
      enter(trigger, kind);
      move(trigger, kind);
      advance(1000);
      expect(menu()).toBeNull();
    }
  });

  it("a tap toggles it", () => {
    const { trigger } = mount();
    click(trigger);
    expect(menu()).not.toBeNull();
    click(trigger);
    expect(menu()).toBeNull();
  });

  it("an unpinned menu closes 150 ms after the mouse leaves the trigger", () => {
    const { trigger } = mount();
    hoverOpen(trigger);
    leave(trigger);
    advance(149);
    expect(menu()).not.toBeNull();
    advance(1);
    expect(menu()).toBeNull();
  });

  it("stays open while the mouse crosses to the panel, and closes 150 ms after it leaves the panel", () => {
    const { trigger } = mount();
    hoverOpen(trigger);
    leave(trigger);
    advance(100);
    enter(menu()!);
    advance(1000);
    expect(menu()).not.toBeNull();
    leave(menu()!);
    advance(150);
    expect(menu()).toBeNull();
  });

  it("stays open when the mouse comes back to the trigger in time", () => {
    const { trigger } = mount();
    hoverOpen(trigger);
    leave(trigger);
    advance(100);
    enter(trigger);
    advance(1000);
    expect(menu()).not.toBeNull();
  });

  it("a click on a hover-opened menu pins it: it stays open when the mouse leaves; a second click closes it", () => {
    const { trigger } = mount();
    hoverOpen(trigger);
    click(trigger);
    expect(menu()).not.toBeNull();
    leave(trigger);
    advance(1000);
    expect(menu()).not.toBeNull();
    click(trigger);
    expect(menu()).toBeNull();
  });

  it("a click during the 200 ms opens it pinned, and the timer then does nothing more", () => {
    const { trigger } = mount();
    enter(trigger);
    move(trigger);
    advance(100);
    click(trigger);
    expect(menu()).not.toBeNull();
    advance(500);
    leave(trigger);
    advance(500);
    expect(menu()).not.toBeNull(); // pinned
  });

  it("leaving before 200 ms cancels the opening", () => {
    const { trigger } = mount();
    enter(trigger);
    move(trigger);
    advance(100);
    leave(trigger);
    advance(1000);
    expect(menu()).toBeNull();
  });

  it("after a click closed it, the mouse resting on the trigger does not open it again; leaving and coming back does", () => {
    const { trigger } = mount();
    hoverOpen(trigger);
    click(trigger);
    click(trigger);
    expect(menu()).toBeNull();
    move(trigger);
    advance(1000);
    expect(menu()).toBeNull();
    leave(trigger);
    enter(trigger);
    move(trigger);
    advance(200);
    expect(menu()).not.toBeNull();
  });

  it("Escape closes a hover-opened menu, and it does not come back while the mouse stays", () => {
    const { trigger } = mount();
    hoverOpen(trigger);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(menu()).toBeNull();
    move(trigger);
    advance(1000);
    expect(menu()).toBeNull();
  });

  it("Escape on a hover-opened menu leaves the focus where it was (a field being typed in)", () => {
    render(page([{ name: "Boiler", items: ITEMS }], <input aria-label="note" />));
    screen.getByLabelText("note").focus();
    hoverOpen(screen.getByRole("button", { name: "Actions for Boiler" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(menu()).toBeNull();
    expect(screen.getByLabelText("note")).toHaveFocus();
  });

  it("opening one menu closes another, whether it was pinned or hover-opened", () => {
    render(page([{ name: "A", items: ITEMS }, { name: "B", items: ITEMS }]));
    const a = screen.getByRole("button", { name: "Actions for A" });
    const b = screen.getByRole("button", { name: "Actions for B" });
    click(a);
    hoverOpen(b);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu", { name: "Actions for B" })).toBeInTheDocument();
    leave(b);
    enter(a);
    move(a);
    advance(200);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu", { name: "Actions for A" })).toBeInTheDocument();
  });

  it("clears its timers when the component goes away", () => {
    const view = render(page([{ name: "A", items: ITEMS }]));
    const trigger = screen.getByRole("button", { name: "Actions for A" });
    enter(trigger);
    move(trigger);
    view.unmount();
    advance(1000);
    expect(menu()).toBeNull();
  });
});
