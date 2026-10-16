import type { Node } from "@xyflow/react";
import { createPortal } from "react-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useGraphNav } from "./useGraphNav";

const at = { x: 0, y: 0 };
const nodes: Node[] = [
  { id: "src:1", type: "source", position: at, data: {} },
  { id: "cluster:1:a", type: "cluster", position: at, data: { sourceId: 1 } },
  { id: "point:11", type: "point", position: at, data: { sourceId: 1, clusterKey: "a" } },
  { id: "more:cluster:1:a", type: "more", position: at, data: { clusterId: "cluster:1:a" } },
  { id: "src:2", type: "source", position: at, data: {} },
  { id: "unid:10.0.0.5:502", type: "unidentified", position: at, data: {} },
  { id: "asset:1", type: "asset", position: at, data: { children: 2, navParent: null } },
  { id: "asset:2", type: "asset", position: at, data: { children: 0, navParent: "asset:1" } },
];

const calls = { onToggle: vi.fn(), onMore: vi.fn(), goToNode: vi.fn(), clearSelection: vi.fn() };

/** The canvas wrapper with fake React Flow node wrappers (a button inside the first, the Find card and a portalled menu), as the page renders it. */
function Host({ selected, portal, withNodes = nodes }: { selected?: string; portal?: HTMLElement; withNodes?: readonly Node[] }) {
  const canvas = useRef<HTMLDivElement>(null);
  const { onKeyDownCapture } = useGraphNav({ canvas, nodes: withNodes, ...calls });
  return (
    <div>
      <button type="button">outside</button>
      <div ref={canvas} data-testid="canvas" tabIndex={-1} onKeyDownCapture={onKeyDownCapture}>
        {withNodes.map((node) => (
          <div key={node.id} className={`react-flow__node${node.id === selected ? " selected" : ""}`} data-id={node.id} data-testid={node.id} tabIndex={0}>
            {node.id === "src:1" && <button type="button">inside</button>}
            {node.type === "more" && <button type="button">Show 50 more</button>}
          </div>
        ))}
        <div className="graph-find"><input aria-label="in find" /></div>
        {portal && createPortal(<div className="graph-menu"><button type="button">in menu</button></div>, portal)}
      </div>
    </div>
  );
}

const reached = { down: vi.fn() };
const onDocument = (event: KeyboardEvent) => reached.down(event.key);

beforeEach(() => {
  Object.values(calls).forEach((fn) => fn.mockClear());
  Object.values(reached).forEach((fn) => fn.mockClear());
  document.addEventListener("keydown", onDocument);
});
afterEach(() => document.removeEventListener("keydown", onDocument));

