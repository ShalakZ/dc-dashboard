import { act, renderHook } from "@testing-library/react";
import type { Edge, Node } from "@xyflow/react";
import type { FocusEvent as ReactFocusEvent, MouseEvent as ReactMouseEvent } from "react";
import { useGraphHighlight } from "./useGraphHighlight";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const node = (id: string, extra: Partial<Node> = {}): Node => ({ id, position: { x: 0, y: 0 }, data: {}, ...extra });
const edge = (source: string, target: string, extra: Partial<Edge> = {}): Edge => ({ id: `${source}>${target}`, source, target, ...extra });

// source s -> group g -> points p1 and p2; p1 is mapped to asset a, a has a sub-asset; o -> og is another source with a group; lone has no edge.
const NODES = ["s", "g", "p1", "p2", "a", "sub", "o", "og", "lone"].map((id) => node(id));
const EDGES = [edge("s", "g"), edge("g", "p1"), edge("g", "p2"), edge("p1", "a"), edge("a", "sub"), edge("o", "og")];

const PATH_OF_P1 = ["a", "g", "p1", "s", "sub"];
const PATH_EDGES_OF_P1 = ["a>sub", "g>p1", "p1>a", "s>g"];

const mouse = {} as ReactMouseEvent;
const litNodes = (nodes: Node[]) => nodes.filter((n) => n.className?.split(" ").includes("lit")).map((n) => n.id).sort();
const litEdges = (edges: Edge[]) => edges.filter((e) => e.className?.split(" ").includes("lit")).map((e) => e.id).sort();

type Props = { nodes: Node[]; edges: Edge[]; selectedIds: readonly string[]; dragging: boolean };
const BASE: Props = { nodes: NODES, edges: EDGES, selectedIds: [], dragging: false };

function setup(initial: Partial<Props> = {}) {
  const hook = renderHook((props: Props) => useGraphHighlight(props), { initialProps: { ...BASE, ...initial } });
  const handlers = () => hook.result.current.handlers;
  const enter = (id: string) => act(() => { handlers().onNodeMouseEnter(mouse, node(id)); });
  const leave = (id: string) => act(() => { handlers().onNodeMouseLeave(mouse, node(id)); });
  const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  return { ...hook, handlers, enter, leave, wait };
}

// A node element as React Flow draws it, with a button inside; `visible` is what the browser would answer to :focus-visible.
function nodeElement(id: string, visible: boolean) {
  const wrapper = document.createElement("div");
  wrapper.className = "react-flow__node";
  wrapper.setAttribute("data-id", id);
  const button = document.createElement("button");
  wrapper.append(button);
  document.body.append(wrapper);
  vi.spyOn(wrapper, "matches").mockImplementation((selector) => selector === ":focus-visible" && visible);
  vi.spyOn(button, "matches").mockImplementation((selector) => selector === ":focus-visible" && visible);
  return { wrapper, button };
}
const focusEvent = (target: Element, relatedTarget: Element | null = null) => ({ target, relatedTarget }) as unknown as ReactFocusEvent;

