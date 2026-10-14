import type { Asset } from "../api/types";
import { buildTree, type TreeNode } from "./tree";
import { EXPAND_AFTER_MS, createTreeDnd, type DndEvent, type DndHost } from "./treeDnd";

// The drag logic on a hand-made DOM: Site 1 > Room 2, Yard 3, and the filler under the list. The component tests (AssetTree.test.tsx) drive it
// through React; these are the cases that need a precise event (the pointer's point, what a dragleave names).
const a = (id: number, parent_id: number | null, name: string): Asset => ({ id, parent_id, name, kind: "generic", sort_order: id });
const treeOf = (): TreeNode[] => buildTree([a(1, null, "Site"), a(2, 1, "Room"), a(3, null, "Yard")]);

function dom() {
  document.body.innerHTML = `<div class="tree-scroll"><ul class="tree">
    <li><div data-asset-id="1"><a>Site</a></div><ul><li><div data-asset-id="2"><a>Room</a></div></li></ul></li>
    <li><div data-asset-id="3"><a>Yard</a></div></li></ul><div class="tree-root-drop"></div></div>`;
  const row = (id: number) => document.querySelector<HTMLElement>(`[data-asset-id="${id}"]`)!;
  document.querySelectorAll<HTMLElement>("[data-asset-id]").forEach((el, i) => {
    el.getBoundingClientRect = () => ({ top: i * 32, bottom: i * 32 + 32, height: 32, left: 0, right: 200, width: 200, x: 0, y: i * 32, toJSON: () => ({}) }) as DOMRect;
  });
  return { row, list: document.querySelector<HTMLElement>("ul.tree")!, filler: document.querySelector<HTMLElement>(".tree-root-drop")!, scroll: document.querySelector<HTMLElement>(".tree-scroll")! };
}

function host(over: Partial<DndHost> = {}) {
  let nodes = treeOf();
  const calls = { drop: [] as unknown[], announce: [] as string[], expand: [] as number[] };
  const h: DndHost = {
    nodes: () => nodes,
    picked: () => new Set<number>(),
    canDrag: () => true,
    drop: (ids, target) => { calls.drop.push({ ids, target }); },
    announce: (text) => { calls.announce.push(text); },
    expand: (id) => { calls.expand.push(id); },
    ...over,
  };
  return { h, calls, setNodes: (next: TreeNode[]) => { nodes = next; } };
}

const dtOf = () => ({ dropEffect: "none", effectAllowed: "uninitialized", setData: vi.fn() }) as unknown as DataTransfer;
const ev = (target: Element, over: Partial<DndEvent> = {}): DndEvent & { prevented: boolean } => {
  const e = { target, currentTarget: target, clientY: 16, dataTransfer: dtOf(), prevented: false, preventDefault() { e.prevented = true; }, ...over };
  return e;
};