/** Fires a real keydown (so defaultPrevented and the propagation can be read back) and says whether the hook swallowed it. */
function press(el: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

describe("useGraphNav arrows", () => {
  it.each([
    ["ArrowDown", "src:1", "src:2"],
    ["ArrowUp", "src:2", "src:1"],
    ["ArrowRight", "src:1", "cluster:1:a"],
    ["ArrowLeft", "cluster:1:a", "src:1"],
    ["ArrowDown", "point:11", "more:cluster:1:a"],
    ["ArrowRight", "asset:1", "asset:2"],
  ])("%s on %s goes to %s, and React Flow never sees the key", (key, from, to) => {
    render(<Host />);
    const event = press(screen.getByTestId(from), key);
    expect(calls.goToNode).toHaveBeenCalledTimes(1);
    expect(calls.goToNode).toHaveBeenCalledWith(to);
    expect(event.defaultPrevented).toBe(true);
    expect(reached.down).not.toHaveBeenCalled();
  });

  it("an arrow at an end does nothing but is still swallowed (the key was ours)", () => {
    render(<Host />);
    const event = press(screen.getByTestId("src:1"), "ArrowUp");
    expect(calls.goToNode).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(reached.down).not.toHaveBeenCalled();
  });

  it("the arrows on the canvas wrapper itself: Down and Right go to the first node of the discovered column", () => {
    render(<Host />);
    press(screen.getByTestId("canvas"), "ArrowDown");
    press(screen.getByTestId("canvas"), "ArrowRight");
    expect(calls.goToNode).toHaveBeenCalledTimes(2);
    expect(calls.goToNode).toHaveBeenNthCalledWith(1, "src:1");
    expect(calls.goToNode).toHaveBeenNthCalledWith(2, "src:1");
  });

  it("Up and Left on the canvas wrapper are left alone", () => {
    render(<Host />);
    const up = press(screen.getByTestId("canvas"), "ArrowUp");
    const left = press(screen.getByTestId("canvas"), "ArrowLeft");
    expect(calls.goToNode).not.toHaveBeenCalled();
    expect(up.defaultPrevented).toBe(false);
    expect(left.defaultPrevented).toBe(false);
    expect(reached.down).toHaveBeenCalledTimes(2);
  });

  it("the canvas wrapper with no node drawn leaves the arrow alone", () => {
    render(<Host withNodes={[]} />);
    const event = press(screen.getByTestId("canvas"), "ArrowDown");
    expect(calls.goToNode).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("an arrow on a button inside a node is not ours", () => {
    render(<Host />);
    const event = press(screen.getByRole("button", { name: "inside" }), "ArrowDown");
    expect(calls.goToNode).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(reached.down).toHaveBeenCalledWith("ArrowDown");
  });

  it("an arrow inside the Find card is not ours", () => {
    render(<Host />);
    const event = press(screen.getByLabelText("in find"), "ArrowDown");
    expect(calls.goToNode).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("an arrow in a menu portalled out of the canvas is not ours (React delivers it here, the DOM does not)", () => {
    const portal = document.body.appendChild(document.createElement("div"));
    render(<Host portal={portal} />);
    const event = press(screen.getByRole("button", { name: "in menu" }), "ArrowDown");
    expect(calls.goToNode).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    portal.remove();
  });

  it("an arrow on an element outside the canvas is not ours", () => {
    render(<Host />);
    const event = press(screen.getByRole("button", { name: "outside" }), "ArrowDown");
    expect(calls.goToNode).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }],
    ["Alt", { altKey: true }],
  ])("%s held: arrows and Enter are left alone", (_name, mod) => {
    render(<Host />);
    const arrow = press(screen.getByTestId("src:1"), "ArrowDown", mod);
    const enter = press(screen.getByTestId("src:1"), "Enter", mod);
    expect(calls.goToNode).not.toHaveBeenCalled();
    expect(calls.onToggle).not.toHaveBeenCalled();
    expect(arrow.defaultPrevented).toBe(false);
    expect(enter.defaultPrevented).toBe(false);
  });

  it("Shift+arrow is left alone", () => {
    render(<Host />);
    const event = press(screen.getByTestId("src:1"), "ArrowDown", { shiftKey: true });
    expect(calls.goToNode).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("a SELECTED node keeps its arrows for React Flow (it nudges the node 5 px)", () => {
    render(<Host selected="src:1" />);
    const event = press(screen.getByTestId("src:1"), "ArrowDown");
    expect(calls.goToNode).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(reached.down).toHaveBeenCalledWith("ArrowDown");
  });

  it("a selected node still toggles with Enter", () => {
    render(<Host selected="src:1" />);
    press(screen.getByTestId("src:1"), "Enter");
    expect(calls.onToggle).toHaveBeenCalledWith("src:1");
  });

  it("an open modal dialog ignores everything", () => {
    render(<Host />);
    const modal = document.body.appendChild(document.createElement("div"));
    modal.setAttribute("aria-modal", "true");
    const arrow = press(screen.getByTestId("src:1"), "ArrowDown");
    const enter = press(screen.getByTestId("src:1"), "Enter");
    expect(calls.goToNode).not.toHaveBeenCalled();
    expect(calls.onToggle).not.toHaveBeenCalled();
    expect(arrow.defaultPrevented).toBe(false);
    expect(enter.defaultPrevented).toBe(false);
    modal.remove();
  });

  it("a node the list does not know is left alone", () => {
    render(<Host />);
    const stray = document.createElement("div");
    stray.className = "react-flow__node";
    stray.dataset.id = "src:99";
    screen.getByTestId("canvas").appendChild(stray);
    const event = press(stray, "ArrowDown");
    expect(calls.goToNode).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("useGraphNav arrows on the Show more button", () => {
  // The more node's wrapper is not focusable, so the keyboard stands on the button inside it (the page's goToNode focuses it).
  const more = () => screen.getByRole("button", { name: "Show 50 more" });

  it.each([
    ["ArrowUp", "point:11"],
    ["ArrowLeft", "cluster:1:a"],
  ])("%s on the button goes to %s, and React Flow never sees the key", (key, to) => {
    render(<Host />);
    const event = press(more(), key);
    expect(calls.goToNode).toHaveBeenCalledTimes(1);
    expect(calls.goToNode).toHaveBeenCalledWith(to);
    expect(event.defaultPrevented).toBe(true);
    expect(reached.down).not.toHaveBeenCalled();
  });

  it.each(["ArrowDown", "ArrowRight"])("%s on the button has nowhere to go (it is the last child and has none) and is still swallowed", (key) => {
    render(<Host />);
    const event = press(more(), key);
    expect(calls.goToNode).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(reached.down).not.toHaveBeenCalled();
  });

  it.each(["Enter", " "])("%s on the button is the native button's", (key) => {
    render(<Host />);
    const event = press(more(), key);
    expect(calls.goToNode).not.toHaveBeenCalled();
    expect(calls.onToggle).not.toHaveBeenCalled();
    expect(calls.onMore).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(reached.down).toHaveBeenCalledWith(key);
  });

  it("a modifier leaves the arrow alone", () => {
    render(<Host />);
    const event = press(more(), "ArrowUp", { shiftKey: true });
    expect(calls.goToNode).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("the arrows on a button that sits in another kind of node are still not ours", () => {
    render(<Host />);
    const event = press(screen.getByRole("button", { name: "inside" }), "ArrowUp");
    expect(calls.goToNode).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("a more node the list does not know is left alone", () => {
    render(<Host withNodes={nodes.filter((n) => n.type !== "more")} />);
    // the fake DOM draws no button without a node, so make one by hand, inside a wrapper with a more: id
    const wrapper = document.createElement("div");
    wrapper.className = "react-flow__node";
    wrapper.dataset.id = "more:cluster:9:z";
    const button = wrapper.appendChild(document.createElement("button"));
    screen.getByTestId("canvas").appendChild(wrapper);
    const event = press(button, "ArrowUp");
    expect(calls.goToNode).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("useGraphNav Escape", () => {
  it("on a SELECTED node clears the selection, leaves the focus on the node (React Flow would blur it) and React Flow never sees the key", () => {
    render(<Host selected="src:1" />);
    const el = screen.getByTestId("src:1");
    act(() => el.focus());
    const event = press(el, "Escape");
    expect(calls.clearSelection).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(reached.down).not.toHaveBeenCalled();
    expect(el).toHaveFocus();
  });

  it.each(["point:11", "asset:2", "cluster:1:a"])("works on a selected %s too", (id) => {
    render(<Host selected={id} />);
    press(screen.getByTestId(id), "Escape");
    expect(calls.clearSelection).toHaveBeenCalledTimes(1);
  });

  it("on a node that is not selected is left alone", () => {
    render(<Host selected="src:2" />);
    const event = press(screen.getByTestId("src:1"), "Escape");
    expect(calls.clearSelection).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(reached.down).toHaveBeenCalledWith("Escape");
  });

  it("on the canvas wrapper, a button inside a selected node, the Find card, a menu or outside the canvas is left alone", () => {
    const portal = document.body.appendChild(document.createElement("div"));
    render(<Host selected="src:1" portal={portal} />);
    const targets = [
      screen.getByTestId("canvas"), screen.getByRole("button", { name: "inside" }), screen.getByLabelText("in find"),
      screen.getByRole("button", { name: "in menu" }), screen.getByRole("button", { name: "outside" }),
    ];
    for (const target of targets) expect(press(target, "Escape").defaultPrevented).toBe(false);
    expect(calls.clearSelection).not.toHaveBeenCalled();
    portal.remove();
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }],
    ["Alt", { altKey: true }],
    ["Shift", { shiftKey: true }],
  ])("%s held: left alone", (_name, mod) => {
    render(<Host selected="src:1" />);
    const event = press(screen.getByTestId("src:1"), "Escape", mod);
    expect(calls.clearSelection).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("an open modal dialog ignores it", () => {
    render(<Host selected="src:1" />);
    const modal = document.body.appendChild(document.createElement("div"));
    modal.setAttribute("aria-modal", "true");
    const event = press(screen.getByTestId("src:1"), "Escape");
    expect(calls.clearSelection).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    modal.remove();
  });

  it("a selected node the list does not know is left alone", () => {
    render(<Host />);
    const stray = document.createElement("div");
    stray.className = "react-flow__node selected";
    stray.dataset.id = "src:99";
    screen.getByTestId("canvas").appendChild(stray);
    const event = press(stray, "Escape");
    expect(calls.clearSelection).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("Enter on a point is still React Flow's (it selects it), and the Escape after it now clears it", () => {
    render(<Host />);
    const enter = press(screen.getByTestId("point:11"), "Enter");
    expect(enter.defaultPrevented).toBe(false);
    expect(reached.down).toHaveBeenCalledWith("Enter");
    // (React Flow now marks the wrapper `selected`: the Host is told so)
    screen.getByTestId("point:11").classList.add("selected");
    const escape = press(screen.getByTestId("point:11"), "Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(calls.clearSelection).toHaveBeenCalledTimes(1);
  });
});

describe("useGraphNav Enter", () => {
  it.each(["src:1", "cluster:1:a", "asset:1"])("Enter on %s toggles it and React Flow never sees the key (it would select the node)", (id) => {
    render(<Host />);
    const event = press(screen.getByTestId(id), "Enter");
    expect(calls.onToggle).toHaveBeenCalledTimes(1);
    expect(calls.onToggle).toHaveBeenCalledWith(id);
    expect(event.defaultPrevented).toBe(true);
    expect(reached.down).not.toHaveBeenCalled();
  });

  it.each([
    ["a point", "point:11"],
    ["an asset without sub-assets", "asset:2"],
    ["an unidentified service", "unid:10.0.0.5:502"],
    ["the show-more node", "more:cluster:1:a"],
  ])("Enter on %s passes through (React Flow selects it, or the native button presses)", (_name, id) => {
    render(<Host />);
    const event = press(screen.getByTestId(id), "Enter");
    expect(calls.onToggle).not.toHaveBeenCalled();
    expect(calls.onMore).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(reached.down).toHaveBeenCalledWith("Enter");
  });

  it("Enter on a button inside a node is the button's", () => {
    render(<Host />);
    const event = press(screen.getByRole("button", { name: "inside" }), "Enter");
    expect(calls.onToggle).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("Enter on the canvas wrapper does nothing", () => {
    render(<Host />);
    const event = press(screen.getByTestId("canvas"), "Enter");
    expect(calls.onToggle).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("Space is never handled", () => {
    render(<Host />);
    const event = press(screen.getByTestId("src:1"), " ");
    expect(calls.onToggle).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(reached.down).toHaveBeenCalledWith(" ");
  });

  it("works through React's own onKeyDownCapture (fireEvent)", () => {
    render(<Host />);
    fireEvent.keyDown(screen.getByTestId("src:2"), { key: "ArrowUp" });
    expect(calls.goToNode).toHaveBeenCalledWith("src:1");
  });
});