describe("useGraphHighlight, hover", () => {
  it("lights nothing before the 120 ms dwell, then exactly the path", () => {
    const { result, enter, wait } = setup();
    enter("p1");
    wait(119);
    expect(result.current.active).toBe(false);
    expect(litNodes(result.current.shownNodes)).toEqual([]);
    wait(1);
    expect(result.current.active).toBe(true);
    expect(litNodes(result.current.shownNodes)).toEqual(PATH_OF_P1);
    expect(litEdges(result.current.shownEdges)).toEqual(PATH_EDGES_OF_P1);
  });

  it("keeps the identity of every node and edge it does not light, and returns the very arrays while idle", () => {
    const { result, enter, wait } = setup();
    expect(result.current.shownNodes).toBe(NODES);
    expect(result.current.shownEdges).toBe(EDGES);
    enter("p1");
    wait(120);
    const lit = new Set(PATH_OF_P1);
    result.current.shownNodes.forEach((n, i) => {
      if (lit.has(n.id)) expect(n).not.toBe(NODES[i]);
      else expect(n).toBe(NODES[i]);
    });
    const litEdge = new Set(PATH_EDGES_OF_P1);
    result.current.shownEdges.forEach((e, i) => {
      if (litEdge.has(e.id)) expect(e).not.toBe(EDGES[i]);
      else expect(e).toBe(EDGES[i]);
    });
  });

  it("does not touch the originals and keeps a class a node already had", () => {
    const nodes = [node("s", { className: "mine" }), node("g", { className: "lit" }), node("x")];
    const edges = [edge("s", "g", { className: "dashed" })];
    const { result, enter, wait } = setup({ nodes, edges });
    enter("s");
    wait(120);
    const [s, g] = result.current.shownNodes;
    expect(s.className).toBe("mine lit");
    expect(g.className).toBe("lit"); // not "lit lit"
    expect(result.current.shownEdges[0].className).toBe("dashed lit");
    expect(nodes[0].className).toBe("mine");
    expect(edges[0].className).toBe("dashed");
  });

  it("a leave alone clears after the 80 ms grace", () => {
    const { result, enter, leave, wait } = setup();
    enter("p1");
    wait(120);
    leave("p1");
    wait(79);
    expect(result.current.active).toBe(true);
    wait(1);
    expect(result.current.active).toBe(false);
    expect(result.current.shownNodes).toBe(NODES);
  });

  it("a leave then an enter within the grace never clears: the old path stays until the new dwell is over", () => {
    const { result, enter, leave, wait } = setup();
    enter("p1");
    wait(120);
    leave("p1");
    wait(60);
    enter("p2");
    expect(result.current.active).toBe(true);
    wait(119); // well past the grace of the first leave, still the first path
    expect(result.current.active).toBe(true);
    expect(litNodes(result.current.shownNodes)).toEqual(PATH_OF_P1);
    wait(1);
    expect(litNodes(result.current.shownNodes)).toEqual(["g", "p2", "s"]);
  });

  it("an enter that is left before its dwell is over starts nothing", () => {
    const { result, enter, leave, wait } = setup();
    enter("p1");
    wait(50);
    leave("p1");
    wait(500);
    expect(result.current.active).toBe(false);
  });

  it("re-entering the lit node during the grace keeps it lit", () => {
    const { result, enter, leave, wait } = setup();
    enter("p1");
    wait(120);
    leave("p1");
    wait(40);
    enter("p1");
    wait(1000);
    expect(litNodes(result.current.shownNodes)).toEqual(PATH_OF_P1);
  });

  it("lights nothing for a node with no edge", () => {
    const { result, enter, wait } = setup();
    enter("lone");
    wait(500);
    expect(result.current.active).toBe(false);
    expect(result.current.shownNodes).toBe(NODES);
  });

  it("lights nothing where the device cannot hover (a tap emulates mouseenter)", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query !== "(hover: hover)", media: query, addEventListener() {}, removeEventListener() {} }));
    const { result, enter, wait } = setup();
    enter("p1");
    wait(500);
    expect(result.current.active).toBe(false);
  });

  it("lights on hover where the device can hover", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(hover: hover)", media: query, addEventListener() {}, removeEventListener() {} }));
    const { result, enter, wait } = setup();
    enter("p1");
    wait(120);
    expect(result.current.active).toBe(true);
  });

  it("lights nothing while a drag runs, and comes back when it ends if the pointer is still there", () => {
    const { result, rerender, enter, wait } = setup();
    enter("p1");
    wait(120);
    rerender({ ...BASE, dragging: true });
    expect(result.current.active).toBe(false);
    expect(result.current.shownNodes).toBe(NODES);
    rerender({ ...BASE, dragging: false });
    expect(litNodes(result.current.shownNodes)).toEqual(PATH_OF_P1);
  });

  it("clears its timers when it unmounts", () => {
    const { enter, leave, unmount } = setup();
    enter("p1");
    leave("p1");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hands out handlers that do not change, so the canvas is not re-rendered for them", () => {
    const { result, rerender, enter, wait } = setup();
    const first = result.current.handlers;
    enter("p1");
    wait(120);
    rerender({ ...BASE, selectedIds: ["p2"] });
    expect(result.current.handlers).toBe(first);
  });

  it("reuses its answer while nothing it reads changed", () => {
    const { result, rerender, enter, wait } = setup();
    enter("p1");
    wait(120);
    const nodes = result.current.shownNodes;
    const edges = result.current.shownEdges;
    rerender({ ...BASE });
    expect(result.current.shownNodes).toBe(nodes);
    expect(result.current.shownEdges).toBe(edges);
  });
});

