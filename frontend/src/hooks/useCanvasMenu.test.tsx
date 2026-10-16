import { act, fireEvent, renderHook } from "@testing-library/react";
import { useRef, type RefObject } from "react";
import { useCanvasMenu } from "./useCanvasMenu";

/** A canvas wrapper with one node and a selection rectangle, sized by hand because jsdom measures nothing. */
function setup() {
  const canvas = document.createElement("div");
  canvas.tabIndex = -1;
  canvas.innerHTML = `
    <div class="react-flow__node" data-id="src:1" tabindex="0"><button type="button" class="inner">Details</button></div>
    <div class="react-flow__node" data-id="pt:2" tabindex="0"></div>
    <div class="react-flow__nodesselection-rect" tabindex="-1"></div>`;
  document.body.append(canvas);
  const box = (top: number, left: number, w: number, h: number) =>
    ({ top, left, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  canvas.getBoundingClientRect = () => box(100, 200, 800, 600);
  const node = canvas.querySelector<HTMLElement>('[data-id="src:1"]')!;
  node.getBoundingClientRect = () => box(150, 250, 220, 80);
  const rect = canvas.querySelector<HTMLElement>(".react-flow__nodesselection-rect")!;
  rect.getBoundingClientRect = () => box(300, 400, 100, 100);
  // The node's menu button sits at its top right corner.
  canvas.querySelector<HTMLElement>(".inner")!.getBoundingClientRect = () => box(154, 444, 20, 20);
  return { canvas, node, rect, inner: node.querySelector<HTMLElement>(".inner")!, other: canvas.querySelector<HTMLElement>('[data-id="pt:2"]')! };
}

const click = (init: Partial<MouseEvent> = {}) => ({
  clientX: 10, clientY: 20, currentTarget: null, target: null, preventDefault: vi.fn(), ...init,
});

function mount(canvasEl: HTMLElement, model: object = {}) {
  return renderHook(
    ({ model: m }) => {
      const canvas = useRef<HTMLElement>(canvasEl) as RefObject<HTMLElement | null>;
      return useCanvasMenu({ model: m, canvas });
    },
    { initialProps: { model } },
  );
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("useCanvasMenu", () => {
  it("starts closed", () => {
    const { canvas } = setup();
    expect(mount(canvas).result.current.menu).toBeNull();
  });

  it("openNode opens at the pointer, prevents the browser's own menu, and names the node as the place to return to", () => {
    const { canvas, node } = setup();
    const { result } = mount(canvas);
    const event = click({ clientX: 33, clientY: 44 });
    act(() => result.current.openNode("src:1", event));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(result.current.menu).toMatchObject({ target: { kind: "node", id: "src:1" }, at: { x: 33, y: 44 }, via: "pointer" });
    expect(result.current.menu?.returnFocus()).toBe(node);
  });

  it("a contextmenu with zero coordinates (the keyboard's, in some browsers) is anchored to the node's box", () => {
    const { canvas } = setup();
    const { result } = mount(canvas);
    act(() => result.current.openNode("src:1", click({ clientX: 0, clientY: 0 })));
    expect(result.current.menu?.at).toEqual({ box: { top: 150, left: 250, right: 470, bottom: 230 } });
  });

  it("openPane opens the canvas menu at the pointer and returns to the canvas; zero coordinates mean the canvas centre", () => {
    const { canvas } = setup();
    const { result } = mount(canvas);
    act(() => result.current.openPane(click({ clientX: 5, clientY: 6 })));
    expect(result.current.menu).toMatchObject({ target: { kind: "pane" }, at: { x: 5, y: 6 } });
    expect(result.current.menu?.returnFocus()).toBe(canvas);
    act(() => result.current.openPane(click({ clientX: 0, clientY: 0 })));
    expect(result.current.menu?.at).toEqual({ x: 600, y: 400 });
  });

  it("openSelection opens the selection's menu and returns to the selection rectangle", () => {
    const { canvas, rect } = setup();
    const { result } = mount(canvas);
    const event = click();
    act(() => result.current.openSelection(event));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(result.current.menu).toMatchObject({ target: { kind: "selection" }, at: { x: 10, y: 20 } });
    expect(result.current.menu?.returnFocus()).toBe(rect);
  });

  it("a pointer open replaces the menu that is open (a new id, so the page mounts a fresh one)", () => {
    const { canvas } = setup();
    const { result } = mount(canvas);
    act(() => result.current.openNode("src:1", click()));
    const first = result.current.menu!.id;
    act(() => result.current.openNode("pt:2", click({ clientX: 70, clientY: 80 })));
    expect(result.current.menu).toMatchObject({ target: { kind: "node", id: "pt:2" }, at: { x: 70, y: 80 } });
    expect(result.current.menu!.id).not.toBe(first);
  });

  it("close closes it", () => {
    const { canvas } = setup();
    const { result } = mount(canvas);
    act(() => result.current.openPane(click()));
    act(() => result.current.close());
    expect(result.current.menu).toBeNull();
  });

  describe("from the keyboard", () => {
    it("on a node (or anything inside one): the node's menu, anchored to the node's box; the focus returns to the element that had it", () => {
      const { canvas, node, inner } = setup();
      const { result } = mount(canvas);
      act(() => result.current.openFromKey(inner));
      expect(result.current.menu).toMatchObject({
        target: { kind: "node", id: "src:1" }, via: "key", at: { box: { top: 150, left: 250, right: 470, bottom: 230 } },
      });
      expect(result.current.menu?.returnFocus()).toBe(inner);
      inner.remove(); // the button went away: the node is the next best place
      expect(result.current.menu?.returnFocus()).toBe(node);
    });

    it("on the selection rectangle: the selection's menu", () => {
      const { canvas, rect } = setup();
      const { result } = mount(canvas);
      act(() => result.current.openFromKey(rect));
      expect(result.current.menu).toMatchObject({ target: { kind: "selection" }, via: "key", at: { box: { top: 300, left: 400 } } });
    });

    it.each([["the canvas wrapper itself"], ["null"]])("anywhere else (%s): the canvas menu at the canvas centre", (which) => {
      const { canvas } = setup();
      const { result } = mount(canvas);
      act(() => result.current.openFromKey(which === "null" ? null : canvas));
      expect(result.current.menu).toMatchObject({ target: { kind: "pane" }, via: "key", at: { x: 600, y: 400 } });
    });

    it("a second keyboard open for the same target while its menu is open is ignored (one menu, not two)", () => {
      const { canvas, node } = setup();
      const { result } = mount(canvas);
      act(() => result.current.openFromKey(node));
      const first = result.current.menu;
      act(() => result.current.openFromKey(node));
      expect(result.current.menu).toBe(first);
    });

    it("the browser's own contextmenu event that follows the key (same node, within 400 ms) is ignored, but still prevented", () => {
      vi.useFakeTimers();
      const { canvas, node } = setup();
      const { result } = mount(canvas);
      act(() => result.current.openFromKey(node));
      const first = result.current.menu;
      const echo = click({ clientX: 0, clientY: 0 });
      vi.advanceTimersByTime(399);
      act(() => result.current.openNode("src:1", echo));
      expect(echo.preventDefault).toHaveBeenCalled();
      expect(result.current.menu).toBe(first);
    });

    it("a deliberate right-click on the same node after 400 ms replaces the keyboard's menu", () => {
      vi.useFakeTimers();
      const { canvas, node } = setup();
      const { result } = mount(canvas);
      act(() => result.current.openFromKey(node));
      const first = result.current.menu;
      vi.advanceTimersByTime(401);
      act(() => result.current.openNode("src:1", click({ clientX: 90, clientY: 91 })));
      expect(result.current.menu).not.toBe(first);
      expect(result.current.menu).toMatchObject({ via: "pointer", at: { x: 90, y: 91 } });
    });

    it("a right-click on ANOTHER node within 400 ms is not an echo and replaces it", () => {
      const { canvas, node } = setup();
      const { result } = mount(canvas);
      act(() => result.current.openFromKey(node));
      act(() => result.current.openNode("pt:2", click()));
      expect(result.current.menu).toMatchObject({ target: { kind: "node", id: "pt:2" }, via: "pointer" });
    });

    it("after the menu is closed the same key opens it again", () => {
      const { canvas, node } = setup();
      const { result } = mount(canvas);
      act(() => result.current.openFromKey(node));
      act(() => result.current.close());
      act(() => result.current.openFromKey(node));
      expect(result.current.menu).not.toBeNull();
    });
  });

  describe("openFor: the menu button on a node", () => {
    it("opens the node's menu next to the BUTTON (its own box); the focus returns to the button, else to the node", () => {
      const { canvas, node, inner } = setup();
      const { result } = mount(canvas);
      act(() => result.current.openFor("src:1", inner));
      expect(result.current.menu).toMatchObject({ target: { kind: "node", id: "src:1" }, via: "key", at: { box: { top: 154, left: 444, right: 464, bottom: 174 } } });
      expect(result.current.menu?.returnFocus()).toBe(inner);
      inner.remove(); // the button went away (an unmap turned its node into a plain one): the node is the next best place
      expect(result.current.menu?.returnFocus()).toBe(node);
    });

    it("a second open of the same node while its menu stands is ignored, like the keyboard's", () => {
      const { canvas, inner } = setup();
      const { result } = mount(canvas);
      act(() => result.current.openFor("src:1", inner));
      const first = result.current.menu;
      act(() => result.current.openFor("src:1", inner));
      expect(result.current.menu).toBe(first);
    });

    it("a press on the button while ITS menu stands closes it: the click that follows does not open it again", () => {
      const { canvas, inner } = setup();
      const { result } = mount(canvas);
      act(() => result.current.openFor("src:1", inner));
      // What the browser does for the second click: the pointerdown (the menu's own listener closes it), then the click.
      fireEvent.pointerDown(inner);
      act(() => result.current.close());
      act(() => result.current.openFor("src:1", inner));
      expect(result.current.menu).toBeNull();
      // ... and the NEXT click is a plain open again.
      act(() => result.current.openFor("src:1", inner));
      expect(result.current.menu).not.toBeNull();
    });

    it("a press anywhere else is not a toggle: closing by it and then opening the button opens", () => {
      const { canvas, inner, other } = setup();
      const { result } = mount(canvas);
      act(() => result.current.openFor("src:1", inner));
      fireEvent.pointerDown(other);
      act(() => result.current.close());
      act(() => result.current.openFor("src:1", inner));
      expect(result.current.menu).not.toBeNull();
    });

    it("a press on the button that did not become a click (a drag away) does not swallow the next, keyboard, open", () => {
      const { canvas, inner } = setup();
      const { result } = mount(canvas);
      act(() => result.current.openFor("src:1", inner));
      fireEvent.pointerDown(inner);
      act(() => result.current.close());
      fireEvent.keyDown(inner, { key: "Enter" }); // no click came; the person goes on by keyboard
      act(() => result.current.openFor("src:1", inner));
      expect(result.current.menu).not.toBeNull();
    });

    it("a press on a button whose menu is not the one standing (the menu was opened by a right-click) just opens the button's menu", () => {
      const { canvas, inner } = setup();
      const { result } = mount(canvas);
      act(() => result.current.openNode("src:1", click({ clientX: 5, clientY: 6 })));
      fireEvent.pointerDown(inner);
      act(() => result.current.close());
      act(() => result.current.openFor("src:1", inner));
      expect(result.current.menu).toMatchObject({ at: { box: { top: 154 } } });
    });

    it("keeps its identity across renders, like the other openers", () => {
      const { canvas } = setup();
      const { result, rerender } = mount(canvas);
      const before = result.current.openFor;
      rerender({ model: {} });
      expect(result.current.openFor).toBe(before);
    });
  });

  it("a new model closes the menu (it holds callbacks of nodes that may be gone); the same model does not", () => {
    const { canvas } = setup();
    const model = {};
    const { result, rerender } = mount(canvas, model);
    act(() => result.current.openPane(click()));
    rerender({ model });
    expect(result.current.menu).not.toBeNull();
    rerender({ model: {} });
    expect(result.current.menu).toBeNull();
  });

  it("the handlers keep their identity across renders (the page hands them to React Flow)", () => {
    const { canvas } = setup();
    const { result, rerender } = mount(canvas);
    const before = result.current;
    rerender({ model: {} });
    expect(result.current.openNode).toBe(before.openNode);
    expect(result.current.openPane).toBe(before.openPane);
    expect(result.current.openSelection).toBe(before.openSelection);
    expect(result.current.openFromKey).toBe(before.openFromKey);
    expect(result.current.close).toBe(before.close);
  });
});
