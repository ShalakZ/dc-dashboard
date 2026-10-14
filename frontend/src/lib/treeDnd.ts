import type { TreeNode } from "./tree";
import { dragBadge } from "./moveText";
import { ROOT_DROP, dropVerdict, dropZone, indexTree, resolveDrop, toRoots, type DropTarget, type DropZone, type TreeIndex } from "./treeMove";

/**
 * Dragging assets in the Assets Tree (W7p), native HTML5 drag and drop. The browser events come in through a few handlers that the tree puts on
 * its `ul` (one set for every row) and on the filler below the last row. What the person sees while dragging, the drop line, the highlight and
 * the invalid mark, are `data-drop` attributes written straight onto the row, and only when the pair (row, zone) changes: a `dragover` fires
 * every few milliseconds and must cause no React render. React never writes these attributes, so a re-render of the row keeps them.
 */

/** A hover on a folded row's middle opens it after this long (a file manager's spring-loaded folder). */
export const EXPAND_AFTER_MS = 600;

/** What the marker on a row or on the filler says. "first" is the bottom edge of an open row: the first child. */
export type DropMark = DropZone | "invalid";

/** The part of a (React or native) drag event the handlers read. */
export interface DndEvent {
  target: EventTarget | null;
  currentTarget: EventTarget | null;
  relatedTarget?: EventTarget | null;
  clientX?: number;
  clientY: number;
  dataTransfer: DataTransfer | null;
  preventDefault(): void;
}

/** What the tree gives the dragging: always the latest values (read on every event, never captured). */
export interface DndHost {
  /** The whole tree, unfiltered: a filter hides siblings, and "after R" still means after R among all of R's siblings. */
  nodes(): readonly TreeNode[];
  picked(): ReadonlySet<number>;
  /** False when nothing may start moving (no move prop, or the page is busy). */
  canDrag(): boolean;
  drop(ids: number[], target: DropTarget): void | Promise<void>;
  /** The tree's one polite live line. */
  announce(text: string): void;
  /** Open a folded branch. */
  expand(id: number): void;
}

interface Session {
  /** The raw ids: the picked set, or the one row that was dragged. */
  ids: number[];
  nodes: readonly TreeNode[];
  index: TreeIndex;
  /** The roots of `ids` (what actually moves), for `resolveDrop`. */
  moved: Set<number>;
  /** The (row, zone) the markers show now; null before the first dragover and after the pointer left. */
  key: string | null;
  marked: HTMLElement | null;
  ok: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** The element that carries `data-dragging` for the filler's text. */
  scroll: HTMLElement | null;
}

const rowOf = (target: EventTarget | null): HTMLElement | null => (target instanceof Element ? target.closest<HTMLElement>("[data-asset-id]") : null);

/** A row is "open with children" when the list that follows it is shown: its bottom edge then means the first child. */
function hasOpenKids(row: HTMLElement): boolean {
  const list = row.nextElementSibling;
  return list instanceof HTMLUListElement && !list.hidden && list.childElementCount > 0;
}

const isFolded = (row: HTMLElement) => row.querySelector('.twisty[aria-expanded="false"]') !== null;

/**
 * The small image that follows the pointer: the asset's name, or "3 assets". Built as a throw-away element (the browser snapshots it after the
 * dragstart handler returns, so it goes in the next task) and only where `setDragImage` exists (jsdom has none).
 */
function setBadge(dt: DataTransfer, names: readonly string[]) {
  if (typeof dt.setDragImage !== "function") return;
  const badge = document.createElement("div");
  badge.className = "tree-drag-badge";
  badge.textContent = dragBadge(names);
  document.body.appendChild(badge);
  dt.setDragImage(badge, 0, 0);
  setTimeout(() => badge.remove(), 0);
}

export interface TreeDnd {
  dragStart(e: DndEvent): void;
  /** `filler`: the area below the last row (the top level). */
  dragEnter(e: DndEvent, filler?: boolean): void;
  dragOver(e: DndEvent, filler?: boolean): void;
  dragLeave(e: DndEvent): void;
  drop(e: DndEvent, filler?: boolean): void;
  /** Ends a drag in progress without dropping (unmount). */
  cancel(): void;
}

