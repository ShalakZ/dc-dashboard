import { fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { useRef } from "react";
import { useCanvasKeys } from "./useCanvasKeys";

const calls = { openFind: vi.fn(), openMenuFor: vi.fn(), onEscape: vi.fn(), openKeys: vi.fn() };

/** The canvas wrapper with a node, a canvas control, the Find card inside it and a menu portalled out of it (React events cross the portal, the DOM does not). */
function Host({ portal }: { portal?: HTMLElement }) {
  const canvas = useRef<HTMLDivElement>(null);
  const { onKeyDown } = useCanvasKeys({ canvas, ...calls });
  return (
    <div>
      <button type="button">outside</button>
      <div ref={canvas} data-testid="canvas" tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="react-flow__node" data-id="src:1" tabIndex={0}>node</div>
        <div className="react-flow__controls"><button type="button">Fit view</button></div>
        <div className="graph-tools">
          <div className="graph-find"><input aria-label="in find" /></div>
        </div>
        <input aria-label="a field" />
        <textarea aria-label="a text area" />
        <select aria-label="a choice"><option>one</option></select>
        <div contentEditable suppressContentEditableWarning aria-label="an editable">edit</div>
        {portal && createPortal(<div className="graph-menu"><button type="button">in menu</button></div>, portal)}
      </div>
    </div>
  );
}

const press = (el: Element, init: KeyboardEventInit) => fireEvent.keyDown(el, init);
let heard: ReturnType<typeof vi.fn>;
const onDocument = (event: KeyboardEvent) => heard(event.key);

beforeEach(() => {
  Object.values(calls).forEach((fn) => fn.mockClear());
  heard = vi.fn();
  document.addEventListener("keydown", onDocument);
});
afterEach(() => document.removeEventListener("keydown", onDocument));

describe("useCanvasKeys", () => {
  it.each([
    ["Ctrl+K", { key: "k", ctrlKey: true }],
    ["Cmd+K", { key: "k", metaKey: true }],
    ["Ctrl+K with caps lock", { key: "K", ctrlKey: true }],
  ])("%s on the canvas opens Find and the event goes no further (the top bar's quick find never sees it)", (_name, init) => {
    render(<Host />);
    const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
    screen.getByText("node").dispatchEvent(event);
    expect(calls.openFind).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(heard).not.toHaveBeenCalled();
  });

  it.each([
    ["Ctrl+Shift+K", { key: "k", ctrlKey: true, shiftKey: true }],
    ["Alt+K", { key: "k", altKey: true }],
    ["Ctrl+Alt+K", { key: "k", ctrlKey: true, altKey: true }],
    ["K alone", { key: "k" }],
    ["Ctrl+J", { key: "j", ctrlKey: true }],
    ["an autofill keydown without a key", { ctrlKey: true }],
  ])("%s does nothing (and leaves the key to the page)", (_name, init) => {
    render(<Host />);
    press(screen.getByText("node"), init);
    expect(calls.openFind).not.toHaveBeenCalled();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+K from outside the canvas is the page's: the hook is not even attached there, and the document listener hears it", () => {
    render(<Host />);
    press(screen.getByRole("button", { name: "outside" }), { key: "k", ctrlKey: true });
    expect(calls.openFind).not.toHaveBeenCalled();
    expect(heard).toHaveBeenCalledWith("k");
  });

  it("Ctrl+K with the focus on a control inside the canvas (Fit view) opens the canvas Find (the bar's own Find button is outside the canvas: the bar handles its Ctrl+K itself)", () => {
    render(<Host />);
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    screen.getByRole("button", { name: "Fit view" }).dispatchEvent(event);
    expect(calls.openFind).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(heard).not.toHaveBeenCalled(); // the top bar's quick find never sees it
  });

  it("the other canvas keys work from a canvas control too: Escape clears the selection, Shift+F10 opens the canvas menu for it", () => {
    render(<Host />);
    const button = screen.getByRole("button", { name: "Fit view" });
    press(button, { key: "Escape" });
    press(button, { key: "F10", shiftKey: true });
    expect(calls.onEscape).toHaveBeenCalledTimes(1);
    expect(calls.openMenuFor).toHaveBeenCalledWith(button);
  });

  it("a keydown inside the Find card does nothing for the wrapper: the card handles (and stops) its own keys", () => {
    render(<Host />);
    press(screen.getByLabelText("in find"), { key: "k", ctrlKey: true });
    press(screen.getByLabelText("in find"), { key: "Escape" });
    press(screen.getByLabelText("in find"), { key: "F10", shiftKey: true });
    expect(calls.openFind).not.toHaveBeenCalled();
    expect(calls.onEscape).not.toHaveBeenCalled();
    expect(calls.openMenuFor).not.toHaveBeenCalled();
  });

  it("a keydown that reaches the wrapper through a React portal (the menu is not inside the canvas in the DOM) does nothing", () => {
    const outlet = document.createElement("div");
    document.body.append(outlet);
    render(<Host portal={outlet} />);
    press(screen.getByRole("button", { name: "in menu" }), { key: "k", ctrlKey: true });
    press(screen.getByRole("button", { name: "in menu" }), { key: "Escape" });
    expect(calls.openFind).not.toHaveBeenCalled();
    expect(calls.onEscape).not.toHaveBeenCalled();
    outlet.remove();
  });

  it("does nothing while a modal dialog is open", () => {
    render(<><Host /><div role="dialog" aria-modal="true" /></>);
    press(screen.getByText("node"), { key: "k", ctrlKey: true });
    press(screen.getByText("node"), { key: "Escape" });
    press(screen.getByText("node"), { key: "ContextMenu" });
    expect(calls.openFind).not.toHaveBeenCalled();
    expect(calls.onEscape).not.toHaveBeenCalled();
    expect(calls.openMenuFor).not.toHaveBeenCalled();
  });

  it.each([
    ["the ContextMenu key", { key: "ContextMenu" }],
    ["Shift+F10", { key: "F10", shiftKey: true }],
  ])("%s opens the menu for the focused element and is not left to the browser", (_name, init) => {
    render(<Host />);
    const node = screen.getByText("node");
    const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
    node.dispatchEvent(event);
    expect(calls.openMenuFor).toHaveBeenCalledWith(node);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    ["F10 alone", { key: "F10" }],
    ["Ctrl+Shift+F10", { key: "F10", shiftKey: true, ctrlKey: true }],
    ["Alt+Shift+F10", { key: "F10", shiftKey: true, altKey: true }],
  ])("%s does not open the menu", (_name, init) => {
    render(<Host />);
    press(screen.getByText("node"), init);
    expect(calls.openMenuFor).not.toHaveBeenCalled();
  });

  it.each([
    ["on a node (a US keyboard sends Shift with it)", () => screen.getByText("node"), { key: "?", shiftKey: true }],
    ["on a node (a layout that sends no Shift)", () => screen.getByText("node"), { key: "?" }],
    ["on a canvas control", () => screen.getByRole("button", { name: "Fit view" }), { key: "?", shiftKey: true }],
  ])("? %s opens the shortcuts list and the key is not left to the browser", (_name, target, init) => {
    render(<Host />);
    const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
    target().dispatchEvent(event);
    expect(calls.openKeys).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(calls.openFind).not.toHaveBeenCalled();
  });

  it.each([
    ["a text field", () => screen.getByLabelText("a field")],
    ["a text area", () => screen.getByLabelText("a text area")],
    ["a select", () => screen.getByLabelText("a choice")],
    ["an editable element", () => screen.getByLabelText("an editable")],
    ["the Find card's field", () => screen.getByLabelText("in find")],
  ])("? typed in %s is a character, not the shortcuts list", (_name, target) => {
    render(<Host />);
    const event = new KeyboardEvent("keydown", { key: "?", shiftKey: true, bubbles: true, cancelable: true });
    target().dispatchEvent(event);
    expect(calls.openKeys).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }],
    ["Alt", { altKey: true }],
  ])("? with %s held is somebody else's key", (_name, held) => {
    render(<Host />);
    press(screen.getByText("node"), { key: "?", shiftKey: true, ...held });
    expect(calls.openKeys).not.toHaveBeenCalled();
  });

  it("? does nothing inside a menu that reaches the wrapper through a portal, nor behind a modal dialog", () => {
    const outlet = document.createElement("div");
    document.body.append(outlet);
    const { unmount } = render(<Host portal={outlet} />);
    press(screen.getByRole("button", { name: "in menu" }), { key: "?", shiftKey: true });
    expect(calls.openKeys).not.toHaveBeenCalled();
    unmount();
    outlet.remove();
    render(<><Host /><div role="dialog" aria-modal="true" /></>);
    press(screen.getByText("node"), { key: "?", shiftKey: true });
    expect(calls.openKeys).not.toHaveBeenCalled();
  });

  it("? from outside the canvas is the page's: the hook is not attached there", () => {
    render(<Host />);
    press(screen.getByRole("button", { name: "outside" }), { key: "?", shiftKey: true });
    expect(calls.openKeys).not.toHaveBeenCalled();
    expect(heard).toHaveBeenCalledWith("?");
  });

  it("Escape on the canvas calls onEscape; an Escape somebody already handled (defaultPrevented) does not", () => {
    render(<Host />);
    press(screen.getByText("node"), { key: "Escape" });
    expect(calls.onEscape).toHaveBeenCalledTimes(1);
    const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handled.preventDefault();
    screen.getByText("node").dispatchEvent(handled);
    expect(calls.onEscape).toHaveBeenCalledTimes(1);
  });
});