describe("createTreeDnd", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("starts nothing when the page cannot drag, and nothing is left behind", () => {
    const { row, scroll } = dom();
    const { h } = host({ canDrag: () => false });
    const dnd = createTreeDnd(h);
    const e = ev(row(3));
    dnd.dragStart(e);
    expect(e.dataTransfer!.setData).not.toHaveBeenCalled();
    expect(scroll).not.toHaveAttribute("data-dragging");
    const over = ev(row(1));
    dnd.dragOver(over);
    expect(over.prevented).toBe(false);
  });

  it("an event with no data transfer does not crash", () => {
    const { row } = dom();
    const dnd = createTreeDnd(host().h);
    dnd.dragStart(ev(row(3), { dataTransfer: null }));
    expect(() => dnd.dragOver(ev(row(1), { dataTransfer: null }))).not.toThrow();
  });

  it("enter draws the marker at once (a browser sends the first dragover only on the next update) and cancels the enter", () => {
    const { row } = dom();
    const dnd = createTreeDnd(host().h);
    dnd.dragStart(ev(row(3)));
    const enter = ev(row(2), { clientY: 48 }); // the middle of the second row (rows are 32 px, stacked from 0)
    dnd.dragEnter(enter);
    expect(enter.prevented).toBe(true);
    expect(row(2)).toHaveAttribute("data-drop", "inside");
  });

  it("dragleave keeps a marker that is not inside the element being left (enter comes before leave)", () => {
    const { row, list, filler } = dom();
    const dnd = createTreeDnd(host().h);
    dnd.dragStart(ev(row(2))); // Room, which can go to the top level
    dnd.dragEnter(ev(filler, { currentTarget: filler }), true); // the pointer reached the filler first,
    expect(filler).toHaveAttribute("data-drop", "inside");
    dnd.dragLeave(ev(row(1), { currentTarget: list, relatedTarget: filler })); // and then the list says it was left
    expect(filler).toHaveAttribute("data-drop", "inside");
  });

  it("dragleave to outside the list clears its marker; a null related target counts as outside unless the point is inside the list", () => {
    const { row, list } = dom();
    const dnd = createTreeDnd(host().h);
    dnd.dragStart(ev(row(3)));
    dnd.dragOver(ev(row(2), { clientY: 48 }));
    list.getBoundingClientRect = () => ({ top: 0, bottom: 96, left: 0, right: 200, width: 200, height: 96, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    dnd.dragLeave(ev(row(2), { currentTarget: list, relatedTarget: null, clientX: 100, clientY: 40 })); // still over the list
    expect(row(2)).toHaveAttribute("data-drop", "inside");
    dnd.dragLeave(ev(row(2), { currentTarget: list, relatedTarget: null, clientX: 300, clientY: 40 })); // out of its box
    expect(row(2)).not.toHaveAttribute("data-drop");
  });

  it("a tree that changed mid-drag is indexed again and the marker is judged against it", () => {
    const { row } = dom();
    const { h, setNodes } = host();
    const dnd = createTreeDnd(h);
    dnd.dragStart(ev(row(3))); // Yard
    dnd.dragOver(ev(row(1), { clientY: 16 })); // inside Site: fine
    expect(row(1)).toHaveAttribute("data-drop", "inside");
    setNodes(buildTree([a(1, null, "Site"), a(2, 1, "Room"), a(3, 1, "Yard")])); // Yard now lives inside Site: dropping it there changes nothing
    dnd.dragOver(ev(row(1), { clientY: 16 }));
    expect(row(1)).toHaveAttribute("data-drop", "invalid");
    expect(row(1).title).toBe('"Yard" is already there.');
  });

  it("opens a folded row after EXPAND_AFTER_MS of hovering on its middle", () => {
    const { row } = dom();
    row(1).innerHTML = '<button class="twisty" aria-expanded="false"></button><a>Site</a>';
    vi.useFakeTimers();
    try {
      const { h, calls } = host();
      const dnd = createTreeDnd(h);
      dnd.dragStart(ev(row(3)));
      dnd.dragOver(ev(row(1), { clientY: 16 }));
      vi.advanceTimersByTime(EXPAND_AFTER_MS - 1);
      expect(calls.expand).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(calls.expand).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel (unmount) ends the drag: markers, the dragging state and the timer are gone, and the drop that follows does nothing", () => {
    const { row, scroll } = dom();
    row(1).innerHTML = '<button class="twisty" aria-expanded="false"></button><a>Site</a>';
    vi.useFakeTimers();
    try {
      const { h, calls } = host();
      const dnd = createTreeDnd(h);
      dnd.dragStart(ev(row(3)));
      dnd.dragOver(ev(row(1), { clientY: 16 }));
      dnd.cancel();
      expect(document.querySelector("[data-drop]")).toBeNull();
      expect(scroll).not.toHaveAttribute("data-dragging");
      vi.advanceTimersByTime(EXPAND_AFTER_MS * 2);
      expect(calls.expand).toEqual([]);
      dnd.drop(ev(row(1), { clientY: 16 }));
      expect(calls.drop).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a drop always cancels the browser's own action, and calls the page only for a place that is valid", () => {
    const { row } = dom();
    const { h, calls } = host();
    const dnd = createTreeDnd(h);
    dnd.dragStart(ev(row(3)));
    const bad = ev(row(3), { clientY: 80 }); // onto itself (the third row starts at 64)
    dnd.drop(bad);
    expect(bad.prevented).toBe(true);
    expect(calls.drop).toEqual([]);
    dnd.dragStart(ev(row(3)));
    const good = ev(row(1), { clientY: 16 });
    dnd.drop(good);
    expect(good.prevented).toBe(true);
    expect(calls.drop).toEqual([{ ids: [3], target: { parent_id: 1, before_id: null } }]);
  });
});