export function createTreeDnd(host: DndHost): TreeDnd {
  let session: Session | null = null;

  const unmark = (s: Session) => {
    if (s.marked) {
      s.marked.removeAttribute("data-drop");
      s.marked.removeAttribute("title");
      s.marked = null;
    }
  };
  const stopTimer = (s: Session) => {
    if (s.timer !== null) clearTimeout(s.timer);
    s.timer = null;
  };
  const forget = (s: Session) => {
    unmark(s);
    stopTimer(s);
    s.key = null;
  };
  const end = () => {
    const s = session;
    if (!s) return;
    forget(s);
    s.scroll?.removeAttribute("data-dragging");
    window.removeEventListener("dragend", end, true);
    session = null;
  };

  /** Where the pointer is: the key of (row, zone), and the place that would give. */
  const aim = (e: DndEvent, s: Session, filler: boolean) => {
    if (filler) return { key: "root", row: null as HTMLElement | null, zone: null as DropZone | null, target: ROOT_DROP as DropTarget | null };
    const row = rowOf(e.target);
    if (!row) return null;
    const box = row.getBoundingClientRect();
    const zone = dropZone(box.top, box.height, e.clientY, hasOpenKids(row));
    const id = Number(row.dataset.assetId);
    return { key: `${id}:${zone}`, row, zone, target: resolveDrop(zone, id, s.moved, s.index) };
  };

  const verdictOf = (s: Session, target: DropTarget | null) =>
    target ? dropVerdict({ ids: s.ids, target, index: s.index }) : ({ ok: false, reason: "That place is no longer there." } as const);

  // A new tree (a refetch mid-drag) needs a new index; the next dragover redraws the marker against it.
  const fresh = (s: Session) => {
    const nodes = host.nodes();
    if (nodes === s.nodes) return;
    s.nodes = nodes;
    s.index = indexTree(nodes);
    s.moved = new Set(toRoots(s.ids, s.index));
    forget(s);
  };

  /** Redraws the marker when (row, zone) changed, and tells the browser what a drop here would do. */
  const update = (e: DndEvent, s: Session, filler: boolean) => {
    fresh(s);
    const at = aim(e, s, filler);
    if (!at) {
      forget(s); // between rows (the indent of a nested list): no place
      return;
    }
    if (at.key !== s.key) {
      forget(s);
      s.key = at.key;
      const verdict = verdictOf(s, at.target);
      s.ok = verdict.ok;
      const el = filler ? (e.currentTarget as HTMLElement) : at.row!;
      if (verdict.ok) {
        el.setAttribute("data-drop", filler ? "inside" : at.zone!);
      } else {
        el.setAttribute("data-drop", "invalid");
        el.setAttribute("title", verdict.reason);
        host.announce(verdict.reason);
      }
      s.marked = el;
      if (verdict.ok && at.zone === "inside" && at.row && isFolded(at.row)) {
        const id = Number(at.row.dataset.assetId);
        s.timer = setTimeout(() => {
          s.timer = null;
          host.expand(id);
        }, EXPAND_AFTER_MS);
      }
    }
    if (e.dataTransfer) e.dataTransfer.dropEffect = s.ok ? "move" : "none";
  };

  return {
    dragStart(e) {
      if (!host.canDrag()) return;
      const row = rowOf(e.target);
      const dt = e.dataTransfer;
      if (!row || !dt) return;
      const id = Number(row.dataset.assetId);
      const picked = host.picked();
      const ids = picked.has(id) ? [...picked] : [id];
      const nodes = host.nodes();
      const index = indexTree(nodes);
      const moved = new Set(toRoots(ids, index));
      if (moved.size === 0) return;
      const names = [...moved].map((root) => index.nameOf(root) ?? "");
      end();
      dt.setData("text/plain", names.join("\n")); // Firefox starts no drag without data; a text field or an editor that takes the drop gets the names
      dt.effectAllowed = "move";
      setBadge(dt, names);
      const scroll = row.closest<HTMLElement>(".tree-scroll");
      scroll?.setAttribute("data-dragging", "");
      session = { ids, nodes, index, moved, key: null, marked: null, ok: false, timer: null, scroll };
      window.addEventListener("dragend", end, true); // the row can be gone by then (a refetch), and a dragend on a removed node never reaches React
    },

    // Enter and over do the same: the browser sends dragover only on the NEXT update after it sent dragenter for a new element (and a real
    // drag repeats it every 50 ms), so the marker is drawn at the enter. Both are cancelled: a dragenter that is not cancelled would send the
    // following dragovers to the body in some browsers, and the invalid marker could then never move on within its row.
    dragEnter(e, filler = false) {
      if (!session) return;
      e.preventDefault();
      update(e, session, filler);
    },

    dragOver(e, filler = false) {
      const s = session;
      if (!s) return; // a drag that is not ours (a file, text): leave it alone
      update(e, s, filler);
      if (s.ok) e.preventDefault(); // accepts the drop; an invalid place is not accepted, so the browser shows its no-drop cursor
    },

    dragLeave(e) {
      const s = session;
      const from = e.currentTarget;
      if (!s || !(from instanceof Element)) return;
      // The browser sends dragenter for the new element BEFORE dragleave for the old one, so a marker that is not inside the element being
      // left (the filler's, when the pointer comes from the rows) belongs to the new element: leave it.
      if (s.marked && !from.contains(s.marked)) return;
      const to = e.relatedTarget;
      if (to instanceof Node && from.contains(to)) return; // only moved to another element inside
      if (!to && e.clientX !== undefined) {
        // No related target (some browsers): the pointer is still inside if its point is.
        const box = from.getBoundingClientRect();
        if (box.width > 0 && e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom) return;
      }
      forget(s);
    },

    drop(e, filler = false) {
      const s = session;
      if (!s) return;
      e.preventDefault(); // Firefox would otherwise navigate to the dragged text
      fresh(s);
      const at = aim(e, s, filler);
      const target = at ? at.target : null;
      const ok = at !== null && verdictOf(s, target).ok;
      const ids = s.ids;
      end();
      if (ok && target) void host.drop(ids, target);
    },

    cancel: end,
  };
}
