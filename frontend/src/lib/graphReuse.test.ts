import type { Edge, Node } from "@xyflow/react";
import { reuseEdges, reuseNodes } from "./graphReuse";

const node = (id: string, extra: Partial<Node> = {}): Node => ({ id, type: "point", position: { x: 10, y: 20 }, data: { label: id, n: 1 }, ...extra });
const edge = (id: string, extra: Partial<Edge> = {}): Edge => ({ id, source: "a", target: "b", style: { strokeDasharray: "6 4" }, ...extra });

describe("reuseNodes", () => {
  it("keeps the old object for an equal node", () => {
    const before = [node("a"), node("b")];
    const out = reuseNodes(before, [node("a"), node("b")]);
    expect(out[0]).toBe(before[0]);
    expect(out[1]).toBe(before[1]);
  });

  it("returns the previous array itself when nothing changed", () => {
    const before = [node("a"), node("b")];
    expect(reuseNodes(before, [node("a"), node("b")])).toBe(before);
    expect(reuseNodes([], [])).toEqual([]);
  });

  it("treats a selected, measured, dragged node as unchanged (React Flow owns those fields)", () => {
    const owned = node("a", { selected: true, dragging: true, measured: { width: 220, height: 64 }, width: 220, height: 64 });
    const before = [owned];
    const out = reuseNodes(before, [node("a")]);
    expect(out).toBe(before);
    expect(out[0]).toBe(owned);
  });

  it.each([
    ["position x", { position: { x: 11, y: 20 } }],
    ["position y", { position: { x: 10, y: 21 } }],
    ["type", { type: "cluster" }],
    ["className", { className: "dim" }],
    ["ariaLabel", { ariaLabel: "A, point" }],
    ["draggable", { draggable: false }],
    ["selectable", { selectable: false }],
    ["focusable", { focusable: false }],
    ["a data value", { data: { label: "a", n: 2 } }],
    ["a data key added", { data: { label: "a", n: 1, extra: true } }],
    ["a data key removed", { data: { label: "a" } }],
  ] as [string, Partial<Node>][])("returns the new object when %s differs", (_name, change) => {
    const before = [node("a")];
    const fresh = node("a", change);
    const out = reuseNodes(before, [fresh]);
    expect(out).not.toBe(before);
    expect(out[0]).toBe(fresh);
  });

  it("compares data by Object.is per value, shallowly", () => {
    const inner = { deep: 1 };
    const fn = () => undefined;
    const before = [node("a", { data: { inner, fn } })];
    expect(reuseNodes(before, [node("a", { data: { inner, fn } })])).toBe(before);
    expect(reuseNodes(before, [node("a", { data: { inner: { deep: 1 }, fn } })])[0]).not.toBe(before[0]);
    expect(reuseNodes(before, [node("a", { data: { inner, fn: () => undefined } })])[0]).not.toBe(before[0]);
  });

  it("carries the old measured size and selection onto a changed node", () => {
    const measured = { width: 220, height: 64 };
    const before = [node("a", { measured, selected: true }), node("b", { measured })];
    const fresh = [node("a", { position: { x: 99, y: 20 } }), node("b", { className: "lit" })];
    const out = reuseNodes(before, fresh);
    expect(out[0]).not.toBe(fresh[0]);
    expect(out[0]).toMatchObject({ id: "a", position: { x: 99, y: 20 }, measured, selected: true });
    expect(out[1]).toMatchObject({ id: "b", className: "lit", measured });
    expect(out[1].selected).toBeUndefined();
  });

  it("gives a changed node with nothing to carry as the new object itself", () => {
    const before = [node("a")];
    const fresh = node("a", { position: { x: 1, y: 1 } });
    expect(reuseNodes(before, [fresh])[0]).toBe(fresh);
  });

  it("uses the build position, not a dragged one", () => {
    const dragged = node("a", { position: { x: 500, y: 500 }, measured: { width: 220, height: 64 } });
    const built = node("a");
    const out = reuseNodes([dragged], [built]);
    expect(out[0].position).toEqual({ x: 10, y: 20 });
    expect(out[0].measured).toEqual({ width: 220, height: 64 });
  });

  it("handles removed and added ids", () => {
    const keep = node("a", { measured: { width: 1, height: 1 } });
    const before = [keep, node("gone")];
    const added = node("new");
    const out = reuseNodes(before, [node("a"), added]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(keep);
    expect(out[1]).toBe(added);
    expect(out).not.toBe(before);
  });

  it("is not the previous array when only the order changed", () => {
    const before = [node("a"), node("b")];
    const out = reuseNodes(before, [node("b"), node("a")]);
    expect(out).not.toBe(before);
    expect(out.map((n) => n.id)).toEqual(["b", "a"]);
    expect(out[0]).toBe(before[1]);
  });

  it("is not the previous array when it is only a prefix of the previous one", () => {
    const before = [node("a"), node("b")];
    const out = reuseNodes(before, [node("a")]);
    expect(out).not.toBe(before);
    expect(out).toHaveLength(1);
  });

  it("does not write to its inputs", () => {
    const before = [node("a", { measured: { width: 1, height: 1 } })];
    const fresh = [node("a", { className: "x" })];
    const beforeCopy = structuredClone(before);
    const freshCopy = structuredClone(fresh);
    reuseNodes(before, fresh);
    expect(before).toEqual(beforeCopy);
    expect(fresh).toEqual(freshCopy);
  });

  it("runs 2,000 nodes well under 50 ms (a loose guard)", () => {
    const make = () => Array.from({ length: 2000 }, (_, i) => node(`n${i}`, { data: { label: `n${i}`, a: 1, b: 2, c: 3 } }));
    const before = make();
    const fresh = make();
    const start = performance.now();
    const out = reuseNodes(before, fresh);
    const took = performance.now() - start;
    expect(out).toBe(before);
    expect(took).toBeLessThan(50);
  });
});

describe("reuseEdges", () => {
  it("keeps the old object for an equal edge and returns the previous array", () => {
    const before = [edge("e1"), edge("e2")];
    const out = reuseEdges(before, [edge("e1"), edge("e2")]);
    expect(out).toBe(before);
    expect(out[0]).toBe(before[0]);
  });

  it.each([
    ["source", { source: "z" }],
    ["target", { target: "z" }],
    ["sourceHandle", { sourceHandle: "h" }],
    ["targetHandle", { targetHandle: "h" }],
    ["label", { label: "3 mapped" }],
    ["animated", { animated: true }],
    ["className", { className: "lit" }],
    ["type", { type: "step" }],
    ["a style value", { style: { strokeDasharray: "none" } }],
    ["a style key added", { style: { strokeDasharray: "6 4", opacity: 0.5 } }],
    ["a style key removed", { style: {} }],
    ["style gone", { style: undefined }],
  ] as [string, Partial<Edge>][])("returns the new object when %s differs", (_name, change) => {
    const before = [edge("e1")];
    const fresh = edge("e1", change);
    const out = reuseEdges(before, [fresh]);
    expect(out).not.toBe(before);
    expect(out[0]).toBe(fresh);
  });

  it("compares style shallowly, not by identity", () => {
    const before = [edge("e1", { style: { strokeDasharray: "6 4", opacity: 1 } })];
    expect(reuseEdges(before, [edge("e1", { style: { strokeDasharray: "6 4", opacity: 1 } })])).toBe(before);
  });

  it("does not look at fields React Flow owns", () => {
    const before = [edge("e1", { selected: true, hidden: false })];
    expect(reuseEdges(before, [edge("e1")])).toBe(before);
  });

  it("handles removed and added ids", () => {
    const keep = edge("e1");
    const before = [keep, edge("gone")];
    const added = edge("new");
    const out = reuseEdges(before, [edge("e1"), added]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(keep);
    expect(out[1]).toBe(added);
    expect(out).not.toBe(before);
  });

  it("runs 2,000 edges well under 50 ms (a loose guard)", () => {
    const make = () => Array.from({ length: 2000 }, (_, i) => edge(`e${i}`, { source: `s${i}`, target: `t${i}` }));
    const before = make();
    const fresh = make();
    const start = performance.now();
    const out = reuseEdges(before, fresh);
    const took = performance.now() - start;
    expect(out).toBe(before);
    expect(took).toBeLessThan(50);
  });
});