describe("useGraphHighlight, keyboard focus", () => {
  it("counts a focus that is :focus-visible and lights the path of the node that holds the target", () => {
    const { result, handlers } = setup();
    const { button } = nodeElement("p1", true);
    act(() => { handlers().onFocus(focusEvent(button)); });
    expect(litNodes(result.current.shownNodes)).toEqual(PATH_OF_P1);
    expect(result.current.active).toBe(true);
  });

  it("counts the node element itself", () => {
    const { result, handlers } = setup();
    const { wrapper } = nodeElement("p2", true);
    act(() => { handlers().onFocus(focusEvent(wrapper)); });
    expect(litNodes(result.current.shownNodes)).toEqual(["g", "p2", "s"]);
  });

  it("ignores a focus the pointer caused (not :focus-visible)", () => {
    const { result, handlers } = setup();
    const { button } = nodeElement("p1", false);
    act(() => { handlers().onFocus(focusEvent(button)); });
    expect(result.current.active).toBe(false);
  });

  it("ignores a focus outside any node", () => {
    const { result, handlers } = setup();
    const lone = document.createElement("button");
    document.body.append(lone);
    vi.spyOn(lone, "matches").mockReturnValue(true);
    act(() => { handlers().onFocus(focusEvent(lone)); });
    expect(result.current.active).toBe(false);
  });

  it("treats a browser that cannot answer :focus-visible as no keyboard focus", () => {
    const { result, handlers } = setup();
    const { button } = nodeElement("p1", true);
    vi.spyOn(button, "matches").mockImplementation(() => { throw new SyntaxError("unknown pseudo-class"); });
    act(() => { handlers().onFocus(focusEvent(button)); });
    expect(result.current.active).toBe(false);
  });

  it("clears on blur, but not when the focus only moves inside the same node", () => {
    const { result, handlers } = setup();
    const { wrapper, button } = nodeElement("p1", true);
    act(() => { handlers().onFocus(focusEvent(button)); });
    act(() => { handlers().onBlur(focusEvent(button, wrapper)); }); // to the node element: still inside
    expect(result.current.active).toBe(true);
    act(() => { handlers().onBlur(focusEvent(button, null)); });
    expect(result.current.active).toBe(false);
  });

  it("clears on blur to another node, then lights that one", () => {
    const { result, handlers } = setup();
    const one = nodeElement("p1", true);
    const two = nodeElement("p2", true);
    act(() => { handlers().onFocus(focusEvent(one.button)); });
    act(() => { handlers().onBlur(focusEvent(one.button, two.button)); });
    expect(result.current.active).toBe(false);
    act(() => { handlers().onFocus(focusEvent(two.button)); });
    expect(litNodes(result.current.shownNodes)).toEqual(["g", "p2", "s"]);
  });

  it("is overruled by the hover", () => {
    const { result, handlers, enter, wait } = setup();
    const { button } = nodeElement("p1", true);
    act(() => { handlers().onFocus(focusEvent(button)); });
    enter("p2");
    wait(120);
    expect(litNodes(result.current.shownNodes)).toEqual(["g", "p2", "s"]);
  });

  it("lights nothing while a drag runs", () => {
    const { result, rerender, handlers } = setup();
    const { button } = nodeElement("p1", true);
    act(() => { handlers().onFocus(focusEvent(button)); });
    rerender({ ...BASE, dragging: true });
    expect(result.current.active).toBe(false);
  });
});

describe("useGraphHighlight, selection", () => {
  it("uses the selection when nothing is hovered or focused", () => {
    const { result } = setup({ selectedIds: ["p2"] });
    expect(result.current.active).toBe(true);
    expect(litNodes(result.current.shownNodes)).toEqual(["g", "p2", "s"]);
    expect(litEdges(result.current.shownEdges)).toEqual(["g>p2", "s>g"]);
  });

  it("lights the union of a selection", () => {
    const { result } = setup({ selectedIds: ["p2", "o"] });
    expect(litNodes(result.current.shownNodes)).toEqual(["g", "o", "og", "p2", "s"]);
  });

  it("returns to the selection when the hover is gone", () => {
    const { result, enter, leave, wait } = setup({ selectedIds: ["p2"] });
    enter("o");
    wait(120);
    expect(litNodes(result.current.shownNodes)).toEqual(["o", "og"]);
    leave("o");
    wait(80);
    expect(litNodes(result.current.shownNodes)).toEqual(["g", "p2", "s"]);
  });

  it("lights nothing for a selection over the cap of 20", () => {
    const nodes = Array.from({ length: 25 }, (_v, i) => node(`n${i}`)).concat([node("s")]);
    const edges = Array.from({ length: 25 }, (_v, i) => edge("s", `n${i}`));
    const { result, rerender } = setup({ nodes, edges, selectedIds: nodes.slice(0, 21).map((n) => n.id) });
    expect(result.current.active).toBe(false);
    rerender({ nodes, edges, selectedIds: nodes.slice(0, 20).map((n) => n.id), dragging: false });
    expect(result.current.active).toBe(true);
  });

  it("lights nothing for a selected node with no edge, or one the graph no longer has", () => {
    expect(setup({ selectedIds: ["lone"] }).result.current.active).toBe(false);
    expect(setup({ selectedIds: ["gone"] }).result.current.active).toBe(false);
  });

  it("lights nothing while a drag runs", () => {
    const { result } = setup({ selectedIds: ["p2"], dragging: true });
    expect(result.current.active).toBe(false);
    expect(result.current.shownNodes).toBe(NODES);
  });
});
